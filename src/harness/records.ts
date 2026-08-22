/**
 * Pi Harness - decision and incident records
 * (spec sections 11, 12; invariants D1-D4, I1-I6).
 *
 * Pure constructors. They exist as their own module rather than as inline
 * object literals at the call sites because both record kinds carry rules
 * that only hold if something refuses to build the record without them:
 *
 * - A temporary decision with no revisit condition (D3) is a durable
 *   decision that nobody labelled. `makeDecision()` refuses it.
 * - An incident whose observed effect and suspected cause are the same
 *   sentence (I2) is a conclusion wearing an observation's clothes. The two
 *   are separate required fields, and the cause is drawn from a fixed
 *   vocabulary that includes "unknown" so there is always a truthful option
 *   that is not a guess.
 * - Reopening a durable decision produces a new record pointing at the old
 *   one (D4). `reopen()` is the only way to express it, and it cannot
 *   mutate the original because it does not receive a mutable reference to
 *   anything the caller will persist.
 */

import {
  HARNESS_SCHEMA_VERSION,
  INCIDENT_CAUSES,
  type Actor,
  type DecisionKind,
  type DecisionRecord,
  type IncidentCause,
  type IncidentRecord,
  type IncidentSeverity,
  type ModelConfiguration,
  type ReasoningMode,
} from "./types.ts";
import { makeId, nowIso, type Clock, type RandomSource } from "./util.ts";

export interface DecisionDraft {
  session: string;
  kind: DecisionKind;
  statement: string;
  rationale: string;
  alternatives?: string[];
  rejectionReasons?: string[];
  evidence?: string[];
  /** Required when `kind === "temporary"` (D3). */
  revisitCondition?: string | null;
  createdBy: Actor;
}

export type DecisionOutcome =
  | { ok: true; decision: DecisionRecord }
  | { ok: false; reason: string; rule: string };

export function makeDecision(
  draft: DecisionDraft,
  clock: Clock = () => new Date(),
  random?: RandomSource,
): DecisionOutcome {
  if (draft.statement.trim().length === 0) {
    return { ok: false, reason: "a decision needs a statement", rule: "D1" };
  }
  if (draft.rationale.trim().length === 0) {
    // D1: rationale is not optional. A decision without one is not
    // recoverable later as a decision - only as a fact about the code.
    return { ok: false, reason: "a decision needs a rationale", rule: "D1" };
  }
  const revisit = (draft.revisitCondition ?? "").trim();
  if (draft.kind === "temporary" && revisit.length === 0) {
    return {
      ok: false,
      reason:
        "a temporary decision needs an expiration, revisit date, or trigger condition; otherwise record it as durable",
      rule: "D3",
    };
  }
  return {
    ok: true,
    decision: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      id: makeId("decision", random),
      session: draft.session,
      kind: draft.kind,
      statement: draft.statement.trim(),
      rationale: draft.rationale.trim(),
      alternatives: draft.alternatives ?? [],
      rejectionReasons: draft.rejectionReasons ?? [],
      evidence: draft.evidence ?? [],
      revisitCondition: draft.kind === "temporary" ? revisit : null,
      supersedes: null,
      createdAt: nowIso(clock),
      createdBy: draft.createdBy,
    },
  };
}

/**
 * Reopen a decision (D4).
 *
 * Returns a new record whose `supersedes` points at the old one. The old
 * record is returned unchanged and unreferenced - the caller appends the new
 * line to `decisions.jsonl` and the history reads as a chain, not as an
 * edit.
 */
export function reopen(
  previous: DecisionRecord,
  draft: DecisionDraft,
  clock: Clock = () => new Date(),
  random?: RandomSource,
): DecisionOutcome {
  const created = makeDecision(draft, clock, random);
  if (!created.ok) return created;
  return { ok: true, decision: { ...created.decision, supersedes: previous.id } };
}

/** The active view of a decision log: later records win, and anything a
 * later record supersedes drops out of the view but stays in the file. */
export function activeDecisions(decisions: DecisionRecord[]): DecisionRecord[] {
  const superseded = new Set(
    decisions.map((decision) => decision.supersedes).filter((id): id is string => id !== null),
  );
  return decisions.filter((decision) => !superseded.has(decision.id));
}

/** Temporary decisions whose revisit condition is a date now in the past.
 * Non-date conditions are never auto-expired - the harness cannot evaluate
 * "when the migration lands", and pretending otherwise would silently retire
 * a live decision. */
export function expiredDecisions(
  decisions: DecisionRecord[],
  clock: Clock = () => new Date(),
): DecisionRecord[] {
  const now = clock().getTime();
  return activeDecisions(decisions).filter((decision) => {
    if (decision.kind !== "temporary" || decision.revisitCondition === null) return false;
    const parsed = Date.parse(decision.revisitCondition);
    return Number.isFinite(parsed) && parsed < now;
  });
}

/* ------------------------------------------------------------------ *
 * Incidents
 * ------------------------------------------------------------------ */

export interface IncidentDraft {
  session: string;
  taskId?: string | null;
  description: string;
  severity: IncidentSeverity;
  detectedBy: Actor;
  model: ModelConfiguration | null;
  reasoningMode: ReasoningMode;
  /** What was observed. */
  observedEffect: string;
  /** Why we think it happened, as a category plus optional detail. Separate
   * from `observedEffect` by construction (I2). */
  suspectedCause: IncidentCause;
  suspectedCauseDetail?: string | null;
  evidence?: string[];
}

export type IncidentOutcome =
  | { ok: true; incident: IncidentRecord }
  | { ok: false; reason: string; rule: string };

export function makeIncident(
  draft: IncidentDraft,
  clock: Clock = () => new Date(),
  random?: RandomSource,
): IncidentOutcome {
  if (draft.description.trim().length === 0) {
    return { ok: false, reason: "an incident needs a description", rule: "I1" };
  }
  if (draft.observedEffect.trim().length === 0) {
    return { ok: false, reason: "an incident needs an observed effect", rule: "I2" };
  }
  if (!INCIDENT_CAUSES.includes(draft.suspectedCause)) {
    return { ok: false, reason: `unrecognized cause "${draft.suspectedCause}"`, rule: "I3" };
  }
  return {
    ok: true,
    incident: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      id: makeId("incident", random),
      session: draft.session,
      taskId: draft.taskId ?? null,
      description: draft.description.trim(),
      severity: draft.severity,
      detectedBy: draft.detectedBy,
      model: draft.model,
      reasoningMode: draft.reasoningMode,
      observedEffect: draft.observedEffect.trim(),
      suspectedCause: draft.suspectedCause,
      suspectedCauseDetail: (draft.suspectedCauseDetail ?? "").trim() || null,
      correction: null,
      outcome: null,
      evidence: draft.evidence ?? [],
      createdAt: nowIso(clock),
    },
  };
}

/**
 * Record that an incident was corrected.
 *
 * Returns an updated copy for the caller to append as a *new* line. The
 * incident log is append-only like the audit log, so the original record
 * survives alongside the corrected one - I1: fixing an error does not delete
 * the incident.
 */
export function recordCorrection(
  incident: IncidentRecord,
  correction: string,
  outcome: string,
): IncidentRecord {
  return { ...incident, correction: correction.trim(), outcome: outcome.trim() };
}

/**
 * Prior incidents that resemble this one, for step 4 of the reviewer loop
 * ("check Pi's own history for similar incidents").
 *
 * Matching is by cause plus model, not by text similarity. Two incidents
 * with the same cause on the same model are the repetition worth
 * investigating (I6); two with similar wording and different causes are not,
 * and treating them as the same is how a prompt grows a universal rule for a
 * model-specific problem (MO2).
 */
export function similarIncidents(
  incidents: IncidentRecord[],
  candidate: IncidentRecord,
): IncidentRecord[] {
  return incidents.filter(
    (incident) =>
      incident.id !== candidate.id &&
      incident.suspectedCause === candidate.suspectedCause &&
      incident.model?.model === candidate.model?.model,
  );
}

export function formatIncident(incident: IncidentRecord): string {
  const model = incident.model ? `${incident.model.provider}/${incident.model.model}` : "no model";
  const corrected = incident.correction ? " (corrected)" : "";
  return `${incident.id} [${incident.severity}] ${incident.description} - observed: ${incident.observedEffect}; suspected cause: ${incident.suspectedCause} (${model})${corrected}`;
}
