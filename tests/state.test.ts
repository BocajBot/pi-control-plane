import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cycleAutonomy,
  cyclePhase,
  defaultState,
  normalizePhase,
  resolveAutonomyInput,
  restoreFromEntries,
  validateState,
  validateTaskBrief,
} from "../src/control-plane/state.ts";
import { directBrief } from "../src/control-plane/interpretation.ts";
import { STATE_ENTRY_TYPE } from "../src/control-plane/types.ts";

test("safe default initialization is Discuss + Read-only with empty task state", () => {
  const state = defaultState();
  assert.equal(state.phase, "discuss");
  assert.equal(state.autonomy, "read-only");
  assert.equal(state.acceptedTask, null);
  assert.equal(state.pendingInterpretation, null);
  assert.equal(state.interpretGuard, null);
  assert.deepEqual(state.sourceToggles, {});
});

test("valid state serializes and restores through JSON round-trip", () => {
  const state = defaultState();
  state.phase = "execute";
  state.autonomy = "restricted";
  state.acceptedTask = directBrief("ship the feature", "2026-07-18T00:00:00.000Z");
  state.sourceToggles["tool:bash"] = false;
  const restored = validateState(JSON.parse(JSON.stringify(state)));
  assert.notEqual(restored, null);
  assert.equal(restored!.phase, "execute");
  assert.equal(restored!.autonomy, "restricted");
  assert.equal(restored!.acceptedTask!.objective, "ship the feature");
  assert.equal(restored!.sourceToggles["tool:bash"], false);
});

test("malformed state is rejected", () => {
  assert.equal(validateState(null), null);
  assert.equal(validateState("nope"), null);
  assert.equal(validateState({}), null);
  assert.equal(validateState({ ...defaultState(), phase: "yolo" }), null);
  assert.equal(validateState({ ...defaultState(), autonomy: "unrestricted" }), null);
  assert.equal(validateState({ ...defaultState(), autonomy: "sandboxed" }), null);
  assert.equal(validateState({ ...defaultState(), sourceToggles: { a: "yes" } }), null);
  assert.equal(validateState({ ...defaultState(), acceptedTask: { id: "x" } }), null);
});

test("unknown schema version is rejected", () => {
  assert.equal(validateState({ ...defaultState(), schemaVersion: 2 }), null);
  assert.equal(validateState({ ...defaultState(), schemaVersion: "1" }), null);
});

test("restoration walks backward, skips malformed entries, survives interleaved entry types", () => {
  const good = defaultState("2026-07-18T01:00:00.000Z");
  good.phase = "plan";
  const entries = [
    { type: "custom", customType: STATE_ENTRY_TYPE, data: good },
    { type: "message" },
    { type: "compaction" }, // compaction entries must not disturb restoration
    { type: "custom", customType: "someone-elses-entry", data: { schemaVersion: 1 } },
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { schemaVersion: 99, phase: "execute" } },
  ];
  const result = restoreFromEntries(entries, STATE_ENTRY_TYPE);
  assert.equal(result.restored, true);
  assert.equal(result.ignoredMalformed, 1);
  assert.equal(result.state.phase, "plan");
});

test("restoration failure falls back to Discuss + Read-only, never Execute/Attended/Restricted", () => {
  const cases = [
    [],
    [{ type: "custom", customType: STATE_ENTRY_TYPE, data: { schemaVersion: 1, phase: "execute", autonomy: "attended" } }], // malformed (missing fields)
    [{ type: "custom", customType: STATE_ENTRY_TYPE, data: "garbage" }],
  ];
  for (const entries of cases) {
    const result = restoreFromEntries(entries as never[], STATE_ENTRY_TYPE);
    assert.equal(result.restored, false);
    assert.equal(result.state.phase, "discuss");
    assert.equal(result.state.autonomy, "read-only");
  }
});

test("an active interpretation guard never survives restoration", () => {
  const persisted = defaultState();
  (persisted as { interpretGuard: unknown }).interpretGuard = {
    active: true,
    savedPhase: "discuss",
    savedAutonomy: "read-only",
    taskRequest: "x",
    startedAt: "t",
  };
  const result = restoreFromEntries(
    [{ type: "custom", customType: STATE_ENTRY_TYPE, data: JSON.parse(JSON.stringify(persisted)) }],
    STATE_ENTRY_TYPE,
  );
  assert.equal(result.restored, true);
  assert.equal(result.state.interpretGuard, null);
});

test("source toggles default to enabled (empty map) and persist through restore", () => {
  const persisted = defaultState();
  persisted.sourceToggles["skill:foo"] = false;
  const result = restoreFromEntries(
    [{ type: "custom", customType: STATE_ENTRY_TYPE, data: JSON.parse(JSON.stringify(persisted)) }],
    STATE_ENTRY_TYPE,
  );
  assert.equal(result.state.sourceToggles["skill:foo"], false);
  assert.equal(result.state.sourceToggles["skill:bar"], undefined); // absent = enabled
});

test("phase normalization handles case and rejects invalid names", () => {
  assert.equal(normalizePhase("Discuss"), "discuss");
  assert.equal(normalizePhase("  EXECUTE "), "execute");
  assert.equal(normalizePhase("planning"), null);
  assert.equal(normalizePhase(""), null);
});

test("autonomy normalization: sandboxed is only an alias for restricted", () => {
  assert.deepEqual(resolveAutonomyInput("Read-Only"), { autonomy: "read-only", sandboxAliasUsed: false });
  assert.deepEqual(resolveAutonomyInput("sandboxed"), { autonomy: "restricted", sandboxAliasUsed: true });
  assert.equal(resolveAutonomyInput("unattended"), null);
  assert.equal(resolveAutonomyInput("yolo"), null);
});

test("cycle orders: discuss->plan->execute->verify->discuss, read-only->attended->restricted->read-only", () => {
  assert.equal(cyclePhase("discuss"), "plan");
  assert.equal(cyclePhase("plan"), "execute");
  assert.equal(cyclePhase("execute"), "verify");
  assert.equal(cyclePhase("verify"), "discuss");
  assert.equal(cycleAutonomy("read-only"), "attended");
  assert.equal(cycleAutonomy("attended"), "restricted");
  assert.equal(cycleAutonomy("restricted"), "read-only");
});

test("task brief validation rejects fabricated shapes", () => {
  assert.equal(validateTaskBrief({ id: "", objective: "x" }), null);
  assert.equal(validateTaskBrief({ ...directBrief("x"), source: "guessed" }), null);
  assert.notEqual(validateTaskBrief(directBrief("x")), null);
});
