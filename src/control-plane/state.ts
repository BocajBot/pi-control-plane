/**
 * Control-plane state: safe defaults, normalization, cycling, validation,
 * and restoration from persisted session entries.
 *
 * Posture defaults:
 * - A TRULY FRESH session (no prior control-plane state at all) opens
 *   in Auto: Execute + Unattended, without confirmations. See freshState().
 * - defaultState() stays the fail-closed safe fallback: Discuss + Read-only.
 *   It is used whenever prior state EXISTED but could not be trusted, so a
 *   corrupted session never silently gains edit power.
 * - Restoration of malformed/unknown state yields defaultState() (read-only),
 *   never Execute and never an autonomy above Read-only.
 */

import {
  AUTONOMY_LEVELS,
  type Autonomy,
  type ControlPlaneState,
  type ContextSnapshot,
  type Phase,
  PHASES,
  SNAPSHOT_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
} from "./types.ts";

export function defaultState(now: string = new Date().toISOString()): ControlPlaneState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    phase: "discuss",
    autonomy: "read-only",
    previousContextSnapshot: null,
    sourceToggles: {},
    updatedAt: now,
  };
}

/**
 * The posture a genuinely fresh session opens in: Auto (Execute + Unattended).
 * Tool calls run without confirmation, subject to Auto's policy guards.
 * This is deliberately NOT defaultState(): defaultState stays the read-only
 * fallback for untrusted/corrupted restores, so only a clean fresh start is
 * edit-ready.
 */
export function freshState(now: string = new Date().toISOString()): ControlPlaneState {
  return { ...defaultState(now), phase: "execute", autonomy: "unattended" };
}

/** Normalize a phase name. Returns null for anything unrecognized. */
export function normalizePhase(input: string): Phase | null {
  const value = input.trim().toLowerCase();
  return (PHASES as readonly string[]).includes(value) ? (value as Phase) : null;
}

export interface AutonomyResolution {
  autonomy: Autonomy;
  /** True when the "sandboxed" alias was used and a warning must be shown. */
  sandboxAliasUsed: boolean;
}

/** Normalize an autonomy name, accepting "sandboxed" only as an alias for "restricted". */
export function resolveAutonomyInput(input: string): AutonomyResolution | null {
  const value = input.trim().toLowerCase();
  if (value === "sandboxed") {
    return { autonomy: "restricted", sandboxAliasUsed: true };
  }
  if ((AUTONOMY_LEVELS as readonly string[]).includes(value)) {
    return { autonomy: value as Autonomy, sandboxAliasUsed: false };
  }
  return null;
}

export function cyclePhase(current: Phase): Phase {
  const index = PHASES.indexOf(current);
  return PHASES[(index + 1) % PHASES.length];
}

export function cycleAutonomy(current: Autonomy): Autonomy {
  const index = AUTONOMY_LEVELS.indexOf(current);
  return AUTONOMY_LEVELS[(index + 1) % AUTONOMY_LEVELS.length];
}

/**
 * The user-facing merged setting. Internally phase and autonomy stay separate
 * (enforcement precedence is unchanged); these four labels select the only
 * combinations Pi exposes:
 *   plan   -> read-only (talk/plan; every mutating tool blocked, reads allowed)
 *   manual -> execute + attended (changes allowed, risky operations confirm)
 *   accept -> execute + auto (in-root edits apply silently; everything else confirms)
 *   auto   -> execute + unattended (full autonomy, policy-enforced by
 *             tool-policy.ts, not here). It is deliberately last in the
 *             cycle so alt+p / /mode reaches it only after the other modes,
 *             never as an accidental single step from read-only Plan.
 */
export const MODES = ["plan", "manual", "accept", "auto"] as const;
export type Mode = (typeof MODES)[number];

export function stateForMode(mode: Mode): { phase: Phase; autonomy: Autonomy } {
  switch (mode) {
    case "plan":
      return { phase: "plan", autonomy: "read-only" };
    case "manual":
      return { phase: "execute", autonomy: "attended" };
    case "accept":
      return { phase: "execute", autonomy: "auto" };
    case "auto":
      return { phase: "execute", autonomy: "unattended" };
  }
}

/** The mode a phase/autonomy pair corresponds to, or null for combos with no
 * mode (execute+restricted, execute+read-only). Any read-only phase maps to
 * Plan, the sole read-only mode. */
export function modeOf(phase: Phase, autonomy: Autonomy): Mode | null {
  if (phase === "execute") {
    if (autonomy === "attended") return "manual";
    if (autonomy === "auto") return "accept";
    if (autonomy === "unattended") return "auto";
    return null;
  }
  return autonomy === "read-only" ? "plan" : null;
}

/**
 * Coerce any phase/autonomy combo to a mode WITHOUT escalating permissions.
 * Anything that has no direct mode - execute+restricted, execute+read-only, or
 * a non-execute phase carrying elevated autonomy (from a session saved before
 * the modes were reduced) - falls back to the safe read-only Plan; the coercion
 * never grants edit power the raw pair lacked.
 */
export function coerceToMode(phase: Phase, autonomy: Autonomy): Mode {
  return modeOf(phase, autonomy) ?? "plan";
}

export function cycleMode(current: Mode): Mode {
  const index = MODES.indexOf(current);
  return MODES[(index + 1) % MODES.length];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSnapshot(value: unknown): ContextSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
  if (!isString(value.timestamp)) return null;
  if (!Array.isArray(value.sources) || !Array.isArray(value.tools)) return null;
  const phase = isString(value.phase) ? normalizePhase(value.phase) : null;
  if (phase === null) return null;
  const autonomy = isString(value.autonomy) ? resolveAutonomyInput(value.autonomy) : null;
  if (autonomy === null || autonomy.sandboxAliasUsed) return null;
  // Structural check is intentionally shallow beyond this point; snapshots are
  // display/diff data, not authorization data.
  return value as unknown as ContextSnapshot;
}

/**
 * Validate a persisted state object. Returns null when anything is malformed
 * or the schema version is unknown. Never repairs partially valid state.
 */
export function validateState(value: unknown): ControlPlaneState | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) return null;
  const phase = isString(value.phase) ? normalizePhase(value.phase) : null;
  if (phase === null) return null;
  // "sandboxed" must never appear in persisted state.
  if (!isString(value.autonomy)) return null;
  if (!(AUTONOMY_LEVELS as readonly string[]).includes(value.autonomy)) return null;
  const autonomy = value.autonomy as Autonomy;
  if (!isString(value.updatedAt)) return null;

  const snapshot =
    value.previousContextSnapshot === null ? null : validateSnapshot(value.previousContextSnapshot);
  if (value.previousContextSnapshot !== null && snapshot === null) return null;

  if (!isRecord(value.sourceToggles)) return null;
  const sourceToggles: Record<string, boolean> = {};
  for (const [key, toggled] of Object.entries(value.sourceToggles)) {
    if (typeof toggled !== "boolean") return null;
    sourceToggles[key] = toggled;
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    phase,
    autonomy,
    previousContextSnapshot: snapshot,
    sourceToggles,
    updatedAt: value.updatedAt,
  };
}

/** Minimal structural view of a session entry, matching Pi's CustomEntry. */
export interface CustomEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/**
 * Restore state from session entries (newest-last order, as returned by
 * Pi's sessionManager.getBranch()). Walks backward, takes the first valid
 * state entry, ignores malformed ones, and falls back to safe defaults.
 */
export function restoreFromEntries(
  entries: CustomEntryLike[],
  stateEntryType: string,
  now: string = new Date().toISOString(),
): { state: ControlPlaneState; restored: boolean; ignoredMalformed: number } {
  let ignoredMalformed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== stateEntryType) continue;
    const validated = validateState(entry.data);
    if (validated !== null) {
      return { state: sanitizeRestoredState(validated), restored: true, ignoredMalformed };
    }
    ignoredMalformed++;
  }
  // No trusted prior state. Distinguish a truly fresh session (nothing was
  // ever persisted) from a corrupted one (entries existed but were malformed):
  // the former opens in Auto, the latter falls back to the safe read-only
  // default so corruption never silently escalates authority.
  const state = ignoredMalformed === 0 ? freshState(now) : defaultState(now);
  return { state, restored: false, ignoredMalformed };
}

/** Legacy phase/autonomy combos are coerced to a mode without escalation. */
export function sanitizeRestoredState(state: ControlPlaneState): ControlPlaneState {
  const { phase, autonomy } = stateForMode(coerceToMode(state.phase, state.autonomy));
  return { ...state, phase, autonomy };
}
