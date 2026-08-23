/**
 * Phase 4.2 - evidence adapter (4.2.2).
 *
 * The adapter is the single place that knows both the store's record shapes and
 * the evaluator's evidence vocabulary. These tests hold the separation the
 * design requires: the adapter converts audit/delegation/review records into
 * evidence (owning all storage knowledge), and the evaluator, fed that
 * evidence, produces the same verdicts it does for synthetic input - proving it
 * never learned anything about storage.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";

import { toEvidence, chainTrust } from "../src/harness/decision-evaluation-adapter.ts";
import { evaluate } from "../src/harness/decision-evaluation.ts";
import type { AuditEvent, DelegationJobRecord, ReviewGeneration, AuditChainVerification } from "../src/harness/types.ts";

/* minimal record builders - only the fields the adapter reads */

function telemetryEvent(decision: Record<string, unknown>, id = "ev1", ts = "2026-02-01T00:00:00.000Z"): AuditEvent {
  return { id, timestamp: ts, eventType: "decision_telemetry", metadata: { decision } } as unknown as AuditEvent;
}
function job(over: Partial<DelegationJobRecord> & { contractId: string; status: DelegationJobRecord["status"] }): DelegationJobRecord {
  return {
    id: over.id ?? over.contractId,
    contractId: over.contractId,
    status: over.status,
    at: over.at ?? "2026-02-01T00:05:00.000Z",
  } as unknown as DelegationJobRecord;
}
function review(over: { sessionId: string; generation: number; accepted: boolean; reviewProduced?: boolean }): ReviewGeneration {
  return {
    sessionId: over.sessionId,
    generation: over.generation,
    createdAt: "2026-02-01T00:06:00.000Z",
    acceptance: { accepted: over.accepted, reviewProduced: over.reviewProduced ?? over.accepted },
  } as unknown as ReviewGeneration;
}

/* ---- claim mapping ---- */

test("adapter: a decision_telemetry event becomes a claim with its bounded fields", () => {
  const ev = toEvidence({
    audit: [telemetryEvent({
      decisionId: "c1", action: "delegate", category: "subagent_delegation",
      rule: "bounded_read_only_delegation", outcome: { status: "completed" },
    })],
    delegations: [],
    reviews: [],
  });
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], {
    kind: "claim", eventId: "ev1", at: "2026-02-01T00:00:00.000Z",
    decisionId: "c1", action: "delegate", category: "subagent_delegation",
    rule: "bounded_read_only_delegation", claimedOutcome: "completed",
  });
});

test("adapter: non-telemetry audit events are ignored", () => {
  const ev = toEvidence({
    audit: [{ id: "a", timestamp: "t", eventType: "delegation", metadata: {} } as unknown as AuditEvent],
    delegations: [], reviews: [],
  });
  assert.deepEqual(ev, []);
});

test("adapter: malformed telemetry (no decisionId/action) is dropped, not turned into a bogus claim", () => {
  const ev = toEvidence({
    audit: [
      telemetryEvent({ action: "delegate", outcome: { status: "completed" } }, "ev-noid"),
      telemetryEvent({ decisionId: "c2", outcome: { status: "completed" } }, "ev-noaction"),
      telemetryEvent("not an object" as unknown as Record<string, unknown>, "ev-junk"),
    ],
    delegations: [], reviews: [],
  });
  assert.deepEqual(ev, []);
});

/* ---- observation mapping ---- */

test("adapter: a completed delegation is a clean observation; every other status is not", () => {
  const ev = toEvidence({
    audit: [],
    delegations: [
      job({ contractId: "c1", status: "completed" }),
      job({ contractId: "c2", status: "aborted" }),
      job({ contractId: "c3", status: "blocked" }),
      job({ contractId: "c4", status: "denied" }),
      job({ contractId: "c5", status: "orphaned" }),
      job({ contractId: "c6", status: "running" }),
    ],
    reviews: [],
  });
  const bySuccess = Object.fromEntries(ev.map((e) => [e.kind === "observation" ? e.decisionId : "", e.kind === "observation" && e.success]));
  assert.equal(bySuccess["c1"], true);
  for (const id of ["c2", "c3", "c4", "c5", "c6"]) assert.equal(bySuccess[id], false, `${id} must not read as success`);
});

test("adapter: a review becomes a review-sourced observation keyed by session", () => {
  const ev = toEvidence({ audit: [], delegations: [], reviews: [review({ sessionId: "ses_1", generation: 2, accepted: true })] });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "observation");
  if (ev[0].kind === "observation") {
    assert.equal(ev[0].source, "review");
    assert.equal(ev[0].decisionId, "ses_1");
    assert.equal(ev[0].refId, "ses_1#2");
    assert.equal(ev[0].success, true);
  }
});

test("adapter: an accepted-but-empty review is not a success (reviewProduced gates it)", () => {
  const ev = toEvidence({ audit: [], delegations: [], reviews: [review({ sessionId: "s", generation: 1, accepted: true, reviewProduced: false })] });
  assert.equal(ev[0].kind === "observation" && ev[0].success, false);
});

/* ---- chain trust projection ---- */

test("adapter: chainTrust projects verifiedCount into verifiedPrefix", () => {
  const v = { ok: false, verifiedCount: 4 } as unknown as AuditChainVerification;
  assert.deepEqual(chainTrust(v, 7), { ok: false, verifiedPrefix: 4, total: 7 });
});

/* ---- end-to-end: real record shapes -> evaluator, over the wired seam ---- */

test("adapter+eval: a telemetry 'completed' contradicted by an aborted delegation job is a MISMATCH", () => {
  // The discriminating case at the level of actual store record shapes: the
  // evaluator must grade against the delegation job, not the telemetry claim.
  const evidence = toEvidence({
    audit: [telemetryEvent({ decisionId: "c1", action: "delegate", outcome: { status: "completed" } })],
    delegations: [
      job({ contractId: "c1", status: "running", at: "2026-02-01T00:04:00.000Z" }),
      job({ contractId: "c1", status: "aborted", at: "2026-02-01T00:07:00.000Z" }),
    ],
    reviews: [],
  });
  const report = evaluate({ evidence, chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.decisions.length, 1);
  assert.equal(report.decisions[0].verdict, "mismatch");
  assert.equal(report.decisions[0].observedEvidence?.outcome, "aborted", "latest job status is the evidence");
  assert.equal(report.coverage.measured, 1);
});

test("adapter+eval: a telemetry 'completed' confirmed by a completed job is a MATCH", () => {
  const evidence = toEvidence({
    audit: [telemetryEvent({ decisionId: "c1", action: "delegate", outcome: { status: "completed" } })],
    delegations: [job({ contractId: "c1", status: "completed" })],
    reviews: [],
  });
  const report = evaluate({ evidence, chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.decisions[0].verdict, "match");
});

/* ---- purity: adapter performs no I/O of its own ---- */

test("adapter: performs no filesystem I/O itself (the command reads the store)", () => {
  const src = fs.readFileSync(new URL("../src/harness/decision-evaluation-adapter.ts", import.meta.url), "utf8");
  assert.equal(/from\s+["']node:fs["']/.test(src), false, "adapter must not read the filesystem directly");
  assert.equal(/from\s+["'].*\/store["']/.test(src), false, "adapter takes records, it does not open the store");
});
