import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEvaluationPrompt,
  conditionMet,
  describeCondition,
  formatEvaluationFacts,
  inactiveSwapEntry,
  minutesRemaining,
  parseEvaluationReply,
  parseSwapCommand,
  promptsRemaining,
  restoreSwapFromEntries,
  swapStatusLines,
  swapStatusSegment,
  validateSwapState,
} from "../src/control-plane/model-swap.ts";
import {
  SWAP_ENTRY_TYPE,
  SWAP_SCHEMA_VERSION,
  type SwapState,
} from "../src/control-plane/types.ts";

const START = "2026-09-18T12:00:00.000Z";

function validSwap(overrides: Partial<SwapState> = {}): SwapState {
  return {
    schemaVersion: SWAP_SCHEMA_VERSION,
    swapModel: { provider: "anthropic", id: "claude-haiku" },
    originalModel: { provider: "openai", id: "gpt-5" },
    condition: { kind: "prompts", remaining: 5 },
    applied: true,
    startedAt: START,
    balanceAtStart: 20.0,
    promptsSeen: 0,
    updatedAt: START,
    ...overrides,
  };
}

// ---- parseSwapCommand ----

test("parseSwapCommand: empty args and 'status' mean status", () => {
  assert.deepEqual(parseSwapCommand(""), { kind: "status" });
  assert.deepEqual(parseSwapCommand("  status "), { kind: "status" });
});

test("parseSwapCommand: cancel", () => {
  assert.deepEqual(parseSwapCommand("cancel"), { kind: "cancel" });
  assert.deepEqual(parseSwapCommand("  CANCEL"), { kind: "cancel" });
});

test("parseSwapCommand: until takes the rest as free text", () => {
  const parsed = parseSwapCommand("anthropic/claude-haiku until openrouter balance drops by $5");
  assert.deepEqual(parsed, {
    kind: "set",
    modelQuery: "anthropic/claude-haiku",
    condition: { kind: "free-text", text: "openrouter balance drops by $5" },
  });
});

test("parseSwapCommand: model query keeps inner spaces and caps; 'for' inside text stays free", () => {
  // The first keyword wins: "until" appears after "for" here, so "for" wins.
  const parsed = parseSwapCommand("b for my next question mentions deploy");
  assert.equal(parsed.kind, "error"); // "my next question mentions deploy" is not a valid for-condition
  const until = parseSwapCommand("b until for sale items appear in results");
  assert.deepEqual(until, { kind: "set", modelQuery: "b", condition: { kind: "free-text", text: "for sale items appear in results" } });
});

test("parseSwapCommand: for N prompts / minutes", () => {
  assert.deepEqual(parseSwapCommand("local/qwen for 5 prompts"), {
    kind: "set", modelQuery: "local/qwen", condition: { kind: "prompts", count: 5 },
  });
  assert.deepEqual(parseSwapCommand("local/qwen for 1 prompt"), {
    kind: "set", modelQuery: "local/qwen", condition: { kind: "prompts", count: 1 },
  });
  assert.deepEqual(parseSwapCommand("local/qwen for 10 minutes"), {
    kind: "set", modelQuery: "local/qwen", condition: { kind: "minutes", count: 10 },
  });
  assert.deepEqual(parseSwapCommand("local/qwen for 3 min"), {
    kind: "set", modelQuery: "local/qwen", condition: { kind: "minutes", count: 3 },
  });
});

test("parseSwapCommand: rejects missing condition, missing model, empty condition, bad counts", () => {
  assert.equal(parseSwapCommand("just-a-model").kind, "error");
  assert.equal(parseSwapCommand("until something happens").kind, "error");
  assert.equal(parseSwapCommand("b until   ").kind, "error");
  assert.equal(parseSwapCommand("b for 0 prompts").kind, "error");
  assert.equal(parseSwapCommand("b for -1 minutes").kind, "error");
  assert.equal(parseSwapCommand("b for lots of prompts").kind, "error");
});

// ---- validate / restore ----

test("validateSwapState: accepts well-formed, rejects malformed and unknown keys", () => {
  assert.notEqual(validateSwapState(validSwap()), null);
  assert.equal(validateSwapState({ ...validSwap(), schemaVersion: 99 }), null);
  assert.equal(validateSwapState({ ...validSwap(), applied: "yes" }), null);
  assert.equal(validateSwapState({ ...validSwap(), extra: true }), null);
  assert.equal(validateSwapState({ ...validSwap(), swapModel: { provider: "", id: "x" } }), null);
  assert.equal(validateSwapState({ ...validSwap(), condition: { kind: "prompts", remaining: -1 } }), null);
  assert.equal(validateSwapState({ ...validSwap(), condition: { kind: "free-text", text: "" } }), null);
  assert.equal(validateSwapState({ ...validSwap(), condition: { kind: "minutes", minutes: 0 } }), null);
  assert.equal(validateSwapState({ ...validSwap(), promptsSeen: -1 }), null);
  assert.equal(validateSwapState({ ...validSwap(), balanceAtStart: "20" }), null);
  // balanceAtStart absent -> null (unknown), not an error
  const noBalance = validateSwapState({ ...validSwap(), balanceAtStart: undefined });
  assert.equal(noBalance?.balanceAtStart, null);
});

test("restoreSwapFromEntries: walk-backward-take-first-valid, tombstones end the swap", () => {
  const entry = (data: unknown, applied = true) => ({
    type: "custom", customType: SWAP_ENTRY_TYPE, data,
  });
  const active = validSwap();
  const inactive = inactiveSwapEntry(active, "2026-09-18T13:00:00.000Z");

  // Cancelled swap in the newest entry -> no active swap, restored=false.
  const cancelled = restoreSwapFromEntries([entry(active), entry(inactive)], SWAP_ENTRY_TYPE);
  assert.equal(cancelled.swap, null);
  assert.equal(cancelled.restored, false);
  assert.equal(cancelled.ignoredMalformed, 0);

  // Malformed newest entry is skipped; older valid entry restores.
  const recovered = restoreSwapFromEntries([entry(active), entry({ bad: true })], SWAP_ENTRY_TYPE);
  assert.equal(recovered.restored, true);
  assert.equal(recovered.swap?.swapModel.id, "claude-haiku");
  assert.equal(recovered.ignoredMalformed, 1);

  // Non-swap entries are ignored entirely.
  const none = restoreSwapFromEntries([{ type: "custom", customType: "other", data: {} }], SWAP_ENTRY_TYPE);
  assert.equal(none.restored, false);
  assert.equal(none.swap, null);
});

// ---- deterministic conditions ----

test("promptsRemaining and conditionMet count down; floor at zero", () => {
  const swap = validSwap({ condition: { kind: "prompts", remaining: 3 }, promptsSeen: 0 });
  assert.equal(promptsRemaining(swap), 3);
  assert.equal(conditionMet(swap, Date.now()), false);
  // agent_end decrements `remaining` in place; promptsSeen only records history.
  swap.condition.remaining = 2;
  swap.promptsSeen = 1;
  assert.equal(promptsRemaining(swap), 2);
  swap.condition.remaining = 0;
  swap.promptsSeen = 3;
  assert.equal(promptsRemaining(swap), 0);
  assert.equal(conditionMet(swap, Date.now()), true);
});

test("conditionMet: decremented remaining is not double-counted with promptsSeen (live-run regression)", () => {
  // The first live run reverted a "for 2 prompts" swap after ONE prompt:
  // remaining had been decremented to 1 by agent_end while promptsSeen was
  // also 1, and remaining - promptsSeen == 0 falsely read as met. The source
  // of truth is remaining alone.
  const midSwap = validSwap({ condition: { kind: "prompts", remaining: 1 }, promptsSeen: 1 });
  assert.equal(promptsRemaining(midSwap), 1);
  assert.equal(conditionMet(midSwap, Date.now()), false);
});

test("minutesRemaining: deadline arithmetic from startedAt", () => {
  const start = Date.parse(START);
  const swap = validSwap({ condition: { kind: "minutes", minutes: 10 } });
  assert.equal(minutesRemaining(swap, start + 4 * 60_000), 6);
  assert.equal(minutesRemaining(swap, start + 11 * 60_000), 0);
  assert.equal(conditionMet(swap, start + 11 * 60_000), true);
  assert.equal(conditionMet(swap, start), false);
  // Non-deterministic conditions are never met by the local check.
  const free = validSwap({ condition: { kind: "free-text", text: "x" } });
  assert.equal(conditionMet(free, Date.now()), false);
});

test("inactiveSwapEntry keeps identity but flips applied", () => {
  const inactive = inactiveSwapEntry(validSwap(), "2026-09-18T13:00:00.000Z");
  assert.equal(inactive.applied, false);
  assert.equal(inactive.swapModel.id, "claude-haiku");
  assert.equal(validateSwapState(inactive) !== null, true);
});

// ---- trusted-evaluator contract ----

test("buildEvaluationPrompt embeds the condition verbatim and all facts", () => {
  const prompt = buildEvaluationPrompt("openrouter balance drops by $5", {
    startedAt: START,
    promptsSeen: 7,
    balanceAtStart: 20.0,
    balanceNow: 14.5,
    lastUserMessage: "keep going",
  });
  assert.ok(prompt.includes("Condition: openrouter balance drops by $5"));
  assert.ok(prompt.includes("User prompts completed since it was set: 7"));
  assert.ok(prompt.includes("$20.0000"));
  assert.ok(prompt.includes("$14.5000"));
  assert.ok(prompt.includes("−$5.5000"));
  assert.ok(prompt.includes("Latest user message: keep going"));
  assert.ok(prompt.includes("MET"));
});

test("formatEvaluationFacts: unknown balance renders as unknown, never guessed", () => {
  const facts = formatEvaluationFacts({
    startedAt: START, promptsSeen: 0, balanceAtStart: null, balanceNow: null, lastUserMessage: null,
  });
  assert.ok(facts.includes("unknown"));
  assert.ok(!facts.includes("Latest user message"));
});

test("parseEvaluationReply: only clear verdicts are accepted", () => {
  assert.equal(parseEvaluationReply("MET"), true);
  assert.equal(parseEvaluationReply("  met  "), true);
  assert.equal(parseEvaluationReply("NOTMET"), false);
  assert.equal(parseEvaluationReply("not met"), false);
  assert.equal(parseEvaluationReply("The condition is NOT MET yet."), false);
  assert.equal(parseEvaluationReply("The condition is MET."), true);
  // Near-misses that could be misread as MET are rejected, never guessed.
  assert.equal(parseEvaluationReply("UNMET"), null);
  assert.equal(parseEvaluationReply("The balance has dropped halfway."), null);
  assert.equal(parseEvaluationReply(""), null);
});

// ---- rendering ----

test("describeCondition and swapStatusSegment render the three kinds", () => {
  assert.equal(describeCondition({ kind: "free-text", text: "balance drops $5" }, 0), "until balance drops $5");
  assert.equal(describeCondition({ kind: "prompts", remaining: 5 }, 0), "for 5 more prompts");
  assert.equal(describeCondition({ kind: "prompts", remaining: 1 }, 0), "for 1 more prompt");
  assert.equal(describeCondition({ kind: "minutes", minutes: 10 }, 0), "for 10 minutes");
  const seg = swapStatusSegment(validSwap(), Date.now());
  assert.equal(seg, "⇄ claude-haiku (for 5 more prompts)");
  assert.equal(swapStatusSegment(null, Date.now()), null);
});

test("swapStatusLines: idle vs active, including progress for each kind", () => {
  assert.deepEqual(swapStatusLines(null, Date.now()), ["No temporary model swap is active."]);
  const lines = swapStatusLines(validSwap({ condition: { kind: "prompts", remaining: 3 }, promptsSeen: 1 }), Date.now());
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.includes("claude-haiku"));
  assert.ok(lines[0]!.includes("gpt-5"));
  assert.ok(lines[1]!.includes("for 3 more prompts"));
  assert.ok(lines[2]!.includes("prompts remaining: 3"));

  const free = swapStatusLines(validSwap({ condition: { kind: "free-text", text: "user says stop" } }), Date.now());
  assert.ok(free[2]!.includes("trusted evaluator"));

  const timed = swapStatusLines(
    validSwap({ condition: { kind: "minutes", minutes: 10 }, startedAt: new Date(Date.now() - 60_000).toISOString() }),
    Date.now(),
  );
  assert.ok(timed[2]!.includes("min remaining"));
});
