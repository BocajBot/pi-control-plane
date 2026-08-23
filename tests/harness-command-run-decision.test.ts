/**
 * Phase 4.2 §A - the command_run decision class that makes the exit_code seam
 * live.
 *
 * command_run records an already-authorized coordinator command (a
 * validation/build/test check) through the 4.1 telemetry allowlist - no new
 * authority. These tests hold: it is a recordable important action, the evaluator
 * treats it as supported, and a command_run decision joined to a real exit code
 * by decisionId produces an externally-corroborated verdict (both directions).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDecisionTelemetry, IMPORTANT_DECISION_ACTIONS } from "../src/harness/decision-telemetry.ts";
import { readExitCodeEvidence, type ExecutionRecord } from "../src/harness/external-evidence.ts";
import { evaluate, type DecisionClaim } from "../src/harness/decision-evaluation.ts";

function claim(over: Partial<DecisionClaim> & { decisionId: string }): DecisionClaim {
  return {
    kind: "claim", eventId: `ev-${over.decisionId}`, at: "2026-02-01T00:00:00.000Z",
    action: "command_run", category: "command_execution", rule: "coordinator_validation",
    claimedOutcome: "completed", ...over,
  };
}
const exec = (decisionId: string, exitCode: number): ExecutionRecord =>
  ({ runId: `run_${decisionId}`, decisionId, exitCode, at: "2026-02-01T00:01:00.000Z" });

test("command_run: is an important, recordable decision action", () => {
  assert.ok((IMPORTANT_DECISION_ACTIONS as readonly string[]).includes("command_run"));
  const rec = buildDecisionTelemetry({ decisionId: "dec_1", action: "command_run", outcome: { status: "completed" } });
  assert.notEqual(rec, null);
  assert.equal(rec?.action, "command_run");
});

test("command_run: the evaluator treats it as supported (measurable), not unsupported", () => {
  const c = claim({ decisionId: "dec_1", claimedOutcome: "completed" });
  const obs = readExitCodeEvidence([c], [exec("dec_1", 0)]);
  const report = evaluate({ evidence: [c, ...obs], chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.coverage.unsupported, 0);
  assert.equal(report.coverage.measured, 1);
});

test("command_run + exit 0: claimed success confirmed by the real exit code (match, externally corroborated)", () => {
  const c = claim({ decisionId: "dec_ok", claimedOutcome: "completed" });
  const obs = readExitCodeEvidence([c], [exec("dec_ok", 0)]);
  const report = evaluate({ evidence: [c, ...obs], chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.decisions[0].verdict, "match");
  assert.equal(report.decisions[0].observedEvidence?.origin, "externally_observed");
  assert.equal(report.decisions[0].observedEvidence?.source, "exit_code");
  assert.equal(report.coverage.externallyCorroborated, 1);
});

test("command_run + nonzero exit: a claimed success the command refutes (mismatch)", () => {
  const c = claim({ decisionId: "dec_bad", claimedOutcome: "completed" });
  const obs = readExitCodeEvidence([c], [exec("dec_bad", 1)]);
  const report = evaluate({ evidence: [c, ...obs], chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.decisions[0].verdict, "mismatch");
  assert.equal(report.coverage.externallyCorroborated, 1, "still externally corroborated - the witness spoke");
});

test("command_run: a claimed failure (expect_success false) contradicted by exit 0 is a mismatch", () => {
  const c = claim({ decisionId: "dec_f", claimedOutcome: "failed" });
  const obs = readExitCodeEvidence([c], [exec("dec_f", 0)]);
  const report = evaluate({ evidence: [c, ...obs], chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.decisions[0].verdict, "mismatch");
});
