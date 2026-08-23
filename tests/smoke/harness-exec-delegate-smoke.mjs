// Exec-capable delegate (operator) LIVE proof - a delegated, scope-bounded
// command run for real, producing a live externally-corroborated verdict through
// the exact /harness-eval pipeline.
//
// This drives the SAME execution shape the operator's injected exec path uses in
// extensions/pi-harness.ts (planSandbox with the OPERATOR's own narrowed scope ->
// real bwrap-wrapped command -> command_run decision_telemetry + shell_exec audit
// carrying {runId, exitCode, decisionId}, all attributed to the `operator` actor),
// then evaluates it verbatim. The exit codes come from REAL child processes and
// the sandbox is REAL bwrap - not hand-written numbers.
//
// It proves, on reality:
//   POSITIVE   - a command inside scope that exits 0        -> MATCH (externally corroborated)
//   NEGATIVE   - a command claiming success but exiting 1   -> MISMATCH (refuted by exit code)
//   CONFINED   - a write aimed OUTSIDE the operator's scope -> fails; the file never appears (E5)
//   REFUSED    - when bwrap is unavailable, planSandbox refuses and the refusal is audited (E2)
//
//   node tests/smoke/harness-exec-delegate-smoke.mjs
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaultConfig, harnessPaths } from "../../src/harness/config.ts";
import { HarnessStore } from "../../src/harness/store.ts";
import { makeAuditEvent } from "../../src/harness/audit.ts";
import { createScope } from "../../src/harness/scope.ts";
import { plan as planSandbox } from "../../src/harness/sandbox.ts";
import { makeId } from "../../src/harness/util.ts";
import { buildDecisionTelemetry } from "../../src/harness/decision-telemetry.ts";
import { toEvidence, extractExecutionRecords, chainTrust } from "../../src/harness/decision-evaluation-adapter.ts";
import { readExitCodeEvidence } from "../../src/harness/external-evidence.ts";
import { evaluate } from "../../src/harness/decision-evaluation.ts";

// Durable scratch (never /tmp): the store is throwaway but the rule stands.
const work = fs.mkdtempSync(path.join(os.homedir(), "pi-harness-work-execdelegate-"));
const home = path.join(work, "home");
// The operator's scope root is a SUBDIRECTORY of the project - a real
// narrowing. Its parent (the project root) is deliberately outside the
// operator's scope, so a write aimed there must be confined.
const projectRoot = path.join(work, "proj");
const operatorRoot = path.join(projectRoot, "operator-scope");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(operatorRoot, { recursive: true });

const paths = harnessPaths(home, projectRoot, {});
const store = new HarnessStore(paths);

// Real runtime mounts, or planSandbox correctly refuses ("no runtime mounts").
const config = {
  ...defaultConfig(),
  sandboxReadOnlyPaths: ["/usr", "/bin", "/lib", "/lib64", "/etc"].filter((p) => fs.existsSync(p)),
};

const bwrapAvailable = (() => {
  try {
    return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

const opScope = createScope(operatorRoot, "user", { home });
const model = { provider: "llama-swap", model: "operator-demo" };
// The audit context is the OPERATOR's - the exec is attributed to it, never
// relabeled coordinator, exactly as the injected exec path does.
const operatorCtx = { session: makeId("session"), actor: "operator", actorModel: model, scope: opScope };

// A faithful copy of the operator exec path (execRuntime.run in pi-harness.ts):
// plan against the operator's OWN scope, refuse+audit if out of scope or no
// sandbox, else record the claim before the exit code is known, run under the
// sandbox, and write one shell_exec line carrying the join fields.
function operatorExec({ command, claimSuccess, label }) {
  const outcome = planSandbox(command, opScope, config, opScope.root, {
    bwrapAvailable: () => bwrapAvailable,
    exists: (p) => fs.existsSync(p),
  });
  if (!outcome.ok) {
    store.appendAudit(makeAuditEvent(operatorCtx, {
      eventType: "shell_exec", request: command, result: `refused: ${outcome.reason}`, metadata: {},
    }));
    return { refused: true, reason: outcome.reason };
  }
  const decisionId = makeId("decision");
  const decision = buildDecisionTelemetry({
    decisionId, action: "command_run", category: "command_execution",
    rule: "operator_delegated_exec", outcome: { status: claimSuccess ? "completed" : "failed" },
  });
  store.appendAudit(makeAuditEvent(operatorCtx, {
    eventType: "decision_telemetry", request: label, result: decision.outcome.status, metadata: { decision },
  }));
  // REAL execution under REAL bwrap - the exit code is observed, not authored.
  const proc = spawnSync("/bin/sh", ["-c", outcome.command], { encoding: "utf8" });
  const exitCode = proc.status ?? 0;
  store.appendAudit(makeAuditEvent(operatorCtx, {
    eventType: "shell_exec", request: command, result: `exit ${exitCode}`,
    metadata: { runId: makeId("run"), exitCode, decisionId },
  }));
  return { refused: false, decisionId, exitCode };
}

const errs = [];

if (!bwrapAvailable) {
  // Honest degraded proof: without bwrap, planSandbox refuses and the refusal
  // is audited. The live-verdict half of the deliverable needs a sandbox.
  const r = operatorExec({ command: "echo hi", claimSuccess: true, label: "operator: refused (no bwrap)" });
  console.log("bwrap unavailable - demonstrating the refusal path only.");
  if (!r.refused) errs.push("expected a refusal when bwrap is unavailable");
  const audit = store.readAudit().records;
  if (!audit.some((e) => e.eventType === "shell_exec" && String(e.result).startsWith("refused:")))
    errs.push("the refusal was not audited");
  fs.rmSync(work, { recursive: true, force: true });
  finish(errs, true);
}

// POSITIVE: write a file INSIDE scope and exit 0.
const positive = operatorExec({
  command: "echo inside > inscope.txt && test -f inscope.txt",
  claimSuccess: true,
  label: "operator: write inside scope (real check)",
});
const wroteInside = fs.existsSync(path.join(operatorRoot, "inscope.txt"));

// NEGATIVE: claim success, really exit 1.
const negative = operatorExec({
  command: "exit 1",
  claimSuccess: true, // deliberate FALSE success claim (test input)
  label: "TEST INPUT (deliberate false success): operator command expected to pass but fails",
});

// CONFINED: try to write to the parent (outside the operator's scope). bwrap
// makes only the scope root writable, so the write fails and the file never
// appears at the parent.
const outsidePath = path.join(projectRoot, "outside.txt");
const confined = operatorExec({
  command: `echo escaped > ${outsidePath}`,
  claimSuccess: true,
  label: "operator: write OUTSIDE scope (must be confined)",
});
const outsideAppeared = fs.existsSync(outsidePath);

// ---- the /harness-eval pipeline, verbatim ----
const auditRead = store.readAudit();
const verification = store.verifyAudit();
const evidence = toEvidence({ audit: auditRead.records, delegations: store.readDelegations().records, reviews: [] });
const claims = evidence.filter((e) => e.kind === "claim");
const exitCodes = readExitCodeEvidence(claims, extractExecutionRecords(auditRead.records));
const report = evaluate({ evidence: [...evidence, ...exitCodes], chain: chainTrust(verification, auditRead.records.length) });
const byId = Object.fromEntries(report.decisions.map((d) => [d.decisionId, d]));

// ---- report ----
console.log("=== LIVE operator /harness-eval over real records ===");
console.log(`audit chain: ok=${report.provenance.chainOk} verified=${report.provenance.verifiedPrefix}/${report.provenance.totalRecords}`);
const c = report.coverage;
console.log(`coverage: observed=${c.decisionsObserved} measured=${c.measured} externallyCorroborated=${c.externallyCorroborated}`);
console.log(`positive: exit=${positive.exitCode} wroteInsideScope=${wroteInside}`);
console.log(`confined: exit=${confined.exitCode} escapedFileAppearedOutside=${outsideAppeared}`);
for (const d of report.decisions) {
  const e = d.observedEvidence;
  console.log(`  ${d.decisionId} [${d.action}] verdict=${d.verdict.toUpperCase()} claim=${d.telemetryClaim?.outcome} evidence=${e ? `${e.source}/${e.origin} ${e.outcome}` : "(none)"}`);
}

// ---- assertions: this must be the real thing ----
if (report.provenance.chainOk !== true) errs.push("operator audit chain did not verify");
if (positive.exitCode !== 0) errs.push(`positive command did not exit 0 (got ${positive.exitCode})`);
if (!wroteInside) errs.push("operator could not write inside its own scope");
if (negative.exitCode === 0) errs.push("negative command unexpectedly exited 0");
if (outsideAppeared) errs.push("CONFINEMENT BREACH: operator wrote outside its scope root");
if (c.externallyCorroborated < 1) errs.push("no externally corroborated verdict");
if (byId[positive.decisionId]?.verdict !== "match") errs.push("positive decision is not a MATCH");
if (byId[positive.decisionId]?.observedEvidence?.origin !== "externally_observed") errs.push("positive verdict not externally observed");
if (byId[positive.decisionId]?.observedEvidence?.source !== "exit_code") errs.push("positive verdict not from exit_code");
if (byId[negative.decisionId]?.verdict !== "mismatch") errs.push("negative decision is not a MISMATCH");

fs.rmSync(work, { recursive: true, force: true });
finish(errs, false);

function finish(errs, degraded) {
  if (errs.length > 0) {
    console.log("\nFAIL:\n  " + errs.join("\n  "));
    process.exit(1);
  }
  console.log(degraded
    ? "\nPASS (degraded, no bwrap): an out-of-sandbox operator command is refused and audited."
    : "\nPASS: a delegated operator command ran under a real sandbox, was confined to its scope, and produced a live externally-corroborated MATCH and a refuted MISMATCH.");
  process.exit(0);
}
