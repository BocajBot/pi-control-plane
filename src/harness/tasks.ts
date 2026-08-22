/**
 * Pi Harness - the explicit task queue (spec section 14; invariants T1-T4).
 *
 * Pure: builds and transitions records; store.ts persists the array.
 *
 * T1 is the load-bearing rule and it is enforced by omission: there is no
 * function here that infers a task from conversation. The only way a task
 * exists is `createTask()`, called from an explicit `/harness task` command
 * or an explicit tool call. A passing remark cannot become an obligation,
 * because nothing is listening for one.
 *
 * T2 is enforced by copying the scope object into the record at creation.
 * The task's envelope is a snapshot, so widening the session scope later
 * does not retroactively widen a queued task that was created under the
 * narrower one.
 *
 * T4 is enforced by keeping `status: "done"` and `validatedAt` as separate
 * fields. Marking a task done is a claim; setting `validatedAt` requires a
 * verification pass to have actually measured the claimed property.
 */

import {
  HARNESS_SCHEMA_VERSION,
  type Actor,
  type ApprovalPolicy,
  type AutonomyMode,
  type ScopeState,
  type TaskRecord,
  type TaskStatus,
} from "./types.ts";
import { makeId, nowIso, type Clock, type RandomSource } from "./util.ts";

export interface TaskDraft {
  objective: string;
  project: string;
  scope: ScopeState;
  autonomy: AutonomyMode;
  approvalPolicy: ApprovalPolicy;
  executionConditions?: string[];
  createdBy: Actor;
  originSession: string;
}

export function createTask(
  draft: TaskDraft,
  clock: Clock = () => new Date(),
  random?: RandomSource,
): TaskRecord {
  const now = nowIso(clock);
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: makeId("task", random),
    objective: draft.objective.trim(),
    status: "queued",
    project: draft.project,
    // Frozen copy, not a reference (T2).
    scope: { ...draft.scope, allowedRoots: [...draft.scope.allowedRoots] },
    autonomy: draft.autonomy,
    approvalPolicy: draft.approvalPolicy,
    executionConditions: draft.executionConditions ?? [],
    createdAt: now,
    updatedAt: now,
    createdBy: draft.createdBy,
    originSession: draft.originSession,
    validatedAt: null,
  };
}

/**
 * Legal status transitions.
 *
 * "done" and "abandoned" are terminal. Reopening finished work creates a new
 * task rather than resurrecting the old one, for the same reason reopening a
 * durable decision creates a new record (D4): the history of what was
 * believed finished is itself worth keeping.
 */
const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set<TaskStatus>(["active", "abandoned", "blocked"]),
  active: new Set<TaskStatus>(["blocked", "awaiting-approval", "done", "abandoned"]),
  blocked: new Set<TaskStatus>(["active", "abandoned"]),
  "awaiting-approval": new Set<TaskStatus>(["active", "blocked", "abandoned"]),
  done: new Set<TaskStatus>([]),
  abandoned: new Set<TaskStatus>([]),
};

export type TransitionOutcome =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: string };

export function transition(
  task: TaskRecord,
  next: TaskStatus,
  clock: Clock = () => new Date(),
): TransitionOutcome {
  if (task.status === next) return { ok: true, task };
  if (!TRANSITIONS[task.status].has(next)) {
    return { ok: false, reason: `cannot move task from "${task.status}" to "${next}"` };
  }
  return { ok: true, task: { ...task, status: next, updatedAt: nowIso(clock) } };
}

/**
 * Mark a task validated.
 *
 * Deliberately refuses when `evidence` is empty. "Validated" with no
 * evidence is just "done" spelled more confidently, and T4 exists to keep
 * those two apart.
 */
export function markValidated(
  task: TaskRecord,
  evidence: string,
  clock: Clock = () => new Date(),
): TransitionOutcome {
  if (evidence.trim().length === 0) {
    return { ok: false, reason: "validation requires evidence of the property that was measured" };
  }
  if (task.status !== "done") {
    return { ok: false, reason: `task is "${task.status}"; validate it after it is claimed done` };
  }
  return { ok: true, task: { ...task, validatedAt: nowIso(clock), updatedAt: nowIso(clock) } };
}

export function upsert(tasks: TaskRecord[], task: TaskRecord): TaskRecord[] {
  const index = tasks.findIndex((existing) => existing.id === task.id);
  if (index === -1) return [...tasks, task];
  const next = [...tasks];
  next[index] = task;
  return next;
}

export function findTask(tasks: TaskRecord[], id: string): TaskRecord | null {
  return tasks.find((task) => task.id === id) ?? null;
}

/** Queued tasks for one project, oldest first. Scoped by project because a
 * task's authority envelope is project-bound (spec section 13). */
export function queuedFor(tasks: TaskRecord[], project: string): TaskRecord[] {
  return tasks
    .filter((task) => task.project === project && task.status === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function formatTask(task: TaskRecord): string {
  const validated = task.validatedAt ? " validated" : task.status === "done" ? " (claimed, unvalidated)" : "";
  return `${task.id} [${task.status}${validated}] ${task.objective}`;
}
