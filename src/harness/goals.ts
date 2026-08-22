/**
 * Pi Harness - goals above tasks, and relationships between projects
 * (spec section 13).
 *
 * Pure. store.ts persists both record kinds.
 *
 * Section 13 states two limits, and both are enforced by what this module
 * does *not* expose rather than by a check someone has to remember:
 *
 * 1. "Higher-level goals may influence recommendations and expose conflicts,
 *    but they do not silently override explicit current user instructions."
 *    Nothing here returns an allow/deny verdict, and `AuthorizationRequest`
 *    (policy.ts) has no field a goal could be passed through. The strongest
 *    thing a goal can do is put a sentence in front of the user. A goal that
 *    could block a tool call would be a policy, and the user did not write it
 *    as one.
 *
 * 2. "Project relationships do not automatically create authority across
 *    project boundaries." `ProjectLink` carries no roots, no scope, and no
 *    capabilities - there is nothing on the record for an authorization path
 *    to read even by accident. Linking two projects tells you they are
 *    related; getting at the other one still needs a scope grant.
 *
 * Conflict detection is deliberately dumb: substring matching against
 * phrases the user wrote on the goal itself. Inferring tension from a goal's
 * prose would produce confident nonsense, and a surfaced conflict is only
 * worth surfacing if the user can see why it fired.
 */

import {
  GOAL_HORIZONS,
  HARNESS_SCHEMA_VERSION,
  PROJECT_LINK_KINDS,
  type Actor,
  type GoalHorizon,
  type GoalRecord,
  type GoalStatus,
  type ProjectLink,
  type ProjectLinkKind,
} from "./types.ts";
import { makeId, nowIso, type Clock, type RandomSource } from "./util.ts";

export interface GoalDraft {
  statement: string;
  horizon: GoalHorizon;
  /** 1 (highest) to 5. Defaults to 3. */
  priority?: number;
  /** Empty means the goal applies to every project. */
  projects?: string[];
  conflictsWith?: string[];
  createdBy: Actor;
}

export type GoalOutcome = { ok: true; goal: GoalRecord } | { ok: false; reason: string };

export function makeGoal(
  draft: GoalDraft,
  clock: Clock = () => new Date(),
  random?: RandomSource,
): GoalOutcome {
  const statement = draft.statement.trim();
  if (statement.length === 0) return { ok: false, reason: "a goal needs a statement" };
  if (!GOAL_HORIZONS.includes(draft.horizon)) {
    return { ok: false, reason: `horizon must be one of: ${GOAL_HORIZONS.join(", ")}` };
  }
  const priority = draft.priority ?? 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    return { ok: false, reason: "priority must be an integer from 1 (highest) to 5" };
  }
  const now = nowIso(clock);
  return {
    ok: true,
    goal: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      // Goals reuse the task id space: they are the same kind of object one
      // level up, and a separate prefix would imply a separate log.
      id: makeId("task", random),
      statement,
      horizon: draft.horizon,
      priority,
      projects: draft.projects ?? [],
      conflictsWith: (draft.conflictsWith ?? []).map((phrase) => phrase.trim()).filter(Boolean),
      status: "active",
      createdAt: now,
      updatedAt: now,
      createdBy: draft.createdBy,
    },
  };
}

export function setGoalStatus(
  goal: GoalRecord,
  status: GoalStatus,
  clock: Clock = () => new Date(),
): GoalRecord {
  return { ...goal, status, updatedAt: nowIso(clock) };
}

export function upsertGoal(goals: GoalRecord[], goal: GoalRecord): GoalRecord[] {
  const index = goals.findIndex((existing) => existing.id === goal.id);
  if (index === -1) return [...goals, goal];
  const next = [...goals];
  next[index] = goal;
  return next;
}

/**
 * Active goals that apply to a project, highest priority first.
 *
 * A goal with no projects applies everywhere - that is what makes it a
 * higher-level goal rather than a project note.
 */
export function goalsForProject(goals: GoalRecord[], projectRoot: string): GoalRecord[] {
  return goals
    .filter((goal) => goal.status === "active")
    .filter((goal) => goal.projects.length === 0 || goal.projects.includes(projectRoot))
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
}

export interface GoalConflict {
  goal: GoalRecord;
  /** The phrase from `conflictsWith` that matched. Reported so the user can
   * see why this fired and edit the goal if it is noise. */
  phrase: string;
}

/**
 * Goals in tension with a proposed objective.
 *
 * Returns conflicts to *show*, never a decision. The caller surfaces these
 * next to the work; it does not gate on them. If the user reads the conflict
 * and proceeds anyway, that is the user overriding a goal, which section 13
 * explicitly permits - an explicit current instruction outranks a standing
 * goal.
 */
export function conflictingGoals(
  goals: GoalRecord[],
  projectRoot: string,
  objective: string,
): GoalConflict[] {
  const haystack = objective.toLowerCase();
  const conflicts: GoalConflict[] = [];
  for (const goal of goalsForProject(goals, projectRoot)) {
    for (const phrase of goal.conflictsWith) {
      if (phrase.length > 0 && haystack.includes(phrase.toLowerCase())) {
        conflicts.push({ goal, phrase });
        break;
      }
    }
  }
  return conflicts;
}

/* ------------------------------------------------------------------ *
 * Project relationships
 * ------------------------------------------------------------------ */

export type LinkOutcome = { ok: true; link: ProjectLink } | { ok: false; reason: string };

export function makeProjectLink(
  from: string,
  to: string,
  kind: ProjectLinkKind,
  detail: string,
  createdBy: Actor,
  clock: Clock = () => new Date(),
): LinkOutcome {
  if (from === to) return { ok: false, reason: "a project cannot be linked to itself" };
  if (from.trim().length === 0 || to.trim().length === 0) {
    return { ok: false, reason: "both project roots are required" };
  }
  if (!PROJECT_LINK_KINDS.includes(kind)) {
    return { ok: false, reason: `kind must be one of: ${PROJECT_LINK_KINDS.join(", ")}` };
  }
  return {
    ok: true,
    link: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      from,
      to,
      kind,
      detail: detail.trim(),
      createdAt: nowIso(clock),
      createdBy,
    },
  };
}

export function upsertLink(links: ProjectLink[], link: ProjectLink): ProjectLink[] {
  const index = links.findIndex(
    (existing) => existing.from === link.from && existing.to === link.to && existing.kind === link.kind,
  );
  if (index === -1) return [...links, link];
  const next = [...links];
  next[index] = link;
  return next;
}

/**
 * Projects related to this one, in either direction.
 *
 * Returns descriptions, not paths to work in. The caller may mention these
 * to the user; it must not add them to a scope. Crossing into a related
 * project is an ordinary scope expansion and goes through the ordinary
 * approval path.
 */
export function relatedProjects(links: ProjectLink[], projectRoot: string): ProjectLink[] {
  return links.filter((link) => link.from === projectRoot || link.to === projectRoot);
}

export function formatGoal(goal: GoalRecord): string {
  const scope = goal.projects.length === 0 ? "all projects" : goal.projects.join(", ");
  return `${goal.id} [p${goal.priority}/${goal.horizon}/${goal.status}] ${goal.statement} (${scope})`;
}

export function formatLink(link: ProjectLink): string {
  return `${link.from} <-> ${link.to} [${link.kind}]${link.detail ? `: ${link.detail}` : ""}`;
}

/**
 * The advisory block shown at session start and appended to the prompt.
 *
 * Its wording matters as much as its content: it tells the model these are
 * standing goals that inform recommendations, and that an explicit
 * instruction from the user outranks them. Without that sentence a model
 * will eventually treat a goal as a constraint and refuse work the user
 * asked for.
 */
export function renderGoalBlock(goals: GoalRecord[], links: ProjectLink[], projectRoot: string): string {
  const applicable = goalsForProject(goals, projectRoot);
  const related = relatedProjects(links, projectRoot);
  if (applicable.length === 0 && related.length === 0) return "";
  return [
    "## Standing goals",
    "",
    "These inform what you recommend and what tensions you surface. They do not",
    "override an explicit instruction from the user, and they are not permissions.",
    "",
    ...(applicable.length > 0
      ? applicable.map((goal) => `- [p${goal.priority}/${goal.horizon}] ${goal.statement}`)
      : ["- _no goals apply to this project_"]),
    ...(related.length > 0
      ? [
          "",
          "Related projects (context only - being related grants no access):",
          ...related.map((link) => `- ${formatLink(link)}`),
        ]
      : []),
  ].join("\n");
}
