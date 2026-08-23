/**
 * Pi Harness - Phase 4.2 evidence adapter.
 *
 * The evaluator (`decision-evaluation.ts`) is storage-unaware by design: it
 * takes a normalized `Evidence[]` and knows nothing about audit events,
 * delegation jobs, or review generations. This module is the one place that
 * DOES know those record shapes. It converts the harness's existing records
 * into the evaluator's evidence vocabulary, and nothing else knows both halves.
 * See PHASE4.2-DESIGN.md constraint 2.
 *
 * It is pure over already-read records: it performs no I/O itself. The command
 * (Phase 4.2.3) does the actual `store.read*()` calls and hands the records
 * here, so this module - like the evaluator - never touches the filesystem and
 * stays trivially testable.
 *
 *   store.readAudit() / readDelegations() / readReviewGenerations()   (command)
 *                              |
 *                              v
 *                        toEvidence(...)         (this module: shape knowledge)
 *                              |
 *                              v
 *                          Evidence[]            (evaluator: shape-unaware)
 */

import type {
  AuditChainVerification,
  AuditEvent,
  DelegationJobRecord,
  ReviewGeneration,
} from "./types.ts";
import type {
  ChainTrust,
  DecisionClaim,
  DecisionObservation,
  Evidence,
} from "./decision-evaluation.ts";

export interface EvidenceSources {
  audit: AuditEvent[];
  delegations: DelegationJobRecord[];
  reviews: ReviewGeneration[];
}

/** The bounded telemetry payload as it appears inside an audit event's
 * metadata. Only the fields the adapter reads; validated defensively because a
 * hand-edited or legacy line could carry anything. */
interface StoredDecision {
  decisionId?: unknown;
  action?: unknown;
  category?: unknown;
  rule?: unknown;
  outcome?: { status?: unknown } | unknown;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A delegation is clean iff it reached the terminal `completed` status. Every
 * other terminal status (blocked, aborted, denied, orphaned,
 * attestation-refused) is a not-success, and `running` is not terminal - it is
 * still success:false because nothing has been observed to succeed yet. This is
 * a mechanical read of the job record, never a judgement. */
function delegationSucceeded(status: DelegationJobRecord["status"]): boolean {
  return status === "completed";
}

/**
 * Convert the three existing record streams into evaluator evidence.
 *
 * - decision_telemetry audit events  -> DecisionClaim   (Pi's assertion)
 * - delegation job records           -> DecisionObservation (measured)
 * - review generations               -> DecisionObservation (measured)
 *
 * Malformed telemetry (missing decisionId/action) is dropped rather than
 * turned into a bogus claim: the evaluator would only mark it unsupported, and
 * a dropped line is more honest than a fabricated one.
 */
export function toEvidence(src: EvidenceSources): Evidence[] {
  const out: Evidence[] = [];

  for (const event of src.audit) {
    if (event.eventType !== "decision_telemetry") continue;
    const decision = (event.metadata?.decision ?? null) as StoredDecision | null;
    if (decision === null || typeof decision !== "object") continue;
    const decisionId = str(decision.decisionId);
    const action = str(decision.action);
    if (decisionId.length === 0 || action.length === 0) continue;
    const outcome = (decision.outcome ?? null) as { status?: unknown } | null;
    const claim: DecisionClaim = {
      kind: "claim",
      eventId: event.id,
      at: event.timestamp,
      decisionId,
      action,
      category: str(decision.category, "uncategorized"),
      rule: str(decision.rule, "unspecified"),
      claimedOutcome: str(outcome?.status, "pending"),
    };
    out.push(claim);
  }

  for (const job of src.delegations) {
    const observation: DecisionObservation = {
      kind: "observation",
      source: "delegate_runtime",
      // Written by the harness while running the child - inside the agent
      // process. Always agent-authored; only an external reader may stamp
      // externally_observed (unforgeability).
      origin: "agent_authored",
      refId: job.id,
      at: job.at,
      // The delegation contract id is the telemetry decisionId join key.
      decisionId: job.contractId,
      observedOutcome: job.status,
      success: delegationSucceeded(job.status),
    };
    out.push(observation);
  }

  for (const review of src.reviews) {
    const accepted = review.acceptance.accepted === true;
    const observation: DecisionObservation = {
      kind: "observation",
      source: "review",
      origin: "agent_authored",
      refId: `${review.sessionId}#${review.generation}`,
      at: review.createdAt,
      // No review-class telemetry is wired yet, so this keys on the session and
      // sits as latent evidence until a review-class decision references it.
      // Keying it now keeps the adapter forward-compatible without inventing a
      // decision that does not exist.
      decisionId: review.sessionId,
      observedOutcome: accepted ? "accepted" : "rejected",
      success: accepted && review.acceptance.reviewProduced === true,
    };
    out.push(observation);
  }

  return out;
}

/** Project the store's chain verification into the evaluator's trust summary.
 * The adapter owns the `AuditChainVerification` shape; the evaluator only sees
 * three numbers/booleans. */
export function chainTrust(verification: AuditChainVerification, total: number): ChainTrust {
  return {
    ok: verification.ok,
    verifiedPrefix: verification.verifiedCount,
    total,
  };
}
