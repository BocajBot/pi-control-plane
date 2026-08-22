/**
 * Pi Harness - session state, checkpoints, and recovery reconciliation
 * (spec sections 18, 25; invariants R1-R5, M2).
 *
 * Pure: takes state in, returns state out. store.ts persists it. That split
 * is what makes the recovery logic below testable - reconciliation is the
 * one part of the harness whose correctness matters most and whose inputs
 * (a stale state file, a truncated audit tail, an environment that moved)
 * are the hardest to produce for real.
 *
 * The rule the recovery path exists to enforce is R4: an operation that was
 * in flight when the process died stays uncertain. There is no code path
 * here that resolves an uncertainty by picking the likely answer. Every
 * reconciliation either finds agreement or reports a conflict for a human.
 */

import {
  HARNESS_SCHEMA_VERSION,
  type ApprovalPolicy,
  type AuditEvent,
  type AutonomyMode,
  type ModelConfiguration,
  type ReasoningMode,
  type ScopeState,
  type SessionIndexEntry,
  type SessionState,
} from "./types.ts";
import { makeId, nowIso, type Clock, type RandomSource } from "./util.ts";

export interface NewSessionOptions {
  projectRoot: string;
  deviceId: string;
  scope: ScopeState;
  reasoningMode: ReasoningMode;
  autonomy: AutonomyMode;
  approvalPolicy: ApprovalPolicy;
  coordinator: ModelConfiguration | null;
  sessionFile?: string | null;
}

export function createSession(
  options: NewSessionOptions,
  clock: Clock = () => new Date(),
  random?: RandomSource,
): SessionState {
  const now = nowIso(clock);
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: makeId("session", random),
    sessionFile: options.sessionFile ?? null,
    projectRoot: options.projectRoot,
    deviceId: options.deviceId,
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    coordinator: options.coordinator,
    reasoningMode: options.reasoningMode,
    autonomy: options.autonomy,
    approvalPolicy: options.approvalPolicy,
    scope: options.scope,
    currentTaskId: null,
    lastVerifiedState: null,
    findings: [],
    assumptions: [],
    unresolvedQuestions: [],
    relevantFiles: [],
    nextAction: null,
    decisionIds: [],
    incidentIds: [],
    checkpointCount: 0,
  };
}

/**
 * The global-index row for a session (spec section 32).
 *
 * Derived from the session state rather than tracked alongside it, so the
 * index can never disagree with the file it points at: every field here is a
 * copy of a field the session already owns, and a stale row is repaired by
 * re-deriving it rather than by editing the index by hand.
 *
 * Only the four fields needed to *find* a session are copied. The index is
 * consulted before the project is known, which means it is the one harness
 * file read outside any project's authority domain; keeping it to a lookup
 * hint is what stops it becoming a second, ambient copy of session state.
 */
export function sessionIndexEntry(state: SessionState): SessionIndexEntry {
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: state.id,
    projectRoot: state.projectRoot,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
  };
}

export type SessionNoteKind =
  | "finding"
  | "assumption"
  | "unresolved"
  | "relevant-file"
  | "next-action";

/**
 * Append a session-level note.
 *
 * The coordinator may write these freely (spec section 10.2) precisely
 * because they are provisional - they never reach long-term memory through
 * this function, and memory.ts refuses to promote them on a coordinator's
 * say-so (M1). Duplicates are dropped so a model that repeats itself across
 * turns does not inflate the recovery file.
 */
export function addNote(
  state: SessionState,
  kind: SessionNoteKind,
  text: string,
  clock: Clock = () => new Date(),
): SessionState {
  const value = text.trim();
  if (value.length === 0) return state;
  const next: SessionState = { ...state, updatedAt: nowIso(clock) };
  switch (kind) {
    case "finding":
      next.findings = dedupeAppend(state.findings, value);
      break;
    case "assumption":
      next.assumptions = dedupeAppend(state.assumptions, value);
      break;
    case "unresolved":
      next.unresolvedQuestions = dedupeAppend(state.unresolvedQuestions, value);
      break;
    case "relevant-file":
      next.relevantFiles = dedupeAppend(state.relevantFiles, value);
      break;
    case "next-action":
      next.nextAction = value;
      break;
  }
  return next;
}

/** Resolve an unresolved question by moving it into findings, so the record
 * shows it was answered rather than that it was never asked. */
export function resolveQuestion(
  state: SessionState,
  question: string,
  answer: string,
  clock: Clock = () => new Date(),
): SessionState {
  if (!state.unresolvedQuestions.includes(question)) return state;
  return {
    ...state,
    unresolvedQuestions: state.unresolvedQuestions.filter((q) => q !== question),
    findings: dedupeAppend(state.findings, `${question} -> ${answer}`),
    updatedAt: nowIso(clock),
  };
}

/**
 * Record a checkpoint.
 *
 * `verifiedState` is separate from any note the model wrote because it means
 * something stronger: it is the last state the harness actually observed to
 * be true, and it is the only thing recovery is permitted to continue from
 * (R3). Passing a model's belief here would defeat the distinction.
 */
export function checkpoint(
  state: SessionState,
  verifiedState: string | null,
  clock: Clock = () => new Date(),
): SessionState {
  return {
    ...state,
    lastVerifiedState: verifiedState ?? state.lastVerifiedState,
    checkpointCount: state.checkpointCount + 1,
    updatedAt: nowIso(clock),
  };
}

export function closeSession(state: SessionState, clock: Clock = () => new Date()): SessionState {
  const now = nowIso(clock);
  return { ...state, endedAt: now, updatedAt: now };
}

/**
 * Record a coordinator change (spec section 25 "model switch").
 *
 * Note what does *not* change: scope, autonomy, approval policy, task. MO3
 * and S5 both say a model switch does not alter authority, and the cleanest
 * way to guarantee that is for the switch function to be unable to express
 * it - so this returns a state with only the coordinator field touched.
 */
export function switchCoordinator(
  state: SessionState,
  incoming: ModelConfiguration,
  clock: Clock = () => new Date(),
): SessionState {
  return { ...state, coordinator: incoming, updatedAt: nowIso(clock) };
}

function dedupeAppend(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value];
}

/* ------------------------------------------------------------------ *
 * Recovery (spec section 25 "crash recovery")
 * ------------------------------------------------------------------ */

export interface RecoveryObservation {
  /** Does the project root still exist and look like the same project? */
  projectRootExists: boolean;
  /** Roots from the persisted scope that no longer resolve. */
  missingScopeRoots: string[];
  /** True when the audit file's last line was incomplete. */
  auditTruncated: boolean;
}

export interface RecoveryReport {
  /** Safe to continue without asking. Only true when nothing conflicts. */
  canContinue: boolean;
  /** State the harness verified, not state it believes. Null when there is
   * nothing verified to continue from. */
  resumeFrom: string | null;
  /** Each entry is a disagreement between records, or between a record and
   * the observed environment. These are surfaced, never resolved here. */
  conflicts: string[];
  /** Operations that may or may not have completed (invariant R4). */
  uncertain: string[];
  /** The last audit event, for the human to read. */
  lastEvent: AuditEvent | null;
}

/**
 * Reconcile persisted state against the observed environment.
 *
 * The precedence rule is R2: observed real state outranks WORKSTATE, and
 * structured state outranks WORKSTATE too. So this function never reads the
 * recovery file - it is handed the structured state and the observation, and
 * a caller consults WORKSTATE only when this returns nothing usable.
 *
 * A truncated audit tail becomes an *uncertainty*, not a conflict: the
 * in-flight operation may have succeeded before the process died. Recording
 * it as a conflict would imply we know it failed, which we do not.
 */
export function reconcile(
  state: SessionState | null,
  observation: RecoveryObservation,
  recentAudit: AuditEvent[],
): RecoveryReport {
  const conflicts: string[] = [];
  const uncertain: string[] = [];
  const lastEvent = recentAudit.length > 0 ? recentAudit[recentAudit.length - 1] : null;

  if (state === null) {
    return {
      canContinue: false,
      resumeFrom: null,
      conflicts: ["no structured session state found"],
      uncertain,
      lastEvent,
    };
  }

  if (!observation.projectRootExists) {
    conflicts.push(`project root no longer exists: ${state.projectRoot}`);
  }
  for (const root of observation.missingScopeRoots) {
    conflicts.push(`scope root no longer resolves: ${root}`);
  }

  if (observation.auditTruncated) {
    uncertain.push(
      "the last audit line is incomplete: the operation it describes may or may not have completed",
    );
  }

  if (state.endedAt === null && lastEvent !== null && lastEvent.eventType !== "session_close") {
    uncertain.push(
      `session was never closed; last recorded event was "${lastEvent.eventType}" at ${lastEvent.timestamp}`,
    );
  }

  if (state.lastVerifiedState === null) {
    conflicts.push("no verified state was ever checkpointed; there is nothing safe to resume from");
  }

  return {
    canContinue: conflicts.length === 0 && state.lastVerifiedState !== null,
    resumeFrom: state.lastVerifiedState,
    conflicts,
    uncertain,
    lastEvent,
  };
}
