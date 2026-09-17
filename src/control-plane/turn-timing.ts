/**
 * Workload timing: how long the model spends working between prompts.
 *
 * A "turn" spans before_agent_start -> agent_end (model streaming, tool
 * calls, hooks — everything between the user's prompt and the finished
 * reply). Per-turn numbers existed before (TTFT + total, last turn only);
 * this module makes them a durable workload ledger:
 *
 *   - every completed turn is recorded (count, total model time, slowest),
 *   - the last few turns are kept for variance ("recent"),
 *   - the ledger is persisted as its own session entry (TIMING_ENTRY_TYPE)
 *     so a resumed session keeps its totals — a workload spans sessions,
 *   - aggregate + per-turn render in one place, with footer formatting.
 *
 * Same pure-module pattern as scratchpad.ts: validation, restoration from
 * session entries, and rendering here; the entry point only wires events.
 */

export const TIMING_SCHEMA_VERSION = 1;
export const TIMING_ENTRY_TYPE = "pi-control-plane-timing";

/** How many recent turns to keep for the "recent" line (bounded so the
 * persisted entry stays O(1) per turn, not O(n)). */
export const RECENT_CAP = 10;

export interface TurnRecord {
  /** Time to first streamed text, or null when the turn produced none. */
  firstTextMs: number | null;
  /** Full turn duration: before_agent_start -> agent_end. */
  totalMs: number;
  /** ISO timestamp of the turn's end. */
  endedAt: string;
}

export interface TimingState {
  schemaVersion: typeof TIMING_SCHEMA_VERSION;
  /** Total completed turns recorded in this session's ledger. */
  turns: number;
  /** Sum of every turn's totalMs — "time the model spent working". */
  totalMs: number;
  /** The slowest single turn, or null before any turn completed. */
  slowestMs: number | null;
  /** The last RECENT_CAP turn records, oldest first. */
  recent: TurnRecord[];
  updatedAt: string;
}

export function emptyTimingState(now: string = new Date().toISOString()): TimingState {
  return { schemaVersion: TIMING_SCHEMA_VERSION, turns: 0, totalMs: 0, slowestMs: null, recent: [], updatedAt: now };
}

/** Record one completed turn. Pure: returns a new state. */
export function recordTurn(state: TimingState, record: TurnRecord, now: string): TimingState {
  const recent = [...state.recent, record];
  if (recent.length > RECENT_CAP) recent.splice(0, recent.length - RECENT_CAP);
  return {
    schemaVersion: TIMING_SCHEMA_VERSION,
    turns: state.turns + 1,
    totalMs: state.totalMs + record.totalMs,
    slowestMs: Math.max(state.slowestMs ?? 0, record.totalMs),
    recent,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is TurnRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.totalMs !== "number" || record.totalMs < 0) return false;
  if (typeof record.endedAt !== "string") return false;
  return record.firstTextMs === null || typeof record.firstTextMs === "number";
}

/** Strict validation. Anything malformed -> null (ledger starts empty). */
export function validateTimingState(value: unknown): TimingState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== TIMING_SCHEMA_VERSION) return null;
  if (typeof record.turns !== "number" || !Number.isInteger(record.turns) || record.turns < 0) return null;
  if (typeof record.totalMs !== "number" || record.totalMs < 0) return null;
  if (record.slowestMs !== null && typeof record.slowestMs !== "number") return null;
  if (typeof record.updatedAt !== "string") return null;
  if (!Array.isArray(record.recent) || !record.recent.every(isRecord)) return null;
  if (record.recent.length > RECENT_CAP) return null;
  // A turns count below the recent list length is inconsistent (recent is a
  // suffix of all turns); anything above is fine (older turns fell off).
  if (record.turns < record.recent.length) return null;
  return {
    schemaVersion: TIMING_SCHEMA_VERSION,
    turns: record.turns,
    totalMs: record.totalMs,
    slowestMs: record.slowestMs,
    recent: record.recent as TurnRecord[],
    updatedAt: record.updatedAt,
  };
}

/** Minimal structural view of a session entry, matching Pi's CustomEntry. */
export interface CustomEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/**
 * Restore the ledger from session entries (newest-last order, as returned by
 * Pi's sessionManager.getBranch()). Walks backward, takes the first valid
 * timing entry — the ledger is fully accumulated inside each entry, so the
 * newest valid one is the whole story. No valid entry: empty ledger, not an
 * error (a session with no completed turns has nothing to restore).
 */
export function restoreTimingFromEntries(
  entries: CustomEntryLike[],
  entryType: string,
): { timing: TimingState; restored: boolean; ignoredMalformed: number } {
  let ignoredMalformed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== entryType) continue;
    const validated = validateTimingState(entry.data);
    if (validated !== null) {
      return { timing: validated, restored: true, ignoredMalformed };
    }
    ignoredMalformed++;
  }
  return { timing: emptyTimingState(), restored: false, ignoredMalformed };
}

/** "34.2s" / "4m 05s" / "1h 03m 05s" — compact, footer-safe. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = (n: number) => String(n).padStart(2, "0");
  if (h === 0) return `${m}m ${mm(s)}s`;
  return `${h}h ${mm(m)}m ${mm(s)}s`;
}

/** Compact footer segment: "time 4m 05s · 9 turns" ("" before any turn). */
export function timingFooterSegment(state: TimingState): string {
  if (state.turns === 0) return "";
  return `time ${formatDuration(state.totalMs)} · ${state.turns} turn${state.turns === 1 ? "" : "s"}`;
}

/** Full `/control-ui timing` output. */
export function renderTimingSummary(state: TimingState): string[] {
  const lines: string[] = [];
  if (state.turns === 0) {
    lines.push("No completed turns yet in this session.");
    return lines;
  }
  const last = state.recent.at(-1) ?? null;
  if (last !== null) {
    lines.push(
      `Last turn: first text ${last.firstTextMs === null ? "none" : `${(last.firstTextMs / 1000).toFixed(2)}s`} · total ${formatDuration(last.totalMs)} (model, tools and hooks)`,
    );
  }
  const avg = state.totalMs / state.turns;
  lines.push(
    `Workload: ${state.turns} turn${state.turns === 1 ? "" : "s"} · ${formatDuration(state.totalMs)} model time · avg ${formatDuration(avg)}/turn · slowest ${formatDuration(state.slowestMs ?? 0)}`,
  );
  if (state.recent.length > 1) {
    lines.push(`Recent: ${state.recent.map((r) => formatDuration(r.totalMs)).join(", ")}`);
  }
  return lines;
}
