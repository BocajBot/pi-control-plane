/**
 * Exec-capable delegate class (the `operator` kind).
 *
 * An operator is a delegate that may run commands, but only through a single
 * sandboxed tool (`scoped_exec`) whose one writable path is the operator's own
 * narrowed scope root. These tests hold the authority model (operator authority
 * is a strict subset of the coordinator's - A3/SA1), the contract cap (only an
 * operator is granted scoped_exec; asking for it as any other kind drops it),
 * the tool wiring (scoped_exec exists only when the harness exec path is
 * injected, is attested like every other delegate tool, and forwards without
 * enforcing anything itself), and that an operator's execution evidence joins
 * the exit_code seam into a live externally-observed verdict.
 *
 * Written as refusals wherever possible: a test that only checks the allow path
 * passes against a function that allows everything.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  authorize,
  capabilitiesOf,
  defaultSoftPolicy,
  type Action,
  type AuthorizationRequest,
} from "../src/harness/policy.ts";
import {
  buildContract,
  renderContractPrompt,
  type DelegationRequest,
  type ParentAuthority,
} from "../src/harness/agents.ts";
import { createScope, type PathOps } from "../src/harness/scope.ts";
import {
  buildDelegateTools,
  type DelegateExecRuntime,
  type DelegateRuntimeContract,
  type DelegateRuntimeLog,
} from "../src/harness/delegate-runtime.ts";

import { harnessPaths } from "../src/harness/config.ts";
import { HarnessStore } from "../src/harness/store.ts";
import { makeAuditEvent } from "../src/harness/audit.ts";
import { makeId } from "../src/harness/util.ts";
import { buildDecisionTelemetry } from "../src/harness/decision-telemetry.ts";
import { toEvidence, extractExecutionRecords, chainTrust } from "../src/harness/decision-evaluation-adapter.ts";
import { readExitCodeEvidence } from "../src/harness/external-evidence.ts";
import { evaluate } from "../src/harness/decision-evaluation.ts";

/* ================================================================== *
 * A. Authority model - operator authority is a strict subset of the
 *    coordinator's (A3/SA1), and it does not reach mutate/promote/policy.
 * ================================================================== */

const scope = createScope("/home/u/proj", "user");
function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    actor: "coordinator",
    action: "read",
    target: null,
    targetInScope: null,
    scope,
    autonomy: "autonomous",
    approvalPolicy: "none",
    soft: defaultSoftPolicy(),
    userApproved: true,
    ...overrides,
  };
}

test("operator authority is a strict subset of the coordinator's (A3/SA1)", () => {
  const operator = capabilitiesOf("operator");
  const coordinator = capabilitiesOf("coordinator");
  for (const cap of operator) {
    assert.ok(coordinator.includes(cap), `coordinator must also hold "${cap}" for the subset to hold`);
  }
  // A strict subset: the coordinator holds authority the operator does not.
  assert.ok(operator.length < coordinator.length, "operator must not equal the coordinator");
  assert.ok(!operator.includes("mutate"), "operator writes only inside its sandbox, never via mutate");
});

test("operator holds shell where advisor/subagent do not (the one capability that distinguishes it)", () => {
  // Same permissive request for all three; only the capability axis differs.
  assert.equal(authorize(request({ actor: "operator", action: "shell" })).verdict, "allow");
  assert.equal(authorize(request({ actor: "subagent", action: "shell" })).verdict, "deny");
  assert.equal(authorize(request({ actor: "advisor", action: "shell" })).verdict, "deny");
  assert.equal(authorize(request({ actor: "subagent", action: "shell" })).rule, "A2/A3");
});

test("operator cannot mutate, promote memory, or touch hard policy", () => {
  assert.equal(authorize(request({ actor: "operator", action: "mutate" })).verdict, "deny");
  assert.equal(authorize(request({ actor: "operator", action: "memory-promote-global" })).verdict, "deny");
  const hard = authorize(request({ actor: "operator", action: "policy-change-hard" }));
  assert.equal(hard.verdict, "deny");
  assert.equal(hard.rule, "A5");
  assert.equal(authorize(request({ actor: "operator", action: "read" })).verdict, "allow");
});

/* ================================================================== *
 * B. Contract cap - only an operator is granted scoped_exec; every
 *    other kind has it dropped even when the request asks for it.
 * ================================================================== */

const ops: PathOps = { exists: () => true, realpath: (p) => p };
const parent: ParentAuthority = {
  session: "ses_1",
  actor: "coordinator",
  scope: createScope("/home/u/proj", "user"),
  autonomy: "autonomous",
  approvalPolicy: "consequential",
  cwd: "/home/u/proj",
};
function req(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    kind: "operator",
    objective: "run the build check",
    // An operator must be given an explicit scope subtree (see the SA3 test
    // below); a subdirectory of the parent's /home/u/proj scope.
    scopeTarget: "/home/u/proj/build",
    requestedCapabilities: ["scoped_read", "scoped_list", "request_read_scope", "scoped_exec"],
    contextPackage: ["the project builds with npm test"],
    expectedOutput: "the build result",
    ...overrides,
  };
}

test("buildContract grants scoped_exec to an operator", () => {
  const outcome = buildContract(parent, req(), ops);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.ok(outcome.contract.allowedCapabilities.includes("scoped_exec"));
  assert.ok(!outcome.droppedCapabilities.includes("scoped_exec"));
});

test("buildContract drops scoped_exec when any non-operator kind asks for it", () => {
  for (const kind of ["subagent", "advisor", "reviewer"] as const) {
    const outcome = buildContract(parent, req({ kind, requestedCapabilities: ["read", "scoped_exec"] }), ops);
    assert.equal(outcome.ok, true, kind);
    if (!outcome.ok) continue;
    assert.ok(
      !outcome.contract.allowedCapabilities.includes("scoped_exec"),
      `${kind} must not be granted scoped_exec`,
    );
    assert.ok(outcome.droppedCapabilities.includes("scoped_exec"), `${kind} drop must be recorded for audit`);
  }
});

test("an operator's scope is still narrowed to a subset - a target outside the parent is refused (SA3)", () => {
  const outcome = buildContract(parent, req({ scopeTarget: "/etc" }), ops);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.rule, "SA3");
});

test("an operator with no explicit scope is refused - exec is never defaulted to the parent's whole scope (SA3)", () => {
  // The least-privilege gap the adversarial pass surfaced: an omitted scopeTarget
  // used to default an operator to the parent's own root (equal, a valid subset,
  // but the wrong default for the highest-privilege delegate on a model-driven
  // omitted param). Now it is refused; the coordinator must name the scope.
  const outcome = buildContract(parent, req({ scopeTarget: undefined }), ops);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.rule, "SA3");
  assert.match(outcome.reason, /explicit scope/);

  // Read-only kinds keep the inherit-on-omit default (lower stake, read-only seams).
  assert.equal(buildContract(parent, req({ kind: "subagent", scopeTarget: undefined, requestedCapabilities: ["scoped_read"] }), ops).ok, true);
});

/* ================================================================== *
 * C. Tool wiring - scoped_exec exists only when the exec path is
 *    injected, is attested, and forwards without enforcing itself.
 * ================================================================== */

function runtimeContract(allowedTools: string[]): DelegateRuntimeContract {
  return { contractId: "del_1", readRoots: ["/home/u/proj"], allowedTools, maxBytes: 64_000 };
}
function freshLog(): DelegateRuntimeLog {
  return { calls: [], pendingRequests: [], attestationChecks: 0, runtimeViolations: [] };
}
function toolNames(tools: unknown[]): string[] {
  return tools.map((t) => (t as { name: string }).name);
}
function find(tools: unknown[], name: string): { execute: (id: unknown, params: unknown) => Promise<{ content: { text: string }[] }> } {
  return tools.find((t) => (t as { name: string }).name === name) as never;
}

test("scoped_exec is present only when an exec runtime is injected", () => {
  const withExec = buildDelegateTools(
    runtimeContract(["scoped_read", "scoped_list", "request_read_scope", "scoped_exec"]),
    freshLog(),
    undefined,
    undefined,
    { run: async () => ({ refused: false, exitCode: 0, output: "ok" }) },
  );
  assert.ok(toolNames(withExec).includes("scoped_exec"));

  const withoutExec = buildDelegateTools(runtimeContract(["scoped_read", "scoped_list", "request_read_scope"]), freshLog());
  assert.ok(!toolNames(withoutExec).includes("scoped_exec"), "no exec runtime => no scoped_exec tool at all");

  // Defense-in-depth: even with an exec runtime, the tool is not built unless the
  // contract's allowedTools lists it. The builder does not rely on caller
  // discipline alone to keep exec off a contract that never granted it.
  const runtimeButNotContracted = buildDelegateTools(
    runtimeContract(["scoped_read"]),
    freshLog(),
    undefined,
    undefined,
    { run: async () => ({ refused: false, exitCode: 0, output: "ok" }) },
  );
  assert.ok(!toolNames(runtimeButNotContracted).includes("scoped_exec"), "an execRuntime cannot smuggle exec onto a contract that omits it");
});

test("scoped_exec forwards the command and expect_success to the injected runtime and returns its output", async () => {
  const seen: Array<{ command: string; expectSuccess: boolean }> = [];
  const execRuntime: DelegateExecRuntime = {
    run: async (command, expectSuccess) => {
      seen.push({ command, expectSuccess });
      return { refused: false, exitCode: 0, output: "build passed" };
    },
  };
  const log = freshLog();
  const tools = buildDelegateTools(runtimeContract(["scoped_exec"]), log, undefined, undefined, execRuntime);
  const res = await find(tools, "scoped_exec").execute("id", { command: "npm test", expect_success: true });

  assert.equal(res.content[0].text, "build passed");
  assert.deepEqual(seen, [{ command: "npm test", expectSuccess: true }]);
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].tool, "scoped_exec");
  assert.equal(log.calls[0].allowed, true);
});

test("scoped_exec records a refusal as a denied call, not a success", async () => {
  const execRuntime: DelegateExecRuntime = {
    run: async () => ({ refused: true, reason: "target outside scope", output: "Refused: target outside scope" }),
  };
  const log = freshLog();
  const tools = buildDelegateTools(runtimeContract(["scoped_exec"]), log, undefined, undefined, execRuntime);
  const res = await find(tools, "scoped_exec").execute("id", { command: "cat /etc/shadow" });

  assert.match(res.content[0].text, /Refused/);
  assert.equal(log.calls[0].allowed, false, "a refused exec is a denied call for the post-run summary");
});

test("scoped_exec is attested before and after, and a drift aborts it", async () => {
  const phases: string[] = [];
  const execRuntime: DelegateExecRuntime = { run: async () => ({ refused: false, exitCode: 0, output: "ok" }) };

  const okLog = freshLog();
  const okTools = buildDelegateTools(runtimeContract(["scoped_exec"]), okLog, undefined, { attest: (phase) => phases.push(phase) }, execRuntime);
  await find(okTools, "scoped_exec").execute("id", { command: "true" });
  assert.deepEqual(phases, ["before", "after"], "attested immediately before and after execution");

  const driftLog = freshLog();
  const driftTools = buildDelegateTools(
    runtimeContract(["scoped_exec"]),
    driftLog,
    undefined,
    { attest: (phase) => { if (phase === "before") throw new Error("tool surface drifted"); } },
    execRuntime,
  );
  await assert.rejects(() => find(driftTools, "scoped_exec").execute("id", { command: "true" }));
  assert.ok((driftLog.runtimeViolations ?? []).length > 0, "the drift is retained so the handoff is discarded");
});

/* ================================================================== *
 * D. The delegate prompt tells an operator it may act, and tells every
 *    other kind it may not - derived from the granted capabilities.
 * ================================================================== */

test("renderContractPrompt gives an operator the sandboxed-exec boundary, not the read-only one", () => {
  const opContract = buildContract(parent, req(), ops);
  assert.equal(opContract.ok, true);
  if (!opContract.ok) return;
  const prompt = renderContractPrompt(opContract.contract);
  assert.match(prompt, /scoped_exec/);
  assert.match(prompt, /sandbox/i);
  assert.doesNotMatch(prompt, /You may not modify files/);
});

test("renderContractPrompt keeps the read-only boundary for a subagent", () => {
  const subContract = buildContract(parent, req({ kind: "subagent", requestedCapabilities: ["scoped_read"] }), ops);
  assert.equal(subContract.ok, true);
  if (!subContract.ok) return;
  assert.match(renderContractPrompt(subContract.contract), /You may not modify files/);
});

/* ================================================================== *
 * E. Live evidence - an operator's command_run claim + shell_exec record
 *    join the exit_code seam into an externally-observed verdict, through
 *    a real store with a real hash-chained audit log. The evaluator and
 *    adapter are actor-agnostic; this proves the operator actor is a
 *    first-class citizen of that path end to end.
 * ================================================================== */

function evalPipeline(store: HarnessStore) {
  const auditRead = store.readAudit();
  const verification = store.verifyAudit();
  const evidence = toEvidence({ audit: auditRead.records, delegations: store.readDelegations().records, reviews: [] });
  const claims = evidence.filter((e) => e.kind === "claim");
  const exitCodes = readExitCodeEvidence(claims, extractExecutionRecords(auditRead.records));
  return {
    verification,
    report: evaluate({ evidence: [...evidence, ...exitCodes], chain: chainTrust(verification, auditRead.records.length) }),
  };
}

function recordOperatorExec(store: HarnessStore, ctx: never, { claimSuccess, exitCode, label }: { claimSuccess: boolean; exitCode: number; label: string }): string {
  const decisionId = makeId("decision");
  const decision = buildDecisionTelemetry({
    decisionId,
    action: "command_run",
    category: "command_execution",
    rule: "operator_delegated_exec",
    outcome: { status: claimSuccess ? "completed" : "failed" },
  });
  store.appendAudit(makeAuditEvent(ctx, { eventType: "decision_telemetry", request: label, result: decision!.outcome.status, metadata: { decision } }));
  store.appendAudit(makeAuditEvent(ctx, { eventType: "shell_exec", request: label, result: `exit ${exitCode}`, metadata: { runId: makeId("run"), exitCode, decisionId } }));
  return decisionId;
}

test("an operator's exec joins the exit_code seam into a live externally-observed verdict", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exec-delegate-test-"));
  try {
    const home = path.join(work, "home");
    const projectRoot = path.join(work, "proj");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    const store = new HarnessStore(harnessPaths(home, projectRoot, {}));

    const ctx = {
      session: makeId("session"),
      actor: "operator",
      actorModel: { provider: "llama-swap", model: "operator-test" },
      scope: createScope(projectRoot, "user", { home }),
    } as never;

    const positive = recordOperatorExec(store, ctx, { claimSuccess: true, exitCode: 0, label: "operator: build check" });
    const negative = recordOperatorExec(store, ctx, { claimSuccess: true, exitCode: 1, label: "operator: deliberately-failing check" });

    const { report } = evalPipeline(store);
    const byId = Object.fromEntries(report.decisions.map((d) => [d.decisionId, d]));

    assert.equal(report.provenance.chainOk, true, "the operator's audit lines chain cleanly");
    assert.ok(report.coverage.externallyCorroborated >= 1);

    assert.equal(byId[positive].verdict, "match");
    assert.equal(byId[positive].observedEvidence?.origin, "externally_observed");
    assert.equal(byId[positive].observedEvidence?.source, "exit_code");

    assert.equal(byId[negative].verdict, "mismatch", "a claimed success that really exits 1 is refuted by the exit code");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
