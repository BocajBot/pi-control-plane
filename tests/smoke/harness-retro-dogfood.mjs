// Phase 4.4 retrospective - DOGFOOD, not ceremony.
//
// The retrospective of Phase 4 is run through Phase 4's own machinery: it
// records the phase's real decision classes (a delegation, a coordinator
// command_run, an operator command_run) into a real hash-chained store with
// REAL child-process exit codes, then runs the exact /harness-eval and
// /harness-propose pipelines over them. The harness evaluates its own decisions
// and drafts its own improvement proposals - no hand-written verdicts, no
// asserted numbers. Whatever this prints is what the layer says about itself.
//
//   node tests/smoke/harness-retro-dogfood.mjs
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { harnessPaths } from "../../src/harness/config.ts";
import { HarnessStore } from "../../src/harness/store.ts";
import { makeAuditEvent } from "../../src/harness/audit.ts";
import { createScope } from "../../src/harness/scope.ts";
import { makeId } from "../../src/harness/util.ts";
import { makeDelegationJob } from "../../src/harness/delegation-jobs.ts";
import { buildDecisionTelemetry } from "../../src/harness/decision-telemetry.ts";
import { toEvidence, extractExecutionRecords, chainTrust } from "../../src/harness/decision-evaluation-adapter.ts";
import { readExitCodeEvidence } from "../../src/harness/external-evidence.ts";
import { evaluate } from "../../src/harness/decision-evaluation.ts";
import { generateProposals } from "../../src/harness/decision-proposal.ts";

const work = fs.mkdtempSync(path.join(os.homedir(), "pi-harness-work-retro-"));
const home = path.join(work, "home");
const projectRoot = path.join(work, "proj");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(projectRoot, { recursive: true });
const store = new HarnessStore(harnessPaths(home, projectRoot, {}));

const session = makeId("session");
const scope = createScope(projectRoot, "user", { home });
function ctx(actor) {
  return { session, actor, actorModel: { provider: "llama-swap", model: `${actor}-retro` }, scope };
}

// A command_run decision (the CLAIM), then a real run, then the shell_exec
// execution record (the EVIDENCE) with the same decisionId - attributed to the
// given actor, exactly as the coordinator and operator paths do.
function commandRun(actor, { claimSuccess, node, label }) {
  const decisionId = makeId("decision");
  const decision = buildDecisionTelemetry({
    decisionId, action: "command_run", category: "command_execution",
    rule: actor === "operator" ? "operator_delegated_exec" : "coordinator_validation",
    outcome: { status: claimSuccess ? "completed" : "failed" },
  });
  store.appendAudit(makeAuditEvent(ctx(actor), { eventType: "decision_telemetry", request: label, result: decision.outcome.status, metadata: { decision } }));
  const exitCode = spawnSync(process.execPath, node, { encoding: "utf8" }).status ?? 0;
  store.appendAudit(makeAuditEvent(ctx(actor), { eventType: "shell_exec", request: label, result: `exit ${exitCode}`, metadata: { runId: makeId("run"), exitCode, decisionId } }));
  return decisionId;
}

// 1) A delegation decision (the phase's read-only delegation class), recorded and
//    given a job record - the record kind /harness-eval reads for delegations.
const delegationId = makeId("delegation");
store.appendAudit(makeAuditEvent(ctx("coordinator"), {
  eventType: "decision_telemetry", request: "delegate: map the retry paths",
  result: "completed",
  metadata: { decision: buildDecisionTelemetry({ decisionId: delegationId, action: "delegate", category: "subagent_delegation", rule: "bounded_read_only_delegation", outcome: { status: "completed" } }) },
}));
store.appendDelegation(makeDelegationJob(
  { id: delegationId, kind: "subagent", objective: "map the retry paths", scope, allowedCapabilities: ["scoped_read"], autonomy: "autonomous", approvalPolicy: "consequential", parentSession: session, parentActor: "coordinator", createdAt: "2026-08-23T00:00:00.000Z", schemaVersion: 2, contextPackage: [], expectedOutput: "x", escalationBehavior: "x" },
  { status: "completed", detail: "handoff returned" },
));

// 2) A coordinator command_run that really passes, and 3) an operator
//    command_run that claims success but really fails - the harness must catch
//    the second by its exit code, which is exactly the case a retrospective
//    should surface.
const coordOk = commandRun("coordinator", { claimSuccess: true, node: ["--version"], label: "coordinator: validate toolchain (real)" });
const operatorBad = commandRun("operator", { claimSuccess: true, node: ["-e", "process.exit(1)"], label: "operator: claimed pass, really fails (retro test input)" });

// ---- /harness-eval, verbatim ----
const auditRead = store.readAudit();
const verification = store.verifyAudit();
const evidence = toEvidence({ audit: auditRead.records, delegations: store.readDelegations().records, reviews: [] });
const claims = evidence.filter((e) => e.kind === "claim");
const exitCodes = readExitCodeEvidence(claims, extractExecutionRecords(auditRead.records));
const report = evaluate({ evidence: [...evidence, ...exitCodes], chain: chainTrust(verification, auditRead.records.length) });

// ---- /harness-propose, verbatim (generation only) ----
const proposals = generateProposals(report, { model: { provider: "llama-swap", model: "coordinator-retro" }, proposedAt: "2026-08-23T00:00:00.000Z" });

// ---- report ----
console.log("=== Phase 4.4 retrospective: the harness over its own Phase 4 decisions ===");
console.log(`audit chain: ok=${report.provenance.chainOk} verified=${report.provenance.verifiedPrefix}/${report.provenance.totalRecords}`);
const c = report.coverage;
console.log(`coverage: observed=${c.decisionsObserved} measured=${c.measured} unmeasured=${c.unmeasured} unsupported=${c.unsupported} externallyCorroborated=${c.externallyCorroborated} agentAuthoredOnly=${c.agentAuthoredOnly}`);
console.log("decisions:");
for (const d of report.decisions) {
  const e = d.observedEvidence;
  console.log(`  ${d.decisionId} [${d.action}] verdict=${d.verdict.toUpperCase()} claim=${d.telemetryClaim?.outcome ?? "-"} evidence=${e ? `${e.source}/${e.origin} ${e.outcome}` : "(none)"}`);
}
console.log(`proposals generated (self-improvement, generation-only): ${proposals.length}`);
for (const p of proposals) console.log(`  [${p.proposalClass}] ${p.text}  (evidence: ${p.evidence.decisionIds.join(", ")})`);

// ---- assertions: the dogfood must actually exercise the machinery ----
const byId = Object.fromEntries(report.decisions.map((d) => [d.decisionId, d]));
const errs = [];
if (report.provenance.chainOk !== true) errs.push("audit chain did not verify");
if (byId[coordOk]?.verdict !== "match") errs.push("coordinator command_run should be a MATCH");
if (byId[operatorBad]?.verdict !== "mismatch") errs.push("operator false-success should be a MISMATCH");
if (byId[operatorBad]?.observedEvidence?.origin !== "externally_observed") errs.push("the mismatch should be externally observed");
if (c.externallyCorroborated < 2) errs.push("expected both command_run decisions externally corroborated");
if (proposals.length < 1) errs.push("a mismatch should generate at least one improvement proposal");

fs.rmSync(work, { recursive: true, force: true });
if (errs.length > 0) { console.log("\nFAIL:\n  " + errs.join("\n  ")); process.exit(1); }
console.log("\nPASS: the harness evaluated its own decisions (incl. catching a false success by exit code) and drafted its own proposals - dogfood, not ceremony.");
process.exit(0);
