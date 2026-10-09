/**
 * Thinking budget (anti-overexpansion): pure logic.
 *
 * Wiring lives in extensions/control-plane.ts (message_start / message_update /
 * agent_end), mirroring how read-before-edit and backup-before-edit split: this
 * module decides, the extension acts.
 *
 * The rule: one assistant message may spend at most THINKING_BUDGET_CHARS of
 * thinking (chars of thinking_delta) for the session's thinking level. Past it,
 * the extension aborts the stream and injects a short fix message — a
 * mid-stream hard stop, because a runaway thought has produced no tool call
 * yet, so the tool_call gate that enforces read-before-edit never sees it.
 *
 * Loop breaker: after a trip, the next COOLDOWN_MESSAGES assistant messages
 * run at COOLDOWN_BUDGET_MULTIPLIER x the budget, so the retry has room and
 * abort -> rethink -> abort cannot spin, but a runaway right after the fix is
 * still cut (live: an uncapped retry ran 10.8k+ chars with no action). A trip
 * inside the cooldown starts a new cooldown.
 */

/** Per-message thinking budget in chars by thinking level. null = unlimited. */
export const THINKING_BUDGET_CHARS: Readonly<Record<string, number | null>> = {
  off: null,
  minimal: 1000,
  low: 2000,
  medium: 4000,
  high: 6000,
  xhigh: 8000,
  max: 16000,
};

/** Assistant messages on the raised budget after a trip. */
export const COOLDOWN_MESSAGES = 2;
export const COOLDOWN_BUDGET_MULTIPLIER = 2;

export interface ThinkingBudgetState {
  /** Thinking chars streamed in the current assistant message. */
  chars: number;
  /** Already tripped in this message (deltas keep arriving until abort lands). */
  tripped: boolean;
  /** Current message is in cooldown after a trip (raised budget). */
  exempt: boolean;
  /** Messages still exempt after the current one. */
  cooldown: number;
}

export function initialThinkingState(): ThinkingBudgetState {
  return { chars: 0, tripped: false, exempt: false, cooldown: 0 };
}

export function thinkingBudgetFor(level: string | undefined): number | null {
  if (level === undefined) return null;
  return THINKING_BUDGET_CHARS[level] ?? null;
}

/** A new assistant message starts: reset the count, spend one cooldown slot. */
export function onAssistantMessageStart(s: ThinkingBudgetState): ThinkingBudgetState {
  return { chars: 0, tripped: false, exempt: s.cooldown > 0, cooldown: Math.max(0, s.cooldown - 1) };
}

export interface ThinkingVerdict {
  state: ThinkingBudgetState;
  /** True exactly once per message: the delta that crossed the limit. */
  exceeded: boolean;
  /** Limit in force for this message (budget, raised in cooldown); null = unlimited. */
  limit: number | null;
}

export function recordThinking(s: ThinkingBudgetState, deltaChars: number, budget: number | null): ThinkingVerdict {
  const chars = s.chars + deltaChars;
  const limit = budget === null ? null : s.exempt ? budget * COOLDOWN_BUDGET_MULTIPLIER : budget;
  if (limit === null || s.tripped || chars <= limit) {
    return { state: { ...s, chars }, exceeded: false, limit };
  }
  return { state: { ...s, chars, tripped: true, cooldown: COOLDOWN_MESSAGES }, exceeded: true, limit };
}

/** Kept short on purpose: long how-to-reason text makes this model think more. */
export function overexpansionFix(chars: number, budget: number, level: string): string {
  return (
    `[control plane] Blocked: thinking passed ${budget} chars (${level}) with no action; ` +
    `stream aborted at ${chars}. Rule: thinking-budget. Do not restate the analysis. ` +
    "Fix: state ONE hypothesis in one line, then run the smallest command, edit, or test that checks it."
  );
}
