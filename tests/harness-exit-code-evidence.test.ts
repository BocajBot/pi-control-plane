/**
 * Phase 4.2 follow-up §A - exit_code external-evidence source + run-id join.
 *
 * An exit code is the direct, OS-reported result of a command the harness ran,
 * tied to a decision by a harness-minted run id. These tests hold: the join runs
 * only on harness-written fields (a model-fabricated run id cannot attach), the
 * evidence is bidirectional (exit 0 confirms, nonzero refutes - unlike file_diff),
 * an unattributable execution is dropped, and when it disagrees with the agent's
 * self-report the external witness wins (§B).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";

import {
  readExitCodeEvidence,
  type ExecutionRecord,
} from "../src/harness/external-evidence.ts";
import { extractExecutionRecords } from "../src/harness/decision-evaluation-adapter.ts";
import { evaluate, type DecisionClaim, type DecisionObservation } from "../src/harness/decision-evaluation.ts";
import type { AuditEvent } from "../src/harness/types.ts";

function claim(over: Partial<DecisionClaim> & { decisionId: string }): DecisionClaim {
  return {
    kind: "claim", eventId: `ev-${over.decisionId}`, at: "2026-02-01T00:00:00.000Z",
    action: "delegate", category: "c", rule: "r", claimedOutcome: "completed", ...over,
  };
}
function rec(over: Partial<ExecutionRecord> & { decisionId: string | null }): ExecutionRecord {
  return { runId: "run_aaaa", exitCode: 0, at: "2026-02-01T00:01:00.000Z", ...over };
}
function shellExec(meta: Record<string, unknown>, id = "e1", ts = "2026-02-01T00:01:00.000Z"): AuditEvent {
  return { id, timestamp: ts, eventType: "shell_exec", metadata: meta } as unknown as AuditEvent;
}

/* ---- bidirectional: exit 0 confirms, nonzero refutes ---- */

test("exit_code: exit 0 is success evidence (confirms a claimed success -> match)", () => {
  const c = claim({ decisionId: "d1", claimedOutcome: "completed" });
  const obs = readExitCodeEvidence([c], [rec({ decisionId: "d1", exitCode: 0 })]);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].source, "exit_code");
  assert.equal(obs[0].origin, "externally_observed");
  assert.equal(obs[0].success, true);
  const report = evaluate({ evidence: [c, ...obs], chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.decisions[0].verdict, "match");
  assert.equal(report.coverage.externallyCorroborated, 1);
});

test("exit_code: a nonzero exit refutes a claimed success -> mismatch", () => {
  const c = claim({ decisionId: "d1", claimedOutcome: "completed" });
  const obs = readExitCodeEvidence([c], [rec({ decisionId: "d1", exitCode: 1 })]);
  assert.equal(obs[0].success, false);
  const report = evaluate({ evidence: [c, ...obs], chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.decisions[0].verdict, "mismatch");
});

test("exit_code: exit 0 CONTRADICTS a claimed failure (bidirectional, unlike file_diff)", () => {
  const c = claim({ decisionId: "d1", claimedOutcome: "failed" });
  const obs = readExitCodeEvidence([c], [rec({ decisionId: "d1", exitCode: 0 })]);
  const report = evaluate({ evidence: [c, ...obs], chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.decisions[0].verdict, "mismatch", "claimed failed but the command exited 0");
});

test("exit_code+§B: an external exit outranks an agent-authored success self-report", () => {
  const c = claim({ decisionId: "d1", claimedOutcome: "completed" });
  const agentObs: DecisionObservation = {
    kind: "observation", source: "delegate_runtime", origin: "agent_authored",
    refId: "d1", at: "2026-02-01T00:00:30.000Z", decisionId: "d1", observedOutcome: "completed", success: true,
  };
  const obs = readExitCodeEvidence([c], [rec({ decisionId: "d1", exitCode: 2 })]);
  const report = evaluate({ evidence: [c, agentObs, ...obs], chain: { ok: true, verifiedPrefix: 1, total: 1 } });
  assert.equal(report.decisions[0].verdict, "mismatch");
  assert.equal(report.decisions[0].observedEvidence?.source, "exit_code");
});

/* ---- join direction: only attributable, harness-identified executions ---- */

test("exit_code: an execution with a null decisionId does not join (not attributable)", () => {
  assert.deepEqual(readExitCodeEvidence([claim({ decisionId: "d1" })], [rec({ decisionId: null })]), []);
});

test("exit_code: an execution for an unknown decision does not join", () => {
  assert.deepEqual(readExitCodeEvidence([claim({ decisionId: "d1" })], [rec({ decisionId: "other" })]), []);
});

test("exit_code: a record with no runId is dropped (no harness identity)", () => {
  assert.deepEqual(readExitCodeEvidence([claim({ decisionId: "d1" })], [rec({ decisionId: "d1", runId: "" })]), []);
});

test("exit_code: latest execution per decision wins by intrinsic (at, runId)", () => {
  const c = claim({ decisionId: "d1", claimedOutcome: "completed" });
  const early = rec({ decisionId: "d1", runId: "run_a", exitCode: 0, at: "2026-02-01T00:01:00.000Z" });
  const late = rec({ decisionId: "d1", runId: "run_b", exitCode: 1, at: "2026-02-01T00:09:00.000Z" });
  const one = readExitCodeEvidence([c], [early, late]);
  const two = readExitCodeEvidence([c], [late, early]);
  assert.deepEqual(one, two, "order-independent");
  assert.equal(one[0].observedOutcome, "exit 1", "the later execution stands");
});

/* ---- forgery: the join reads only harness-written shell_exec fields ---- */

test("exit_code: extractExecutionRecords reads only shell_exec metadata, not model text", () => {
  const records = extractExecutionRecords([
    shellExec({ runId: "run_real", exitCode: 0, decisionId: "d1" }),
    shellExec({ mounts: [] }, "e-noid"),                        // no runId -> skipped
    shellExec({ runId: "run_x", exitCode: "0", decisionId: "d1" }, "e-badcode"), // exitCode not a number -> skipped
    { id: "e2", timestamp: "t", eventType: "decision_telemetry",
      metadata: { runId: "run_fake", exitCode: 0, decisionId: "d1" } } as unknown as AuditEvent, // not shell_exec -> ignored
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, "run_real");
});

test("exit_code: a model-fabricated run id has no execution record, so it cannot attach", () => {
  // The model can only ever write into its own telemetry, never a shell_exec
  // line. The reader joins against execution records extracted from shell_exec
  // events; a fabricated id resolves to none.
  const audit = [
    shellExec({ runId: "run_genuine", exitCode: 1, decisionId: "d1" }),
  ];
  const records = extractExecutionRecords(audit);
  // Suppose a decision claims success and (hypothetically) tried to point at a
  // fake run id - it is irrelevant: the join is by decisionId over real records.
  const obs = readExitCodeEvidence([claim({ decisionId: "d1", claimedOutcome: "completed" })], records);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].refId, "run_genuine", "only the genuine harness-written execution is used");
  assert.equal(obs[0].success, false);
  // A decision with no genuine execution gets nothing, no matter what it claims.
  assert.deepEqual(readExitCodeEvidence([claim({ decisionId: "d-nofake" })], records), []);
});

/* ---- purity ---- */

test("exit_code: the reader does its own I/O nowhere", () => {
  const src = fs.readFileSync(new URL("../src/harness/external-evidence.ts", import.meta.url), "utf8");
  assert.equal(/from\s+["']node:fs["']/.test(src), false);
  assert.equal(/from\s+["']node:child_process["']/.test(src), false);
  assert.equal(/from\s+["'].*\/store["']/.test(src), false);
});
