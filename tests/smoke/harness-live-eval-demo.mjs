// Phase 4 LIVE end-to-end demonstration - the first externally-corroborated
// verdicts in the project's history, on reality rather than fixtures.
//
// This drives the SAME pipeline /harness-eval uses (toEvidence +
// extractExecutionRecords + readExitCodeEvidence + evaluate) over a REAL
// HarnessStore with a REAL hash-chained audit log, and the exit codes come from
// REAL child processes actually run here - not hand-written numbers.
//
// Two decisions are recorded as command_run (the class that makes the exit_code
// seam live), each stamping its decisionId onto the shell_exec execution record
// so the run-id join closes:
//   POSITIVE  - claims success, the command really exits 0  -> MATCH (externally corroborated)
//   NEGATIVE  - claims success but the command really exits 1 -> MISMATCH (refuted)
// The NEGATIVE claim is deliberate false test input and is labelled as such in
// the record text.
//
//   node tests/smoke/harness-live-eval-demo.mjs
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { harnessPaths } from "../../src/harness/config.ts";
import { HarnessStore } from "../../src/harness/store.ts";
import { makeAuditEvent } from "../../src/harness/audit.ts";
import { createScope } from "../../src/harness/scope.ts";
import { makeId } from "../../src/harness/util.ts";
import { buildDecisionTelemetry } from "../../src/harness/decision-telemetry.ts";
import { toEvidence, extractExecutionRecords, chainTrust } from "../../src/harness/decision-evaluation-adapter.ts";
import { readExitCodeEvidence } from "../../src/harness/external-evidence.ts";
import { evaluate } from "../../src/harness/decision-evaluation.ts";

// Durable scratch (never /tmp): the store is throwaway but the rule stands.
const work = fs.mkdtempSync(path.join(os.homedir(), "pi-harness-work-livedemo-"));
const home = path.join(work, "home");
const projectRoot = path.join(work, "proj");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });

const paths = harnessPaths(home, projectRoot, {});
const store = new HarnessStore(paths);

const session = makeId("session");
const model = { provider: "llama-swap", model: "coordinator-demo" };
const scope = createScope(projectRoot, "user", { home });
const coordinatorCtx = { session, actor: "coordinator", actorModel: model, scope };

// Record a command_run decision (the CLAIM) exactly as the harness_bash tool
// does, then actually run the command and record the shell_exec execution record
// (the EVIDENCE) with the same decisionId.
function recordCommandRun({ command, claimSuccess, node, label }) {
  const decisionId = makeId("decision");
  const decision = buildDecisionTelemetry({
    decisionId,
    action: "command_run",
    category: "command_execution",
    rule: "coordinator_validation",
    outcome: { status: claimSuccess ? "completed" : "failed" },
  });
  store.appendAudit(makeAuditEvent(coordinatorCtx, {
    eventType: "decision_telemetry",
    request: label,
    result: decision.outcome.status,
    metadata: { decision },
  }));

  // REAL execution - the exit code is not authored, it is observed.
  const proc = spawnSync(process.execPath, node, { encoding: "utf8" });
  const exitCode = proc.status ?? 0;

  store.appendAudit(makeAuditEvent(coordinatorCtx, {
    eventType: "shell_exec",
    request: command,
    result: `exit ${exitCode}`,
    metadata: { runId: makeId("run"), exitCode, decisionId },
  }));
  return { decisionId, exitCode };
}

const positive = recordCommandRun({
  command: "node --version",
  claimSuccess: true,
  node: ["--version"],
  label: "command_run: validate node is available (real check)",
});
const negative = recordCommandRun({
  command: "node -e 'process.exit(1)'",
  claimSuccess: true,                       // deliberate FALSE success claim
  node: ["-e", "process.exit(1)"],
  label: "TEST INPUT (deliberate false success claim): command_run expected to pass but fails",
});

// ---- the /harness-eval pipeline, verbatim ----
const auditRead = store.readAudit();
const verification = store.verifyAudit();
const evidence = toEvidence({ audit: auditRead.records, delegations: store.readDelegations().records, reviews: [] });
const claims = evidence.filter((e) => e.kind === "claim");
const exitCodes = readExitCodeEvidence(claims, extractExecutionRecords(auditRead.records));
const report = evaluate({
  evidence: [...evidence, ...exitCodes],
  chain: chainTrust(verification, auditRead.records.length),
});

// ---- report ----
console.log("=== LIVE /harness-eval over real records ===");
console.log(`audit chain: ok=${report.provenance.chainOk} verified=${report.provenance.verifiedPrefix}/${report.provenance.totalRecords}`);
const c = report.coverage;
console.log(`coverage: observed=${c.decisionsObserved} measured=${c.measured} externallyCorroborated=${c.externallyCorroborated} agentAuthoredOnly=${c.agentAuthoredOnly}`);
console.log("decisions:");
for (const d of report.decisions) {
  const e = d.observedEvidence;
  console.log(`  ${d.decisionId} [${d.action}] verdict=${d.verdict.toUpperCase()}`);
  console.log(`    claim=${d.telemetryClaim?.outcome}  evidence=${e ? `${e.source}/${e.origin} ${e.outcome}` : "(none)"}`);
  console.log(`    ${d.verdictReason}`);
}

// ---- assertions: this must be the real thing ----
const errs = [];
if (report.provenance.chainOk !== true) errs.push("audit chain did not verify");
if (positive.exitCode !== 0) errs.push(`positive command did not exit 0 (got ${positive.exitCode})`);
if (negative.exitCode === 0) errs.push("negative command unexpectedly exited 0");
if (c.externallyCorroborated < 1) errs.push("no externally corroborated verdict");
const byId = Object.fromEntries(report.decisions.map((d) => [d.decisionId, d]));
if (byId[positive.decisionId]?.verdict !== "match") errs.push("positive decision is not a MATCH");
if (byId[positive.decisionId]?.observedEvidence?.origin !== "externally_observed") errs.push("positive verdict not externally observed");
if (byId[positive.decisionId]?.observedEvidence?.source !== "exit_code") errs.push("positive verdict not from exit_code");
if (byId[negative.decisionId]?.verdict !== "mismatch") errs.push("negative decision is not a MISMATCH");

fs.rmSync(work, { recursive: true, force: true });

if (errs.length > 0) {
  console.log("\nFAIL:\n  " + errs.join("\n  "));
  process.exit(1);
}
console.log("\nPASS: first externally-corroborated MATCH and a refuted MISMATCH, on real exit codes.");
process.exit(0);
