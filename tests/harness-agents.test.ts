/**
 * Delegation invariants SA1-SA5, plus the handoff and retrospective-review
 * parsing that everything downstream depends on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildContract,
  parseHandoff,
  parseReviewProposals,
  renderContractPrompt,
  runDelegate,
  type DelegationRequest,
  type ParentAuthority,
} from "../src/harness/agents.ts";
import { createScope, type PathOps } from "../src/harness/scope.ts";

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
    kind: "subagent",
    objective: "map the retry paths",
    requestedCapabilities: ["read", "grep"],
    contextPackage: ["src/retry.ts is the entry point"],
    expectedOutput: "a list of call sites",
    ...overrides,
  };
}

test("SA1: every contract is fully populated - no field is left to an unstated default", () => {
  const outcome = buildContract(parent, req(), ops);
  assert.ok(outcome.ok);
  const c = outcome.contract;
  for (const [field, value] of Object.entries({
    objective: c.objective,
    expectedOutput: c.expectedOutput,
    escalationBehavior: c.escalationBehavior,
    parentSession: c.parentSession,
  })) {
    assert.ok(typeof value === "string" && value.length > 0, `${field} must be populated`);
  }
  assert.ok(c.scope.allowedRoots.length > 0);
  assert.ok(c.allowedCapabilities.length > 0);
});

test("SA1: a delegation with no objective is refused", () => {
  const outcome = buildContract(parent, req({ objective: "   " }), ops);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "SA1");
});

test("SA3: a child scope outside the parent's is refused", () => {
  const outcome = buildContract(parent, req({ scopeTarget: "/etc" }), ops);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "SA3");
});

test("SA3: a child cannot be granted more autonomy or a looser approval policy", () => {
  const strictParent: ParentAuthority = { ...parent, autonomy: "interactive", approvalPolicy: "all-actions" };
  const outcome = buildContract(
    strictParent,
    req({ requestedAutonomy: "autonomous", requestedApprovalPolicy: "none" }),
    ops,
  );
  assert.ok(outcome.ok);
  assert.equal(outcome.contract.autonomy, "interactive");
  assert.equal(outcome.contract.approvalPolicy, "all-actions");
});

test("SA3: capabilities beyond the kind's ceiling are dropped, and the drop is reported", () => {
  const outcome = buildContract(parent, req({ requestedCapabilities: ["read", "write", "bash"] }), ops);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.contract.allowedCapabilities, ["read"]);
  assert.deepEqual(outcome.droppedCapabilities.sort(), ["bash", "write"]);
});

test("MO5: an advisor contract is read-only and cannot be given research tools", () => {
  const outcome = buildContract(
    parent,
    req({ kind: "advisor", requestedCapabilities: ["read", "local_web_search", "write"] }),
    ops,
  );
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.contract.allowedCapabilities, ["read"]);
});

test("SA5: the child scope carries no expansion budget, so it cannot grow into the parent's", () => {
  const outcome = buildContract(parent, req({ scopeTarget: "/home/u/proj/src" }), ops);
  assert.ok(outcome.ok);
  assert.equal(outcome.contract.scope.automaticExpansionBudget, 0);
  assert.equal(outcome.contract.scope.automaticExpansionEnabled, false);
  assert.deepEqual(outcome.contract.scope.allowedRoots, ["/home/u/proj/src"]);
});

test("SA2: the context package records exactly what was shared, and nothing more", () => {
  const outcome = buildContract(parent, req({ contextPackage: ["only this line"] }), ops);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.contract.contextPackage, ["only this line"]);
  assert.match(renderContractPrompt(outcome.contract), /only this line/);
});

test("SA3: the rendered prompt states the escalation rule rather than implying it", () => {
  const outcome = buildContract(parent, req(), ops);
  assert.ok(outcome.ok);
  const prompt = renderContractPrompt(outcome.contract);
  assert.match(prompt, /blockedRequest/);
  assert.match(prompt, /may not enlarge it/);
});

test("SA4: a handoff parses into evidence and recommendations, not applied changes", () => {
  const handoff = parseHandoff(
    [
      "CONCLUSION: the retry path swallows the timeout",
      "EVIDENCE:",
      "- src/retry.ts:44 catches and returns null",
      "- tests/retry.test.ts has no timeout case",
      "ASSUMPTIONS:",
      "- the caller treats null as success",
      "UNRESOLVED:",
      "- whether any caller depends on the current behavior",
      "RECOMMENDED:",
      "- rethrow the timeout and add a regression test",
      "BLOCKED: none",
    ].join("\n"),
  );
  assert.match(handoff.conclusion, /swallows the timeout/);
  assert.equal(handoff.evidence.length, 2);
  assert.equal(handoff.assumptions.length, 1);
  assert.equal(handoff.unresolvedQuestions.length, 1);
  assert.equal(handoff.recommendedActions.length, 1);
  assert.equal(handoff.blockedRequest, null);
});

test("SA3: a blocked delegate surfaces the exact request rather than returning empty", () => {
  const handoff = parseHandoff(
    ["CONCLUSION: could not complete", "BLOCKED: read access to /var/log/app.log"].join("\n"),
  );
  assert.equal(handoff.blockedRequest, "read access to /var/log/app.log");
});

test("parseHandoff: a malformed reply degrades to an empty conclusion, not an exception", () => {
  const handoff = parseHandoff("I had a look and it seems fine to me");
  assert.equal(handoff.conclusion, "");
  assert.deepEqual(handoff.evidence, []);
  assert.equal(handoff.blockedRequest, null);
});

test("runDelegate: the injected runner's model is carried through for MO4", async () => {
  const outcome = buildContract(parent, req(), ops);
  assert.ok(outcome.ok);
  const result = await runDelegate(outcome.contract, async () => ({
    text: "CONCLUSION: done\nBLOCKED: none",
    model: { provider: "llama-swap", model: "reviewer-model" },
  }));
  assert.equal(result.handoff.conclusion, "done");
  assert.equal(result.model?.model, "reviewer-model");
  assert.equal(result.contract.id, outcome.contract.id);
});

test("review proposals: uncited memory candidates are dropped", () => {
  const proposals = parseReviewProposals(
    [
      "FINDINGS:",
      "- the sandbox refuses without bwrap",
      "MISTAKES:",
      "- scope was widened without approval (cause: model)",
      "MEMORY:",
      "- the user prefers pkexec over sudo || aud_1, aud_2",
      "- everything is fine",
      "MODELGUIDANCE:",
      "- model-a needs the scope restated each turn",
    ].join("\n"),
  );
  assert.deepEqual(proposals.findings, ["the sandbox refuses without bwrap"]);
  assert.equal(proposals.memoryCandidates.length, 1, "the uncited candidate is dropped");
  assert.deepEqual(proposals.memoryCandidates[0].sources, ["aud_1", "aud_2"]);
  assert.equal(proposals.modelSpecificGuidance.length, 1);
});

test("M5: a candidate whose citation is not a real record id is dropped", () => {
  // Observed live: a reviewer echoed the prompt's own instruction line back as
  // a candidate, citing the literal placeholder, and it was promoted as fact.
  const proposals = parseReviewProposals(
    [
      "MEMORY:",
      "- candidate durable memories, each as `<content> || <session entry ids>` || <session entry ids>",
      "- the retry count stayed at 3 || `dec_c71c344ca02b4999b1b3050aafbdfbfe`",
      "- something remembered || not-an-id, 12345",
    ].join("\n"),
  );
  assert.equal(proposals.memoryCandidates.length, 1, "only the genuinely cited candidate survives");
  assert.match(proposals.memoryCandidates[0].content, /retry count/);
  // Backticks around an id are stripped rather than making it unrecognizable.
  assert.deepEqual(proposals.memoryCandidates[0].sources, ["dec_c71c344ca02b4999b1b3050aafbdfbfe"]);
});

test("review proposals: absent sections come back empty rather than undefined", () => {
  const proposals = parseReviewProposals("FINDINGS:\n- one thing");
  assert.deepEqual(proposals.patterns, []);
  assert.deepEqual(proposals.memoryCandidates, []);
  assert.deepEqual(proposals.unresolvedIssues, []);
});
