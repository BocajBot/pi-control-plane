/**
 * Control-plane state: safe defaults, normalization, cycling, validation,
 * and restoration from persisted session entries.
 *
 * Fail-closed rules enforced here:
 * - Defaults are always Discuss + Read-only.
 * - Restoration failure of any kind yields the defaults, never Execute and
 *   never an autonomy above Read-only.
 * - A restored interpretation guard is always cleared (the interpretation
 *   turn cannot survive a session restart).
 */

import {
  AUTONOMY_LEVELS,
  type Autonomy,
  type ControlPlaneState,
  type ContextSnapshot,
  type PendingInterpretation,
  type Phase,
  PHASES,
  SNAPSHOT_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  type TaskBrief,
} from "./types.ts";

export function defaultState(now: string = new Date().toISOString()): ControlPlaneState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    phase: "discuss",
    autonomy: "read-only",
    acceptedTask: null,
    pendingInterpretation: null,
    previousContextSnapshot: null,
    sourceToggles: {},
    interpretGuard: null,
    updatedAt: now,
  };
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

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateTaskBrief(value: unknown): TaskBrief | null {
  if (!isRecord(value)) return null;
  const listFields = [
    "deliverables",
    "includedScope",
    "excludedScope",
    "constraints",
    "assumptions",
    "unknowns",
    "completionCriteria",
    "approvalBoundaries",
  ] as const;
  if (!isString(value.id) || value.id.length === 0) return null;
  if (!isString(value.objective)) return null;
  if (!isString(value.sourceRequest)) return null;
  if (value.source !== "direct" && value.source !== "interpretation") return null;
  if (!isString(value.createdAt) || !isString(value.updatedAt)) return null;
  for (const field of listFields) {
    if (!isStringArray(value[field])) return null;
  }
  return {
    id: value.id,
    objective: value.objective,
    deliverables: value.deliverables as string[],
    includedScope: value.includedScope as string[],
    excludedScope: value.excludedScope as string[],
    constraints: value.constraints as string[],
    assumptions: value.assumptions as string[],
    unknowns: value.unknowns as string[],
    completionCriteria: value.completionCriteria as string[],
    approvalBoundaries: value.approvalBoundaries as string[],
    sourceRequest: value.sourceRequest,
    source: value.source,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function validatePendingInterpretation(value: unknown): PendingInterpretation | null {
  if (!isRecord(value)) return null;
  if (!isString(value.raw)) return null;
  if (typeof value.valid !== "boolean") return null;
  if (!isStringArray(value.missingSections)) return null;
  if (!isString(value.createdAt)) return null;
  const brief = value.brief === null ? null : validateTaskBrief(value.brief);
  if (value.brief !== null && brief === null) return null;
  return {
    raw: value.raw,
    brief,
    valid: value.valid,
    missingSections: value.missingSections as string[],
    createdAt: value.createdAt,
  };
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

  const acceptedTask = value.acceptedTask === null ? null : validateTaskBrief(value.acceptedTask);
  if (value.acceptedTask !== null && acceptedTask === null) return null;

  const pending =
    value.pendingInterpretation === null
      ? null
      : validatePendingInterpretation(value.pendingInterpretation);
  if (value.pendingInterpretation !== null && pending === null) return null;

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
    acceptedTask,
    pendingInterpretation: pending,
    previousContextSnapshot: snapshot,
    sourceToggles,
    // Guard state is validated structurally but always cleared on restore by
    // sanitizeRestoredState(); carry it through untouched here.
    interpretGuard: null,
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
  return { state: defaultState(now), restored: false, ignoredMalformed };
}

/** A restored session must never resume with an active interpretation guard. */
export function sanitizeRestoredState(state: ControlPlaneState): ControlPlaneState {
  return { ...state, interpretGuard: null };
}
