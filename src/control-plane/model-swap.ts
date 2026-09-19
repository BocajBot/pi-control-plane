/**
 * Temporary model swap (`/swap <model> until <condition>` / `for <N prompts|
 * minutes>`): the session switches to another model immediately and reverts to
 * the original once a user-defined condition is met.
 *
 * This module is pure: no Pi imports, no filesystem, no network (same layering
 * as sandbox.ts/scratchpad.ts). It owns argument parsing, strict state
 * validation, session-entry restoration, the deterministic condition checks
 * (prompt counts, minute deadlines), the trusted-evaluator prompt/reply
 * contract for free-text conditions, and status rendering. The wiring (command
 * registration, setModel, timers, the evaluator LLM call itself) lives in
 * extensions/control-plane.ts.
 *
 * Trust model: a free-text condition is NEVER judged by the swapped-to model
 * or by anything the working model says. The extension calls the saved global
 * default model (the user's trusted evaluator) with the condition plus
 * ground-truth facts measured by the control plane itself (elapsed time,
 * prompt count, OpenRouter balance now vs. at swap start) and expects exactly
 * MET or NOT MET. Anything else in the reply is rejected, never guessed.
 */

import {
  SWAP_SCHEMA_VERSION,
  type SwapCondition,
  type SwapModelRef,
  type SwapState,
} from "./types.ts";

export const SWAP_EVALUATION_MAX_AGE_SECONDS = 60;

// ---- parsing ----

export type ParsedSwapCommand =
  | { kind: "status" }
  | { kind: "cancel" }
  | {
      kind: "set";
      modelQuery: string;
      condition: { kind: "free-text"; text: string } | { kind: "prompts"; count: number } | { kind: "minutes"; count: number };
    }
  | { kind: "error"; reason: string };

const PROMPTS_RE = /^(\d+)\s*(?:prompt|prompts|turn|turns)$/;
const MINUTES_RE = /^(\d+)\s*(?:minute|minutes|min|m)$/;

/**
 * /swap                -> status
 * /swap status         -> status
 * /swap cancel         -> cancel
 * /swap <model> until <free text>      -> evaluator-judged condition
 * /swap <model> for <N> prompt(s)      -> deterministic prompt count
 * /swap <model> for <N> minute(s)      -> deterministic deadline
 *
 * The model query is everything before the `until` / `for` keyword (the same
 * reference language as /models: exact provider/model wins, then substring).
 */
export function parseSwapCommand(args: string): ParsedSwapCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { kind: "status" };
  const head = trimmed.split(/\s+/)[0]!.toLowerCase();
  if (head === "status") return { kind: "status" };
  if (head === "cancel") return { kind: "cancel" };

  const untilMatch = /(^|\s)until\s+/i.exec(trimmed);
  const forMatch = /(^|\s)for\s+/i.exec(trimmed);
  if (untilMatch === null && forMatch === null) {
    return { kind: "error", reason: 'Missing condition: add "until <description>" or "for <N> prompts/minutes".' };
  }
  const keyword = untilMatch !== null && (forMatch === null || untilMatch.index < forMatch.index) ? "until" : "for";
  const match = keyword === "until" ? untilMatch! : forMatch!;
  const modelQuery = trimmed.slice(0, match.index).trim();
  const rest = trimmed.slice(match.index + match[0]!.length).trim();
  if (modelQuery.length === 0) return { kind: "error", reason: "Missing model: name the model to swap to before the condition." };
  if (rest.length === 0) return { kind: "error", reason: `Empty condition after "${keyword}".` };

  if (keyword === "until") {
    return { kind: "set", modelQuery, condition: { kind: "free-text", text: rest } };
  }

  const prompts = PROMPTS_RE.exec(rest.toLowerCase());
  if (prompts !== null) {
    const count = Number.parseInt(prompts[1]!, 10);
    if (!Number.isInteger(count) || count < 1) return { kind: "error", reason: "Prompt count must be a whole number >= 1." };
    return { kind: "set", modelQuery, condition: { kind: "prompts", count } };
  }
  const minutes = MINUTES_RE.exec(rest.toLowerCase());
  if (minutes !== null) {
    const count = Number.parseInt(minutes[1]!, 10);
    if (!Number.isInteger(count) || count < 1) return { kind: "error", reason: "Minute count must be a whole number >= 1." };
    return { kind: "set", modelQuery, condition: { kind: "minutes", count } };
  }
  return {
    kind: "error",
    reason: `"for" conditions must be "<N> prompts" or "<N> minutes". For anything else, use "until <description>".`,
  };
}

// ---- validation / restoration (same posture as sandbox.ts) ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validModelRef(value: unknown): value is SwapModelRef {
  return isRecord(value) && typeof value.provider === "string" && value.provider.length > 0 &&
    typeof value.id === "string" && value.id.length > 0 &&
    Object.keys(value).every((k) => k === "provider" || k === "id");
}

function validCondition(value: unknown): value is SwapCondition {
  if (!isRecord(value)) return false;
  const { kind } = value as { kind?: unknown };
  if (kind === "free-text") {
    return typeof value.text === "string" && value.text.length > 0 &&
      Object.keys(value).every((k) => k === "kind" || k === "text");
  }
  if (kind === "prompts") {
    return typeof value.remaining === "number" && Number.isInteger(value.remaining) && value.remaining >= 0 &&
      Object.keys(value).every((k) => k === "kind" || k === "remaining");
  }
  if (kind === "minutes") {
    return typeof value.minutes === "number" && Number.isInteger(value.minutes) && value.minutes >= 1 &&
      Object.keys(value).every((k) => k === "kind" || k === "minutes");
  }
  return false;
}

/** Strict validation: anything unexpected -> null -> caller falls back to
 * "no swap" (never guesses). Unknown extra keys are rejected, matching
 * validatePolicy's exact-shape discipline. */
export function validateSwapState(value: unknown): SwapState | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SWAP_SCHEMA_VERSION) return null;
  if (typeof value.updatedAt !== "string" || typeof value.startedAt !== "string") return null;
  if (typeof value.applied !== "boolean") return null;
  if (value.promptsSeen !== undefined && (typeof value.promptsSeen !== "number" || !Number.isInteger(value.promptsSeen) || value.promptsSeen < 0)) return null;
  if (!validModelRef(value.swapModel) || !validModelRef(value.originalModel)) return null;
  if (!validCondition(value.condition)) return null;
  if (value.balanceAtStart !== undefined && value.balanceAtStart !== null &&
    (typeof value.balanceAtStart !== "number" || !Number.isFinite(value.balanceAtStart))) return null;
  const knownKeys = new Set([
    "schemaVersion", "swapModel", "originalModel", "condition", "applied",
    "startedAt", "balanceAtStart", "promptsSeen", "updatedAt",
  ]);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) return null;
  }
  return {
    schemaVersion: SWAP_SCHEMA_VERSION,
    swapModel: value.swapModel,
    originalModel: value.originalModel,
    condition: value.condition,
    applied: value.applied,
    startedAt: value.startedAt,
    balanceAtStart: value.balanceAtStart ?? null,
    promptsSeen: value.promptsSeen ?? 0,
    updatedAt: value.updatedAt,
  };
}

export interface SwapEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Walk-backward-take-first-valid, same as state.ts/sandbox.ts restoration.
 * An inactive (cancelled/reverted) entry is a valid final answer, not a
 * malformed one: it means the swap was deliberately ended. */
export function restoreSwapFromEntries(
  entries: SwapEntryLike[],
  entryType: string,
): { swap: SwapState | null; restored: boolean; ignoredMalformed: number } {
  let ignoredMalformed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== entryType) continue;
    const validated = validateSwapState(entry.data);
    if (validated !== null) {
      return { swap: validated.applied ? validated : null, restored: validated.applied, ignoredMalformed };
    }
    ignoredMalformed++;
  }
  return { swap: null, restored: false, ignoredMalformed };
}

/** Cancelled/reverted tombstone: applied=false, condition stripped to the
 * minimum valid shape so the entry still validates. */
export function inactiveSwapEntry(active: SwapState, now: string): SwapState {
  return { ...active, applied: false, updatedAt: now };
}

// ---- deterministic condition checks ----

// Semantics: for a prompts condition, `condition.remaining` IS the live
// countdown — extensions/control-plane.ts's agent_end handler decrements it
// once per completed user prompt and reverts when it hits zero. `promptsSeen`
// is informational only (evaluator ground truth, status display). These must
// never be combined: subtracting promptsSeen from the already-decremented
// remaining double-counts and fires the condition a prompt early (observed in
// the first live run: a "for 2 prompts" swap reverted after one prompt).
export function promptsRemaining(swap: SwapState): number | null {
  return swap.condition.kind === "prompts" ? Math.max(0, swap.condition.remaining) : null;
}

export function minutesRemaining(swap: SwapState, now: number): number | null {
  if (swap.condition.kind !== "minutes") return null;
  const start = Date.parse(swap.startedAt);
  if (!Number.isFinite(start)) return null;
  const deadline = start + swap.condition.minutes * 60_000;
  return Math.max(0, (deadline - now) / 60_000);
}

export function conditionMet(swap: SwapState, now: number): boolean {
  if (swap.condition.kind === "prompts") return promptsRemaining(swap) === 0;
  if (swap.condition.kind === "minutes") return minutesRemaining(swap, now) === 0;
  return false;
}

// ---- trusted-evaluator contract (free-text conditions) ----

export interface EvaluationFacts {
  /** ISO timestamp the condition was set. */
  startedAt: string;
  /** Whole user prompts completed since the condition was set. */
  promptsSeen: number;
  /** OpenRouter balance (USD) at swap time; null when unknown. */
  balanceAtStart: number | null;
  /** OpenRouter balance (USD) now; null when unknown. */
  balanceNow: number | null;
  /** Latest user message text, truncated; null when unavailable. */
  lastUserMessage: string | null;
}

export function formatEvaluationFacts(facts: EvaluationFacts): string {
  const elapsed = describeElapsed(facts.startedAt);
  const money = (v: number | null) => v === null ? "unknown" : `$${v.toFixed(4)}`;
  const deltaValue = facts.balanceAtStart !== null && facts.balanceNow !== null
    ? facts.balanceNow - facts.balanceAtStart
    : null;
  const delta = deltaValue === null ? "unknown" : `${deltaValue < 0 ? "−" : "+"}$${Math.abs(deltaValue).toFixed(4)}`;
  const lines = [
    `- Condition was set at: ${facts.startedAt} (${elapsed})`,
    `- User prompts completed since it was set: ${facts.promptsSeen}`,
    `- OpenRouter balance when it was set: ${money(facts.balanceAtStart)}`,
    `- OpenRouter balance now: ${money(facts.balanceNow)}`,
    `- Balance change since it was set: ${delta}`,
  ];
  if (facts.lastUserMessage !== null) {
    const clipped = facts.lastUserMessage.length > 500 ? `${facts.lastUserMessage.slice(0, 500)}…` : facts.lastUserMessage;
    lines.push(`- Latest user message: ${clipped.replace(/\s+/g, " ")}`);
  }
  return lines.join("\n");
}

export function buildEvaluationPrompt(conditionText: string, facts: EvaluationFacts): string {
  return [
    "You are a condition evaluator. A condition was described in natural language.",
    "Decide, based ONLY on the facts listed below, whether the condition has been met.",
    "Do not speculate about facts that are listed as unknown; if the condition cannot",
    "be confirmed from the given facts, answer NOT MET.",
    "",
    `Condition: ${conditionText}`,
    "",
    "Facts:",
    formatEvaluationFacts(facts),
    "",
    'Reply with exactly one word: "MET" if the condition has been met, otherwise "NOTMET".',
  ].join("\n");
}

/** Accepts only a clear MET / NOT MET verdict. Anything else -> null (the
 * caller keeps waiting and retries; it never guesses). */
export function parseEvaluationReply(text: string): boolean | null {
  const normalized = text.trim().toUpperCase();
  if (/NOT\s*MET/.test(normalized)) return false;
  if (/\bMET\b/.test(normalized)) return true;
  return null;
}

function describeElapsed(startedAt: string): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "unknown elapsed time";
  const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

// ---- rendering ----

export function describeCondition(condition: SwapCondition, _now: number): string {
  if (condition.kind === "free-text") return `until ${condition.text}`;
  if (condition.kind === "prompts") {
    return `for ${condition.remaining} more prompt${condition.remaining === 1 ? "" : "s"}`;
  }
  return `for ${condition.minutes} minute${condition.minutes === 1 ? "" : "s"}`;
}

export function swapStatusLines(swap: SwapState | null, now: number): string[] {
  if (swap === null) return ["No temporary model swap is active."];
  const key = (m: SwapModelRef) => `${m.provider}/${m.id}`;
  const head = `Swap active: on ${key(swap.swapModel)} (reverts to ${key(swap.originalModel)} when met)`;
  const condition = describeCondition(swap.condition, now);
  const progress: string[] = [];
  if (swap.condition.kind === "prompts") {
    progress.push(`prompts remaining: ${promptsRemaining(swap)}`);
  }
  if (swap.condition.kind === "minutes") {
    const remaining = minutesRemaining(swap, now);
    progress.push(remaining === null ? "deadline unknown (bad startedAt)" : `${remaining.toFixed(1)} min remaining`);
  }
  if (swap.condition.kind === "free-text") {
    progress.push(`judged by the trusted evaluator model after each turn and while idle`);
  }
  progress.push(`prompts seen: ${swap.promptsSeen}`);
  return [head, `Condition: ${condition}`, progress.join(" · ")];
}

/** Short status-line segment, e.g. `⇄ other-model (for 5 prompts)`. */
export function swapStatusSegment(swap: SwapState | null, now: number): string | null {
  if (swap === null) return null;
  return `⇄ ${swap.swapModel.id} (${describeCondition(swap.condition, now)})`;
}
