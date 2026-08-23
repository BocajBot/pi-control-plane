/**
 * Pi Harness - Phase 4.2 follow-up: external-evidence reader (file_diff).
 *
 * Every evidence source the evaluator reads today is agent-authored: telemetry,
 * delegate runtime, and review records all originate inside the process that made
 * the decision. This reader adds the first witness the agent cannot author - a
 * file diff between a harness-recorded baseline and the tree at evaluation time -
 * so a decision that *claims* it changed files can be contradicted by the fact
 * that nothing changed.
 *
 * The whole module is built around what a diff can and cannot prove (the approved
 * amendment):
 *
 *  - It can REFUTE. An empty diff after a claimed-completed, edit-expecting
 *    decision is strong evidence the edit did not happen -> an authoritative
 *    `externally_observed` observation with `success:false`, which the evaluator
 *    lets outrank the agent's self-report and flip the verdict to mismatch.
 *
 *  - It cannot CONFIRM. A nonzero diff could be anyone's change (another session,
 *    the user), so it is only weak corroboration - the reader emits NOTHING for
 *    it. In particular it never emits a file_diff `success:true`, so file_diff can
 *    never flip an agent-reported failure into a match.
 *
 * Attribution rests on a baseline the model did not write: `job.repoAnchor`,
 * captured by the harness execution layer at delegation start. If a decision
 * predates that field (anchor null), the reader DROPS the signal rather than
 * diffing against a guessed baseline (no-faith join).
 *
 * Purity: this module runs no git and touches no filesystem itself. All I/O is
 * injected as `gitDiff` (and `now`), exactly as the storage adapter keeps I/O in
 * the command tier. That keeps the reader deterministic and testable, and keeps
 * the evaluator entirely unaware of it.
 */

import type { DelegationJobRecord } from "./types.ts";
import type { DecisionClaim, DecisionObservation } from "./decision-evaluation.ts";

/** Outcome words that count as a claimed success (kept in step with the
 * evaluator's own success vocabulary; a claimed failure is never refuted by an
 * empty diff, so only success claims are checked). */
const CLAIM_SUCCESS_WORDS = new Set([
  "completed", "accepted", "returned", "allowed", "succeeded", "success", "resolved",
]);

export interface FileDiffDeps {
  /**
   * Return the list of changed paths between `anchor` and the working tree,
   * restricted to `roots`. An EMPTY array means "nothing changed" (the
   * refutation trigger). `null` means the diff could not be computed (bad
   * anchor, git failure) - the reader then emits nothing rather than treating an
   * un-observable state as "no changes". Injected so the module does no I/O.
   */
  gitDiff: (anchor: string, roots: readonly string[]) => string[] | null;
  /** Evaluation-time timestamp (ISO), supplied by the caller for purity. */
  now: string;
  /**
   * Whether a decision was expected to change files. Defaults to conservative
   * FALSE: today's only telemetry seam is read-only delegation, which is meant
   * to produce no diff, so an empty diff there is correct and must not be
   * refuted. The seam lights up when an edit-class decision is recorded - by
   * supplying a predicate that recognizes it - without any change to this module.
   */
  expectsFileChange: (claim: DecisionClaim) => boolean;
}

function claimsSuccess(outcome: string): boolean {
  return CLAIM_SUCCESS_WORDS.has(outcome.trim().toLowerCase());
}

/**
 * Produce file_diff observations for decisions whose claim can be refuted by an
 * empty diff. Returns externally-observed, `success:false` observations only -
 * one per refuted decision. Everything else (no anchor, not edit-expecting, not a
 * success claim, un-observable diff, or a nonzero diff) yields nothing.
 *
 * `claims` is the set of telemetry claims (the evaluator's own claim evidence);
 * `jobs` are the delegation records carrying the anchor and the contract roots.
 * Deterministic: output depends only on the inputs, ordered by decisionId.
 */
export function readFileDiffEvidence(
  claims: readonly DecisionClaim[],
  jobs: readonly DelegationJobRecord[],
  deps: FileDiffDeps,
): DecisionObservation[] {
  // Latest claim per decision, by intrinsic (at, eventId) - matches the
  // evaluator's own selection so the reader judges the same claim it will.
  const claimById = new Map<string, DecisionClaim>();
  for (const c of claims) {
    const prev = claimById.get(c.decisionId);
    if (prev === undefined || c.at > prev.at || (c.at === prev.at && c.eventId > prev.eventId)) {
      claimById.set(c.decisionId, c);
    }
  }

  const out: DecisionObservation[] = [];
  const emitted = new Set<string>();

  for (const job of jobs) {
    const decisionId = job.contractId;
    if (emitted.has(decisionId)) continue;

    const claim = claimById.get(decisionId);
    if (claim === undefined) continue;                         // no decision to judge
    if (!deps.expectsFileChange(claim)) continue;             // empty diff is not a refutation here
    if (!claimsSuccess(claim.claimedOutcome)) continue;       // never refute a claimed failure

    const anchor = job.repoAnchor;
    if (anchor === null || anchor.length === 0) continue;     // no-faith join: drop, do not guess a baseline

    const changed = deps.gitDiff(anchor, job.readRoots);
    if (changed === null) continue;                           // un-observable: emit nothing, never assume "no changes"
    if (changed.length > 0) continue;                         // nonzero diff = weak corroboration only -> nothing

    // Empty diff after a claimed-completed edit-expecting decision: REFUTATION.
    emitted.add(decisionId);
    out.push({
      kind: "observation",
      source: "file_diff",
      origin: "externally_observed",
      refId: `filediff:${anchor.slice(0, 12)}`,
      at: deps.now,
      decisionId,
      observedOutcome: "no_file_changes",
      success: false,
    });
  }

  // Deterministic order, independent of job append order.
  return out.sort((a, b) => (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0));
}
