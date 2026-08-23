/**
 * Phase 4.2 follow-up - external-evidence reader (file_diff).
 *
 * These tests hold the approved amendment: file_diff can REFUTE a claimed edit
 * (an empty diff after a claimed-completed edit-expecting decision) but never
 * CONFIRM one (a nonzero diff emits nothing, and file_diff never flips a claimed
 * failure to match). Attribution rests on a harness-recorded anchor; a decision
 * with no anchor is dropped, not diffed against a guess. And the origin is
 * unforgeable: only this reader stamps externally_observed, and when it and the
 * agent's self-report disagree the external witness wins the verdict (§B).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";

import { readFileDiffEvidence, type FileDiffDeps } from "../src/harness/external-evidence.ts";
import { evaluate, type DecisionClaim, type DecisionObservation } from "../src/harness/decision-evaluation.ts";
import { toEvidence } from "../src/harness/decision-evaluation-adapter.ts";
import type { DelegationJobRecord, AuditEvent } from "../src/harness/types.ts";

function claim(over: Partial<DecisionClaim> & { decisionId: string }): DecisionClaim {
  return {
    kind: "claim", eventId: `ev-${over.decisionId}`, at: "2026-02-01T00:00:00.000Z",
    action: "delegate", category: "c", rule: "r", claimedOutcome: "completed", ...over,
  };
}
function job(over: Partial<DelegationJobRecord> & { contractId: string }): DelegationJobRecord {
  return {
    id: over.contractId, contractId: over.contractId, status: "completed",
    readRoots: ["/proj/src"], repoAnchor: "abc123def456", at: "2026-02-01T00:00:30.000Z",
    ...over,
  } as unknown as DelegationJobRecord;
}
const deps = (over: Partial<FileDiffDeps>): FileDiffDeps => ({
  gitDiff: () => [],                    // default: empty diff (nothing changed)
  now: "2026-02-02T00:00:00.000Z",
  expectsFileChange: () => true,        // default: the decision was an edit-task
  ...over,
});

/* ---- refutation: empty diff after a claimed edit is a false-success ---- */

test("external: empty diff + claimed-completed edit-task -> one externally_observed success:false", () => {
  const obs = readFileDiffEvidence([claim({ decisionId: "c1" })], [job({ contractId: "c1" })], deps({ gitDiff: () => [] }));
  assert.equal(obs.length, 1);
  assert.equal(obs[0].source, "file_diff");
  assert.equal(obs[0].origin, "externally_observed");
  assert.equal(obs[0].success, false);
  assert.equal(obs[0].decisionId, "c1");
});

test("external+eval: the refutation FLIPS a claimed success to mismatch (external wins §B)", () => {
  const c = claim({ decisionId: "c1", claimedOutcome: "completed" });
  const external = readFileDiffEvidence([c], [job({ contractId: "c1" })], deps({ gitDiff: () => [] }));
  // Alongside an agent-authored delegate_runtime observation that says success.
  const agentObs: DecisionObservation = {
    kind: "observation", source: "delegate_runtime", origin: "agent_authored",
    refId: "c1", at: "2026-02-01T00:00:31.000Z", decisionId: "c1", observedOutcome: "completed", success: true,
  };
  const report = evaluate({ evidence: [c, agentObs, ...external], chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.decisions[0].verdict, "mismatch", "external refutation outranks the agent's self-report");
  assert.equal(report.decisions[0].observedEvidence?.origin, "externally_observed");
  assert.equal(report.coverage.externallyCorroborated, 1);
  assert.equal(report.coverage.agentAuthoredOnly, 0);
});

/* ---- asymmetry: file_diff never confirms, never flips a failure ---- */

test("external: a nonzero diff emits nothing (weak corroboration only, never proof of success)", () => {
  const obs = readFileDiffEvidence([claim({ decisionId: "c1" })], [job({ contractId: "c1" })],
    deps({ gitDiff: () => ["/proj/src/a.ts"] }));
  assert.deepEqual(obs, []);
});

test("external: a claimed FAILURE is never refuted by a diff (asymmetry)", () => {
  const obs = readFileDiffEvidence([claim({ decisionId: "c1", claimedOutcome: "blocked" })],
    [job({ contractId: "c1" })], deps({ gitDiff: () => [] }));
  assert.deepEqual(obs, [], "file_diff only ever refutes a claimed success");
});

test("external: a non-edit-expecting decision is not refuted by an empty diff", () => {
  const obs = readFileDiffEvidence([claim({ decisionId: "c1" })], [job({ contractId: "c1" })],
    deps({ expectsFileChange: () => false }));
  assert.deepEqual(obs, [], "read-only delegations produce no diff; that is correct, not a refutation");
});

/* ---- anchor: no baseline -> drop, never guess ---- */

test("external: a decision with no repoAnchor is DROPPED (no-faith join, no guessed baseline)", () => {
  const obs = readFileDiffEvidence([claim({ decisionId: "c1" })],
    [job({ contractId: "c1", repoAnchor: null })], deps({ gitDiff: () => [] }));
  assert.deepEqual(obs, []);
});

test("external: an un-observable diff (git failure -> null) emits nothing, never assumes 'no changes'", () => {
  const obs = readFileDiffEvidence([claim({ decisionId: "c1" })], [job({ contractId: "c1" })],
    deps({ gitDiff: () => null }));
  assert.deepEqual(obs, [], "null diff must not be treated as an empty diff");
});

test("external: a job with no matching claim is not judged", () => {
  const obs = readFileDiffEvidence([], [job({ contractId: "c1" })], deps({ gitDiff: () => [] }));
  assert.deepEqual(obs, []);
});

/* ---- determinism ---- */

test("external: output is deterministic and order-independent", () => {
  const claims = [claim({ decisionId: "b" }), claim({ decisionId: "a" })];
  const jobs = [job({ contractId: "b" }), job({ contractId: "a" })];
  const one = readFileDiffEvidence(claims, jobs, deps({ gitDiff: () => [] }));
  const two = readFileDiffEvidence([...claims].reverse(), [...jobs].reverse(), deps({ gitDiff: () => [] }));
  assert.deepEqual(one, two);
  assert.deepEqual(one.map((o) => o.decisionId), ["a", "b"], "sorted by decisionId");
});

/* ---- origin unforgeability ---- */

test("external: the reader stamps externally_observed; the storage adapter never does", () => {
  const external = readFileDiffEvidence([claim({ decisionId: "c1" })], [job({ contractId: "c1" })], deps({ gitDiff: () => [] }));
  assert.ok(external.every((o) => o.origin === "externally_observed"));

  // The agent-authored adapter, over real record shapes, only ever stamps
  // agent_authored - it cannot mint an external origin.
  const fromStore = toEvidence({
    audit: [{ id: "e", timestamp: "t", eventType: "decision_telemetry",
      metadata: { decision: { decisionId: "c1", action: "delegate", outcome: { status: "completed" } } } } as unknown as AuditEvent],
    delegations: [job({ contractId: "c1" })],
    reviews: [],
  });
  const observations = fromStore.filter((e) => e.kind === "observation");
  assert.ok(observations.length > 0);
  assert.ok(observations.every((o) => o.kind === "observation" && o.origin === "agent_authored"),
    "the storage adapter must never stamp externally_observed");
});

/* ---- purity ---- */

test("external: the reader does no I/O of its own (git is injected)", () => {
  const src = fs.readFileSync(new URL("../src/harness/external-evidence.ts", import.meta.url), "utf8");
  assert.equal(/from\s+["']node:fs["']/.test(src), false, "no filesystem");
  assert.equal(/from\s+["']node:child_process["']/.test(src), false, "no spawn - git is injected by the command");
  assert.equal(/from\s+["'].*\/store["']/.test(src), false, "no store");
});
