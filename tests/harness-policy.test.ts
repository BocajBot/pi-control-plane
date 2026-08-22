/**
 * Authority invariants A1-A5, plus the policy-inheritance rules of spec
 * section 22 and the unattended-execution rule of section 14.
 *
 * These tests are written as refusals wherever possible. An authority test
 * that only checks the allow path passes just as happily against a function
 * that allows everything.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  atLeastAsStrict,
  authorize,
  capabilitiesOf,
  classifyPostureChange,
  CONSTITUTIONAL_RULES,
  defaultSoftPolicy,
  postureAction,
  inheritApprovalPolicy,
  inheritAutonomy,
  inheritSoftPolicy,
  mayRunUnattended,
  type Action,
  type AuthorizationRequest,
} from "../src/harness/policy.ts";
import { createScope } from "../src/harness/scope.ts";
import type { Actor, ApprovalPolicy, AutonomyMode } from "../src/harness/types.ts";

const scope = createScope("/home/u/proj", "user");

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    actor: "coordinator",
    action: "read",
    target: null,
    targetInScope: null,
    scope,
    autonomy: "guided",
    approvalPolicy: "none",
    soft: defaultSoftPolicy(),
    userApproved: false,
    ...overrides,
  };
}

test("A5: audit rewrite is refused for every actor, including the user", () => {
  for (const actor of ["user", "core", "coordinator", "advisor", "subagent", "reviewer"] as Actor[]) {
    const decision = authorize(request({ actor, action: "audit-rewrite" }));
    assert.equal(decision.verdict, "deny", `${actor} must not rewrite audit history`);
    assert.equal(decision.rule, "AU1");
  }
});

test("A5: hard policy change is refused for every actor except the user", () => {
  for (const actor of ["core", "coordinator", "advisor", "subagent", "reviewer"] as Actor[]) {
    assert.equal(authorize(request({ actor, action: "policy-change-hard" })).verdict, "deny");
  }
  assert.equal(authorize(request({ actor: "user", action: "policy-change-hard" })).verdict, "allow");
});

test("A2/M1: the coordinator cannot promote global memory at any approval setting", () => {
  for (const approvalPolicy of ["all-actions", "mutations", "consequential", "none"] as ApprovalPolicy[]) {
    const decision = authorize(
      request({ actor: "coordinator", action: "memory-promote-global", approvalPolicy }),
    );
    assert.equal(decision.verdict, "deny", `denied under ${approvalPolicy}`);
    assert.equal(decision.rule, "A2/A3");
  }
});

test("MO5: an advisor may only read - it cannot mutate, delegate, or switch models", () => {
  assert.equal(authorize(request({ actor: "advisor", action: "read" })).verdict, "allow");
  for (const action of ["mutate", "shell", "delegate", "model-switch", "task-create"] as Action[]) {
    assert.equal(authorize(request({ actor: "advisor", action })).verdict, "deny", action);
  }
});

test("spec section 26: subagents are read-only in the MVP", () => {
  assert.equal(authorize(request({ actor: "subagent", action: "read" })).verdict, "allow");
  assert.equal(authorize(request({ actor: "subagent", action: "mutate" })).verdict, "deny");
  assert.equal(authorize(request({ actor: "subagent", action: "shell" })).verdict, "deny");
  assert.ok(!capabilitiesOf("subagent").includes("mutate"));
});

test("reviewer has learning authority and no operational authority", () => {
  assert.equal(authorize(request({ actor: "reviewer", action: "memory-promote-global" })).verdict, "allow");
  assert.equal(authorize(request({ actor: "reviewer", action: "memory-supersede" })).verdict, "allow");
  for (const action of ["mutate", "shell", "task-create", "config-change"] as Action[]) {
    assert.equal(authorize(request({ actor: "reviewer", action })).verdict, "deny", action);
  }
});

test("deny-by-default: an unknown actor is refused rather than falling through", () => {
  const decision = authorize(request({ actor: "wizard" as Actor }));
  assert.equal(decision.verdict, "deny");
  assert.equal(decision.rule, "deny-by-default");
});

test("S3: an out-of-scope target is denied even when the actor holds the capability", () => {
  const decision = authorize(
    request({ actor: "coordinator", action: "mutate", target: "/etc/passwd", targetInScope: false }),
  );
  assert.equal(decision.verdict, "deny");
  assert.equal(decision.rule, "S3/S6");
});

test("section 9: builtin bash is blocked unless the scope carries the explicit grant", () => {
  const blocked = authorize(request({ actor: "coordinator", action: "shell", target: "bash" }));
  assert.equal(blocked.verdict, "deny");
  assert.match(blocked.reason, /unrestricted builtin bash/);

  const granted = authorize(
    request({
      actor: "coordinator",
      action: "shell",
      target: "bash",
      scope: { ...scope, unsafeBuiltinBashGrant: true },
    }),
  );
  assert.notEqual(granted.verdict, "deny");
});

test("approval policy: \"mutations\" asks before changes but not before reads", () => {
  assert.equal(authorize(request({ action: "read", approvalPolicy: "mutations" })).verdict, "allow");
  assert.equal(
    authorize(request({ action: "mutate", targetInScope: true, approvalPolicy: "mutations" })).verdict,
    "needs-approval",
  );
});

test("approval policy: \"consequential\" asks before scope expansion but not before an edit", () => {
  assert.equal(
    authorize(request({ action: "mutate", targetInScope: true, approvalPolicy: "consequential" })).verdict,
    "allow",
  );
  assert.equal(
    authorize(request({ action: "scope-expand", approvalPolicy: "consequential" })).verdict,
    "needs-approval",
  );
});

test("A1: an explicit user approval satisfies the approval gate", () => {
  const decision = authorize(
    request({ action: "mutate", targetInScope: true, approvalPolicy: "all-actions", userApproved: true }),
  );
  assert.equal(decision.verdict, "allow");
  assert.equal(decision.rule, "A1");
});

test("A1: user approval does not unlock a constitutional refusal", () => {
  assert.equal(
    authorize(request({ actor: "coordinator", action: "audit-rewrite", userApproved: true })).verdict,
    "deny",
  );
  assert.equal(
    authorize(request({ actor: "coordinator", action: "policy-change-hard", userApproved: true })).verdict,
    "deny",
  );
});

test("section 2.5: interactive autonomy keeps the user in the loop for changes", () => {
  const decision = authorize(
    request({ action: "mutate", targetInScope: true, approvalPolicy: "none", autonomy: "interactive" }),
  );
  assert.equal(decision.verdict, "needs-approval");
});

test("section 22: soft policy can add a tool denial that binds", () => {
  const soft = inheritSoftPolicy(defaultSoftPolicy("project"), { additionalDeniedTools: ["write"] });
  const decision = authorize(
    request({ action: "mutate", target: "write", targetInScope: true, soft }),
  );
  assert.equal(decision.verdict, "deny");
});

test("section 22: a tool denial matches the tool name, not the file it touches", () => {
  // Regression: soft denials were compared against `target`, which for a
  // write is the path - so denying "write" never fired on an actual write.
  const soft = inheritSoftPolicy(defaultSoftPolicy("project"), { additionalDeniedTools: ["write"] });
  const decision = authorize(
    request({ action: "mutate", target: "/home/u/proj/a.ts", toolName: "write", targetInScope: true, soft }),
  );
  assert.equal(decision.verdict, "deny");
  assert.match(decision.reason, /soft policy/);
});

test("section 22: a child may tighten approval policy but never weaken it", () => {
  assert.equal(inheritApprovalPolicy("mutations", "all-actions"), "all-actions", "tightening allowed");
  assert.equal(inheritApprovalPolicy("mutations", "none"), "mutations", "weakening clamped");
  assert.ok(atLeastAsStrict("all-actions", "none"));
  assert.ok(!atLeastAsStrict("none", "all-actions"));
});

test("section 22: a child may tighten autonomy but never widen it", () => {
  assert.equal(inheritAutonomy("guided", "interactive"), "interactive");
  assert.equal(inheritAutonomy("guided", "autonomous"), "guided");
});

test("section 22: soft-policy inheritance unions denials and keeps the strict boolean", () => {
  const parent = { ...defaultSoftPolicy("project"), additionalDeniedTools: ["write"], runTestsAfterEdits: true };
  const merged = inheritSoftPolicy(parent, { additionalDeniedTools: ["shell"], runTestsAfterEdits: false });
  assert.deepEqual(merged.additionalDeniedTools, ["shell", "write"]);
  assert.equal(merged.runTestsAfterEdits, true, "a child cannot switch off the parent's test rule");
});

test("section 14: a task does not run unattended without its own autonomous envelope", () => {
  assert.equal(mayRunUnattended("guided", "none", []).allowed, false);
  assert.equal(mayRunUnattended("autonomous", "mutations", []).allowed, false);
  assert.equal(mayRunUnattended("autonomous", "none", ["tests must be green"]).allowed, false);
  assert.equal(mayRunUnattended("autonomous", "none", []).allowed, true);
});

test("section 24: the constitutional rule list is non-empty and covers the named areas", () => {
  const joined = CONSTITUTIONAL_RULES.join(" | ");
  for (const topic of ["user authority", "audit history", "global-memory", "subagent", "credential"]) {
    assert.match(joined, new RegExp(topic));
  }
});

/* ------------------------------------------------------------------ *
 * Posture authority (spec section 32)
 * ------------------------------------------------------------------ */

test("section 32: the coordinator may tighten its own posture without asking", () => {
  const decision = authorize(request({ actor: "coordinator", action: "posture-tighten", approvalPolicy: "none" }));
  assert.equal(decision.verdict, "allow", "self-restriction is not an authority expansion");
});

test("section 32: loosening posture needs the user, even under approvalPolicy none", () => {
  // The decisive case. A posture of "never ask" must not be self-extending,
  // or the first loosening authorizes every later one.
  for (const actor of ["coordinator", "core", "advisor", "subagent", "reviewer"] as Actor[]) {
    const decision = authorize(request({ actor, action: "posture-loosen", approvalPolicy: "none" }));
    assert.notEqual(decision.verdict, "allow", `${actor} must not loosen its own posture unattended`);
  }
  const coordinator = authorize(request({ actor: "coordinator", action: "posture-loosen", approvalPolicy: "none" }));
  assert.equal(coordinator.verdict, "needs-approval");
  assert.match(coordinator.rule, /A2/);
});

test("section 32: the user may loosen posture directly", () => {
  assert.equal(
    authorize(request({ actor: "user", action: "posture-loosen", approvalPolicy: "none" })).verdict,
    "allow",
  );
});

test("A1: an approved loosening is allowed, and is not asked about twice", () => {
  const decision = authorize(
    request({ actor: "coordinator", action: "posture-loosen", approvalPolicy: "none", userApproved: true }),
  );
  assert.equal(decision.verdict, "allow");
  assert.equal(decision.rule, "A1");
});

test("section 32: an advisor or subagent holds no posture authority at all", () => {
  for (const actor of ["advisor", "subagent", "reviewer"] as Actor[]) {
    assert.equal(authorize(request({ actor, action: "posture-tighten" })).verdict, "deny", actor);
    assert.ok(!capabilitiesOf(actor).includes("posture-tighten"));
    assert.ok(!capabilitiesOf(actor).includes("posture-loosen"));
  }
});

test("section 32: posture direction is classified mechanically, not from the request's own description", () => {
  assert.equal(classifyPostureChange("autonomy", "guided", "autonomous"), "loosen");
  assert.equal(classifyPostureChange("autonomy", "guided", "interactive"), "tighten");
  assert.equal(classifyPostureChange("approval", "mutations", "none"), "loosen");
  assert.equal(classifyPostureChange("approval", "mutations", "all-actions"), "tighten");
  assert.equal(classifyPostureChange("approval", "none", "none"), "neutral");
  // Reasoning style carries no authority (section 2.4).
  assert.equal(classifyPostureChange("reasoning", "constrained", "exploratory"), "neutral");
  // Deny-by-default applied to a classifier: an unrecognized value costs one
  // approval prompt if wrong, rather than one unreviewed expansion.
  assert.equal(classifyPostureChange("autonomy", "guided", "godmode"), "loosen");
});

test("section 32: a neutral change has no action to authorize", () => {
  assert.equal(postureAction("neutral"), null);
  assert.equal(postureAction("loosen"), "posture-loosen");
  assert.equal(postureAction("tighten"), "posture-tighten");
});
