/**
 * Pi Harness - Phase 4.1 decision telemetry contract.
 *
 * This is the *evidence layer*, not a second control plane. It records what
 * class of decision the coordinator made and what happened afterward, so a
 * later (Phase 4.2) read-only evaluator can look for mismatches between what
 * Pi chose and what the user actually wanted. It changes no authority: a
 * telemetry record is written strictly AFTER a verdict is reached, never in
 * place of one, and nothing here can widen a capability.
 *
 * Two properties are enforced by construction, in this pure module, so they
 * cannot be forgotten at a call site:
 *
 *  1. Only *important* decisions are recorded (authority, delegation, model
 *     selection, memory, workflow routing). Recording every internal choice
 *     would turn the audit chain into a dumping ground - Phase 4 migration
 *     risk 1. `buildDecisionTelemetry` returns null for anything else, and a
 *     null is simply not written.
 *
 *  2. The record is a *bounded* shape. The builder copies only the contract
 *     fields into a fresh object, so a caller that passes a raw reasoning
 *     trace, chain-of-thought, or any other extra key cannot leak it into the
 *     durable log - the extra key is dropped, not stored. The telemetry
 *     target is "what decision, which class, what outcome", never the model's
 *     private reasoning.
 *
 * The record rides inside the `metadata` of a `decision_telemetry` audit
 * event (metadata is already a canonical, hash-chained field), so telemetry is
 * tamper-evident for free and needs no new file, no new store, and no schema
 * bump. See PHASE4-DESIGN.md Q1.
 *
 * Pure: no I/O, no clock, no randomness. The extension supplies the audit
 * seam; this module only shapes and gates the payload.
 */

/**
 * The decision classes worth recording. This allowlist IS the migration-risk-1
 * mitigation: it is the whole set of actions telemetry will ever persist, and
 * it is deliberately limited to choices that touch authority, delegation,
 * model selection, memory, or workflow routing. A generic per-tool "execute"
 * is not here on purpose - it would be noise, not signal.
 */
export const IMPORTANT_DECISION_ACTIONS = [
  "delegate",
  "consult",
  "request_scope",
  "posture_change",
  "model_select",
  "memory_write",
  "route",
  // A command the coordinator decided to run (a validation/build/test check) as
  // part of a task. This records an ALREADY-AUTHORIZED action - it grants no new
  // capability and adds no actor; it only makes the choice observable so the
  // exit_code external-evidence seam (Phase 4.2 §A) can join a real outcome to
  // it by run id. Recording surface, not an authority boundary.
  "command_run",
] as const;

export type ImportantDecisionAction = (typeof IMPORTANT_DECISION_ACTIONS)[number];

export const DECISION_COMPLEXITIES = ["low", "medium", "high"] as const;
export type DecisionComplexity = (typeof DECISION_COMPLEXITIES)[number];

/**
 * The bounded telemetry record. This is the whole contract - there is no
 * free-form field, and in particular nowhere to put a reasoning trace.
 *
 * `outcome` is recorded as known at the moment of writing. At the decision
 * itself only the immediate result is known (e.g. a delegation was allowed);
 * the fuller outcome (it was accepted, or the user overrode it, after N
 * retries) arrives later and is recorded as a *second*, linked
 * `decision_telemetry` event - the audit log is append-only, so an outcome is
 * never an edit of the original record. `decisionId` is the join key.
 */
export interface DecisionTelemetry {
  /** Stable id linking a decision to its later outcome record(s). */
  decisionId: string;
  action: ImportantDecisionAction;
  /** The decision class, e.g. "implementation_task", "scope_expansion". */
  category: string;
  /** The rule/reason class - typically the authorize() verdict rule, or the
   * seam's own reason. Not a sentence of reasoning; a short class label. */
  rule: string;
  /** 0..1 if the seam has a confidence signal, else null. Out-of-range or
   * non-finite inputs become null rather than being clamped silently, so a
   * bogus confidence is visibly absent instead of quietly "1.0". */
  confidence: number | null;
  context: {
    taskClass: string | null;
    estimatedComplexity: DecisionComplexity | null;
    /** Which capabilities were available when the choice was made - the set
     * the decision was made *within*. Deduplicated, strings only. */
    availableCapabilities: string[];
  };
  outcome: {
    /** e.g. pending | allowed | needs_approval | denied | accepted | rejected
     * | completed | failed | aborted. A free string, but a short status, not
     * prose. */
    status: string;
    retries: number;
    userOverride: boolean;
  };
}

/** What a call site passes in. Every field is optional except the two that
 * make a record meaningful (action + decisionId); everything is coerced to the
 * bounded shape, and unknown keys are ignored. */
export interface DecisionTelemetryInput {
  decisionId: string;
  action: string;
  category?: string;
  rule?: string;
  confidence?: number | null;
  context?: {
    taskClass?: string | null;
    estimatedComplexity?: string | null;
    availableCapabilities?: readonly string[];
  };
  outcome?: {
    status?: string;
    retries?: number;
    userOverride?: boolean;
  };
  // NOTE: deliberately no field for reasoning / chain-of-thought / model
  // internals. Even if a caller passes one, `buildDecisionTelemetry` copies
  // only the fields above into the result, so it is dropped.
}

function isImportant(action: string): action is ImportantDecisionAction {
  return (IMPORTANT_DECISION_ACTIONS as readonly string[]).includes(action);
}

function boundedConfidence(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function boundedComplexity(value: string | null | undefined): DecisionComplexity | null {
  return (DECISION_COMPLEXITIES as readonly string[]).includes(value ?? "")
    ? (value as DecisionComplexity)
    : null;
}

function boundedCapabilities(value: readonly string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const v of value) if (typeof v === "string" && v.length > 0) seen.add(v);
  return [...seen];
}

/**
 * The label fields (action category, rule, status, task class) are class
 * labels, not prose. Capping their length is the second half of the
 * "no reasoning traces" guarantee: dropping unknown keys stops a trace arriving
 * as its own field, and this stops one being smuggled into a declared field. A
 * label longer than this is truncated to label size, so the durable record can
 * never hold a sentence of reasoning.
 */
export const MAX_LABEL_LEN = 80;

function boundedString(value: string | undefined, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) return fallback;
  return trimmed.length > MAX_LABEL_LEN ? trimmed.slice(0, MAX_LABEL_LEN) : trimmed;
}

function boundedRetries(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Shape and gate a telemetry record.
 *
 * Returns null - meaning "do not record" - when the action is not one of the
 * important classes, or when the decisionId is empty. A null must be treated
 * as "write nothing", never as an error to work around: it is the migration
 * risk 1 defence doing its job.
 *
 * The returned object contains ONLY contract fields. Any extra key on the
 * input (a reasoning trace, say) is absent from the result by construction.
 */
export function buildDecisionTelemetry(input: DecisionTelemetryInput): DecisionTelemetry | null {
  if (typeof input.decisionId !== "string" || input.decisionId.trim().length === 0) return null;
  if (!isImportant(input.action)) return null;
  return {
    decisionId: input.decisionId.trim(),
    action: input.action,
    category: boundedString(input.category, "uncategorized"),
    rule: boundedString(input.rule, "unspecified"),
    confidence: boundedConfidence(input.confidence),
    context: {
      taskClass:
        typeof input.context?.taskClass === "string" && input.context.taskClass.trim().length > 0
          ? input.context.taskClass.trim().slice(0, MAX_LABEL_LEN)
          : null,
      estimatedComplexity: boundedComplexity(input.context?.estimatedComplexity),
      availableCapabilities: boundedCapabilities(input.context?.availableCapabilities),
    },
    outcome: {
      status: boundedString(input.outcome?.status, "pending"),
      retries: boundedRetries(input.outcome?.retries),
      userOverride: input.outcome?.userOverride === true,
    },
  };
}

/**
 * A later outcome for a decision already recorded, as its own record. Reuses
 * the same shape (the evaluator reads one event stream) but marks that it
 * refers back to an earlier decision. The decision's action/category/rule are
 * restated so an outcome event is self-describing; only `outcome` and possibly
 * `confidence`/`userOverride` differ from the original.
 */
export function buildDecisionOutcome(
  original: DecisionTelemetry,
  outcome: DecisionTelemetryInput["outcome"] & { userOverride?: boolean },
): DecisionTelemetry {
  return {
    ...original,
    outcome: {
      status: boundedString(outcome?.status, original.outcome.status),
      retries: boundedRetries(outcome?.retries ?? original.outcome.retries),
      userOverride: outcome?.userOverride === true || original.outcome.userOverride,
    },
  };
}
