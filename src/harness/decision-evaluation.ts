/**
 * Pi Harness - Phase 4.2 read-only outcome evaluator.
 *
 * Phase 4.1 records *what Pi decided* (decision telemetry). This module answers
 * the one further question 4.2 is scoped to:
 *
 *     "Did what happened match what was expected?"
 *
 * and deliberately stops there. It never answers "what should Pi change?" -
 * that is Phase 4.3, and the absence of any recommendation/proposal field in
 * the report shape is the enforced boundary between the two.
 *
 * The evaluator is a *pure fold over immutable evidence*. It is:
 *
 *  - Storage-unaware. It is handed a normalized `Evidence[]` (produced by a
 *    separate adapter that owns all knowledge of the audit/delegation/review
 *    stores) plus a chain-trust summary. It never imports fs, never imports the
 *    store, never verifies the chain itself. See PHASE4.2-DESIGN.md constraint 2.
 *
 *  - Assertion-vs-evidence, not field-vs-field. A telemetry record is Pi's own
 *    *claim* about an outcome; a runtime log or review record is *observed
 *    evidence*. The evaluator's whole job is comparing the claim against the
 *    evidence, so the two are represented as distinct provenance-tagged shapes
 *    (`telemetryClaim` vs `observedEvidence`), never as two equally-trusted
 *    outcome fields. See constraint 1.
 *
 *  - Deterministic and order-independent. The report is a total function of the
 *    evidence *set*: `evaluate(A+B+C)` deep-equals `evaluate(C+A+B)`. Ordering
 *    is derived only from intrinsic fields carried by each record (`at`, ids),
 *    never from array position, filesystem enumeration, or map insertion. See
 *    constraint 4.
 *
 *  - Non-mutating. This module returns a value and writes nothing. The command
 *    that calls it (Phase 4.2.3) must leave the system byte-identical. See
 *    constraint 5.
 *
 * Pure: no I/O, no clock, no randomness, no store/fs import.
 */

import { IMPORTANT_DECISION_ACTIONS } from "./decision-telemetry.ts";

/**
 * Where a piece of observed evidence came from. This is the *kind of witness*,
 * not a storage path - the evaluator stays storage-unaware. `delegate_runtime`
 * is the measured tool-call log of a delegation; `review` is a retrospective
 * reviewer's acceptance record.
 */
export type ObservationSource = "delegate_runtime" | "review";

/** A telemetry record: Pi's own assertion about a decision and its outcome. */
export interface DecisionClaim {
  kind: "claim";
  /** Audit event id - provenance, and the deterministic tiebreak. */
  eventId: string;
  /** Audit timestamp - the intrinsic ordering key (never array position). */
  at: string;
  decisionId: string;
  action: string;
  category: string;
  rule: string;
  /** The outcome Pi *claimed*, e.g. "completed" | "blocked" | "pending". */
  claimedOutcome: string;
}

/** An observed record: measured evidence about what actually happened. */
export interface DecisionObservation {
  kind: "observation";
  source: ObservationSource;
  /** Delegation job / review id - provenance and tiebreak. */
  refId: string;
  at: string;
  /** Join key back to the decision this is evidence about. */
  decisionId: string;
  /** The outcome as observed, e.g. "completed" | "runtime_violation". */
  observedOutcome: string;
  /**
   * The adapter's terminal reading of the evidence: did the observed thing
   * succeed *cleanly* (a delegation that completed with no runtime violations
   * and no terminal denial; a review that was accepted). This is a mechanical
   * fact the adapter can read off the measured record - never a judgement.
   */
  success: boolean;
}

export type Evidence = DecisionClaim | DecisionObservation;

/** Chain-trust summary, computed by the adapter (which owns the store) and
 * passed in so the evaluator can report trust without knowing about storage. */
export interface ChainTrust {
  ok: boolean;
  /** How many records are hash-verified (the trustworthy prefix). */
  verifiedPrefix: number;
  total: number;
}

export interface EvaluationInput {
  evidence: Evidence[];
  chain: ChainTrust;
}

/** The comparison result for one decision. There is deliberately no fourth
 * value that names a change - match/mismatch/unmeasured is the whole vocabulary
 * of an observational evaluator. */
export type Verdict = "match" | "mismatch" | "unmeasured";

export interface EvaluatedDecision {
  decisionId: string;
  action: string;
  category: string;
  rule: string;
  /** Pi's assertion. Null only if a decision surfaced with no claim (it never
   * does today - decisions are built from claims - but the shape is explicit
   * that a claim is an assertion, tagged with its source). */
  telemetryClaim: { source: "decision_telemetry"; outcome: string } | null;
  /** The observed evidence the verdict rests on. Null when nothing was
   * observed for this decision (verdict is then "unmeasured"). */
  observedEvidence: { source: ObservationSource; outcome: string; refId: string } | null;
  verdict: Verdict;
  /** Why this verdict - a short class label, never a recommendation. */
  verdictReason: string;
}

export interface EvaluationReport {
  provenance: {
    evidenceCount: number;
    claims: number;
    observations: number;
    chainOk: boolean;
    verifiedPrefix: number;
    totalRecords: number;
  };
  /**
   * The operational meaning of the numbers, so a downstream reader can never
   * mistake "nothing was evaluated" for "every decision was correct". An empty
   * result has four distinct causes and this block keeps them apart:
   *  - decisionsObserved === 0     -> no decisions (or telemetry missing)
   *  - unsupported > 0             -> decisions of a class this evaluator has
   *                                   no evidence source for
   *  - unmeasured > 0             -> supported decisions with no observed
   *                                   evidence yet (evidence unavailable)
   *  - measured = match + mismatch -> the only decisions actually graded
   * decisionsObserved === measured + unmeasured + unsupported.
   */
  coverage: {
    decisionsObserved: number;
    measured: number;
    unmeasured: number;
    unsupported: number;
  };
  decisions: EvaluatedDecision[];
  byAction: Record<string, { total: number; match: number; mismatch: number; unmeasured: number }>;
}

/* ---- fixed outcome vocabulary (a table, never a semantic judgement) ---- */

const SUCCESS_WORDS = new Set([
  "completed", "accepted", "returned", "allowed", "succeeded", "success", "resolved",
]);
const FAILURE_WORDS = new Set([
  "blocked", "denied", "rejected", "failed", "aborted", "error", "violation",
  "runtime_violation", "orphaned",
]);

type Terminal = "success" | "failure" | "nonterminal";

/** Map a claimed outcome string to a coarse terminal class via a fixed
 * dictionary. Anything unrecognized ("pending", "", a typo) is `nonterminal`:
 * the claim asserted nothing terminal, so there is nothing to contradict. */
function classifyClaim(outcome: string): Terminal {
  const key = outcome.trim().toLowerCase();
  if (SUCCESS_WORDS.has(key)) return "success";
  if (FAILURE_WORDS.has(key)) return "failure";
  return "nonterminal";
}

function isSupported(action: string): boolean {
  return (IMPORTANT_DECISION_ACTIONS as readonly string[]).includes(action);
}

/** Deterministic "latest" by intrinsic (at, id) - never by array position, so
 * reordering the input cannot change which record is chosen. */
function laterBy<T extends { at: string }>(a: T, aId: string, b: T, bId: string): boolean {
  if (a.at !== b.at) return a.at > b.at;
  return aId > bId;
}

/**
 * Evaluate a set of evidence into a report.
 *
 * Pure and order-independent: the result is a function of the evidence *set*.
 * Decisions are keyed by `decisionId`; the current claim and current
 * observation for a decision are the latest by intrinsic (at, id). Observations
 * with no matching claim are latent evidence (a future decision class) and are
 * counted in provenance but never invented into a decision row.
 */
export function evaluate(input: EvaluationInput): EvaluationReport {
  const claims = new Map<string, DecisionClaim>();
  const observations = new Map<string, DecisionObservation>();
  let claimCount = 0;
  let observationCount = 0;

  for (const ev of input.evidence) {
    if (ev.kind === "claim") {
      claimCount++;
      const prev = claims.get(ev.decisionId);
      if (prev === undefined || laterBy(ev, ev.eventId, prev, prev.eventId)) {
        claims.set(ev.decisionId, ev);
      }
    } else {
      observationCount++;
      const prev = observations.get(ev.decisionId);
      if (prev === undefined || laterBy(ev, ev.refId, prev, prev.refId)) {
        observations.set(ev.decisionId, ev);
      }
    }
  }

  const decisions: EvaluatedDecision[] = [];
  let measured = 0;
  let unmeasured = 0;
  let unsupported = 0;

  // Sort by decisionId (intrinsic) so output order never depends on input
  // order, map insertion order, or filesystem enumeration.
  const decisionIds = [...claims.keys()].sort();

  for (const decisionId of decisionIds) {
    const claim = claims.get(decisionId) as DecisionClaim;
    const obs = observations.get(decisionId) ?? null;

    let verdict: Verdict;
    let reason: string;

    if (!isSupported(claim.action)) {
      verdict = "unmeasured";
      reason = "unsupported action class - no evidence source";
      unsupported++;
    } else if (obs === null) {
      verdict = "unmeasured";
      reason = "no observed evidence for this decision";
      unmeasured++;
    } else {
      const claimClass = classifyClaim(claim.claimedOutcome);
      if (claimClass === "nonterminal") {
        verdict = "unmeasured";
        reason = "telemetry made no terminal claim to compare";
        unmeasured++;
      } else {
        const claimSuccess = claimClass === "success";
        if (claimSuccess === obs.success) {
          verdict = "match";
          reason = "claimed outcome agrees with observed evidence";
        } else {
          verdict = "mismatch";
          reason = `telemetry claimed "${claim.claimedOutcome}" but evidence shows "${obs.observedOutcome}"`;
        }
        measured++;
      }
    }

    decisions.push({
      decisionId,
      action: claim.action,
      category: claim.category,
      rule: claim.rule,
      telemetryClaim: { source: "decision_telemetry", outcome: claim.claimedOutcome },
      observedEvidence: obs === null
        ? null
        : { source: obs.source, outcome: obs.observedOutcome, refId: obs.refId },
      verdict,
      verdictReason: reason,
    });
  }

  // byAction over supported classes only, in a fixed key order so the object
  // is identical regardless of the order decisions were encountered.
  const byAction: EvaluationReport["byAction"] = {};
  for (const d of decisions) {
    if (!isSupported(d.action)) continue;
    const bucket = (byAction[d.action] ??= { total: 0, match: 0, mismatch: 0, unmeasured: 0 });
    bucket.total++;
    if (d.verdict === "match") bucket.match++;
    else if (d.verdict === "mismatch") bucket.mismatch++;
    else bucket.unmeasured++;
  }

  return {
    provenance: {
      evidenceCount: input.evidence.length,
      claims: claimCount,
      observations: observationCount,
      chainOk: input.chain.ok,
      verifiedPrefix: input.chain.verifiedPrefix,
      totalRecords: input.chain.total,
    },
    coverage: {
      decisionsObserved: decisions.length,
      measured,
      unmeasured,
      unsupported,
    },
    decisions,
    byAction,
  };
}
