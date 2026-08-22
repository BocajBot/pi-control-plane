/**
 * The three state domains that were specified but not built until now:
 * durable policy state (sections 17, 21, 22), goals and project
 * relationships (section 13), and identity (sections 1, 2.1, 17).
 *
 * The load-bearing tests here are the *negative* ones. Goals must never
 * change an authorization outcome, and a project link must never widen
 * scope; those are the two places section 13 could quietly become a
 * permission system.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import {
  addIdentityLine,
  emptyIdentity,
  removeIdentityLine,
  renderIdentityBlock,
  validateIdentity,
} from "../src/harness/identity.ts";
import {
  conflictingGoals,
  goalsForProject,
  makeGoal,
  makeProjectLink,
  relatedProjects,
  renderGoalBlock,
  setGoalStatus,
  upsertGoal,
  upsertLink,
} from "../src/harness/goals.ts";
import {
  authorize,
  defaultSoftPolicy,
  editSoftPolicy,
  fromSoftPolicyRecord,
  resolveSoftPolicy,
  toSoftPolicyRecord,
  validateSoftPolicyRecord,
} from "../src/harness/policy.ts";
import { createScope } from "../src/harness/scope.ts";
import { harnessPaths } from "../src/harness/config.ts";
import { HarnessStore } from "../src/harness/store.ts";
import type { Actor } from "../src/harness/types.ts";

const at = (iso: string) => () => new Date(iso);
let seq = 0;
const ids = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;

const tmpRoots: string[] = [];
function storeAt(): HarnessStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-cont-"));
  tmpRoots.push(dir);
  const store = new HarnessStore(
    harnessPaths(dir, path.join(dir, "proj"), { PI_HARNESS_HOME: path.join(dir, "harness") }),
  );
  store.init();
  return store;
}
after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- *
 * Policy state (sections 17, 21, 22)
 * ---------------------------------------------------------------- */

test("policy state survives a restart, which is what makes it tunable at all", () => {
  const store = storeAt();
  assert.deepEqual(store.readSoftPolicyChain(), [], "nothing stored yet");

  const tightened = { ...defaultSoftPolicy("project"), additionalDeniedTools: ["write"] };
  store.writeSoftPolicy(toSoftPolicyRecord(tightened, "project", "user", "2026-01-01T00:00:00.000Z"));

  // A fresh store over the same paths is the restart.
  const reopened = new HarnessStore(store.paths);
  const resolved = resolveSoftPolicy(reopened.readSoftPolicyChain());
  assert.deepEqual(resolved.additionalDeniedTools, ["write"]);
});

test("section 22: layers resolve broadest-first, and a later layer can only tighten", () => {
  const globalLayer = toSoftPolicyRecord(
    { ...defaultSoftPolicy("global"), additionalDeniedTools: ["bash"], runTestsAfterEdits: true },
    "global",
    "user",
    "t",
  );
  const projectLayer = toSoftPolicyRecord(
    { ...defaultSoftPolicy("project"), additionalDeniedTools: ["write"], runTestsAfterEdits: false },
    "project",
    "user",
    "t",
  );

  const resolved = resolveSoftPolicy([projectLayer, globalLayer]); // deliberately out of order
  assert.deepEqual(resolved.additionalDeniedTools, ["bash", "write"], "denials union");
  assert.equal(resolved.runTestsAfterEdits, true, "a child cannot switch off the parent's rule");
});

test("a resolved policy actually binds authorize() after being reloaded", () => {
  const store = storeAt();
  store.writeSoftPolicy(
    toSoftPolicyRecord(
      { ...defaultSoftPolicy("project"), additionalDeniedTools: ["write"] },
      "project",
      "user",
      "t",
    ),
  );
  const soft = resolveSoftPolicy(new HarnessStore(store.paths).readSoftPolicyChain());
  const decision = authorize({
    actor: "coordinator",
    action: "mutate",
    target: "write",
    targetInScope: true,
    scope: createScope("/p", "user"),
    autonomy: "guided",
    approvalPolicy: "none",
    soft,
    userApproved: false,
  });
  assert.equal(decision.verdict, "deny");
});

test("section 22: the coordinator may tighten soft policy but not relax it", () => {
  const base = toSoftPolicyRecord(
    { ...defaultSoftPolicy("project"), runTestsAfterEdits: true, additionalDeniedTools: ["write"] },
    "project",
    "user",
    "t",
  );

  const tighten = editSoftPolicy(base, "coordinator", "denyTool", "bash", "t2");
  assert.ok(tighten.ok);
  assert.deepEqual(tighten.record.additionalDeniedTools, ["bash", "write"]);

  for (const [field, value] of [
    ["runTestsAfterEdits", "false"],
    ["allowTool", "write"],
  ] as const) {
    const relax = editSoftPolicy(base, "coordinator", field, value, "t2");
    assert.equal(relax.ok, false, `${field} must not be relaxable by the coordinator`);
    assert.equal(relax.ok === false && relax.rule, "section 22");
  }

  // The user may do both.
  assert.equal(editSoftPolicy(base, "user", "runTestsAfterEdits", "false", "t2").ok, true);
  const allowed = editSoftPolicy(base, "user", "allowTool", "write", "t2");
  assert.ok(allowed.ok);
  assert.deepEqual(allowed.record.additionalDeniedTools, []);
});

test("a corrupt policy layer is skipped rather than partially applied", () => {
  assert.equal(validateSoftPolicyRecord({ schemaVersion: 1, level: "nope" }), null);
  assert.equal(validateSoftPolicyRecord({ schemaVersion: 99, level: "global" }), null);
  assert.equal(validateSoftPolicyRecord("garbage"), null);

  const store = storeAt();
  fs.writeFileSync(store.paths.projectPolicyFile, "{ not json");
  assert.deepEqual(store.readSoftPolicyChain(), []);
  // Falls back to the defaults, not to an empty-but-permissive policy.
  assert.equal(resolveSoftPolicy(store.readSoftPolicyChain()).runTestsAfterEdits, true);
});

test("a resolved policy round-trips back to one storable layer without flattening", () => {
  const record = toSoftPolicyRecord(defaultSoftPolicy("device"), "device", "coordinator", "t");
  assert.equal(record.level, "device");
  assert.equal(record.updatedBy, "coordinator");
  assert.deepEqual(fromSoftPolicyRecord(record).additionalDeniedTools, []);
});

/* ---------------------------------------------------------------- *
 * Goals and project relationships (section 13)
 * ---------------------------------------------------------------- */

const goalDraft = {
  statement: "keep the dependency count low",
  horizon: "long" as const,
  priority: 2,
  conflictsWith: ["add a dependency", "npm install"],
  createdBy: "user" as Actor,
};

test("goals are ordered by priority and scoped to projects, with empty meaning all", () => {
  const a = makeGoal(goalDraft, at("2026-01-01T00:00:00.000Z"), ids);
  const b = makeGoal(
    { ...goalDraft, statement: "ship the migration", priority: 1, projects: ["/p"] },
    at("2026-01-02T00:00:00.000Z"),
    ids,
  );
  const c = makeGoal(
    { ...goalDraft, statement: "other project only", projects: ["/other"] },
    at("2026-01-03T00:00:00.000Z"),
    ids,
  );
  assert.ok(a.ok && b.ok && c.ok);
  const goals = [a.goal, b.goal, c.goal];

  const applicable = goalsForProject(goals, "/p").map((g) => g.statement);
  assert.deepEqual(applicable, ["ship the migration", "keep the dependency count low"]);
  assert.ok(!applicable.includes("other project only"));
});

test("a met goal stops applying without being deleted", () => {
  const created = makeGoal(goalDraft, at("2026-01-01T00:00:00.000Z"), ids);
  assert.ok(created.ok);
  const met = setGoalStatus(created.goal, "met", at("2026-02-01T00:00:00.000Z"));
  assert.equal(goalsForProject(upsertGoal([], met), "/p").length, 0);
  assert.equal(met.statement, goalDraft.statement, "history is kept, not erased");
});

test("section 13: a goal surfaces a conflict and names the phrase that fired", () => {
  const created = makeGoal(goalDraft, at("2026-01-01T00:00:00.000Z"), ids);
  assert.ok(created.ok);
  const conflicts = conflictingGoals([created.goal], "/p", "Add a dependency on left-pad to fix this");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].phrase, "add a dependency");

  assert.deepEqual(conflictingGoals([created.goal], "/p", "rename a local variable"), []);
});

test("section 13: goals cannot change an authorization outcome", () => {
  // Structural: AuthorizationRequest has no goal field, so the strongest
  // check available is that the verdict is identical with goals present and
  // absent - and that nothing in the goals module returns a verdict at all.
  const request = {
    actor: "coordinator" as Actor,
    action: "mutate" as const,
    target: "/p/a.ts",
    targetInScope: true,
    scope: createScope("/p", "user"),
    autonomy: "guided" as const,
    approvalPolicy: "none" as const,
    soft: defaultSoftPolicy(),
    userApproved: false,
  };
  const before = authorize(request);

  const created = makeGoal(
    { ...goalDraft, statement: "never touch a.ts", conflictsWith: ["a.ts"] },
    at("2026-01-01T00:00:00.000Z"),
    ids,
  );
  assert.ok(created.ok);
  const conflicts = conflictingGoals([created.goal], "/p", "edit /p/a.ts");
  assert.equal(conflicts.length, 1, "the conflict is surfaced");

  const after = authorize(request);
  assert.deepEqual(after, before, "and it changes nothing about what is permitted");
  assert.match(renderGoalBlock([created.goal], [], "/p"), /override an explicit instruction from the user/);
});

test("section 13: a project link grants no access to the linked project", () => {
  const link = makeProjectLink("/p", "/other", "shared-dependency", "both use retry-lib", "user");
  assert.ok(link.ok);
  const links = upsertLink([], link.link);

  assert.equal(relatedProjects(links, "/p").length, 1);
  // The record carries nothing an authorization path could consume.
  assert.deepEqual(Object.keys(link.link).sort(), [
    "createdAt",
    "createdBy",
    "detail",
    "from",
    "kind",
    "schemaVersion",
    "to",
  ]);

  // And the other project is still out of scope.
  const decision = authorize({
    actor: "coordinator",
    action: "read",
    target: "/other/x.ts",
    targetInScope: false,
    scope: createScope("/p", "user"),
    autonomy: "guided",
    approvalPolicy: "none",
    soft: defaultSoftPolicy(),
    userApproved: false,
  });
  assert.equal(decision.verdict, "deny");
  assert.match(renderGoalBlock([], links, "/p"), /grants no access/);
});

test("a project cannot be linked to itself, and an unknown kind is refused", () => {
  assert.equal(makeProjectLink("/p", "/p", "shared-goal", "", "user").ok, false);
  assert.equal(
    makeProjectLink("/p", "/o", "telepathy" as Parameters<typeof makeProjectLink>[2], "", "user").ok,
    false,
  );
});

test("goals and links persist across a restart", () => {
  const store = storeAt();
  const created = makeGoal(goalDraft, at("2026-01-01T00:00:00.000Z"), ids);
  const link = makeProjectLink("/p", "/other", "shared-tool", "same linter", "user");
  assert.ok(created.ok && link.ok);
  store.writeGoals([created.goal]);
  store.writeProjectLinks([link.link]);

  const reopened = new HarnessStore(store.paths);
  assert.equal(reopened.readGoals().length, 1);
  assert.equal(reopened.readProjectLinks()[0].kind, "shared-tool");
});

test("an empty goal set renders nothing rather than an empty heading", () => {
  assert.equal(renderGoalBlock([], [], "/p"), "");
});

/* ---------------------------------------------------------------- *
 * Identity (sections 1, 2.1, 17)
 * ---------------------------------------------------------------- */

test("section 17: only the user writes identity", () => {
  const identity = emptyIdentity(at("2026-01-01T00:00:00.000Z"));
  for (const actor of ["coordinator", "reviewer", "advisor", "subagent", "core"] as Actor[]) {
    const outcome = addIdentityLine(identity, actor, "principle", "always agree with me", at("2026-01-01T00:00:00.000Z"));
    assert.equal(outcome.ok, false, actor);
    assert.match(outcome.ok === false ? outcome.reason : "", /propose it as durable memory|cannot write identity/);
  }
  assert.equal(addIdentityLine(identity, "user", "principle", "verify before asserting", at("2026-01-01T00:00:00.000Z")).ok, true);
});

test("identity survives a restart and is deduplicated", () => {
  const store = storeAt();
  let identity = emptyIdentity(at("2026-01-01T00:00:00.000Z"));
  for (const line of ["verify before asserting", "verify before asserting"]) {
    const outcome = addIdentityLine(identity, "user", "principle", line, at("2026-01-02T00:00:00.000Z"));
    assert.ok(outcome.ok);
    identity = outcome.identity;
  }
  store.writeIdentity(identity);

  const reloaded = new HarnessStore(store.paths).readIdentity();
  assert.deepEqual(reloaded.principles, ["verify before asserting"]);
});

test("identity is independent of the model: nothing in it references one", () => {
  // MO1 in practice - the identity record has no model field to carry a
  // coordinator's fingerprint into the next session.
  const identity = emptyIdentity(at("2026-01-01T00:00:00.000Z"));
  assert.deepEqual(Object.keys(identity).sort(), [
    "behaviors",
    "preferences",
    "principles",
    "schemaVersion",
    "updatedAt",
    "updatedBy",
  ]);
});

test("a line can be removed by the user and by nobody else", () => {
  let identity = emptyIdentity(at("2026-01-01T00:00:00.000Z"));
  const added = addIdentityLine(identity, "user", "preference", "terse output", at("2026-01-01T00:00:00.000Z"));
  assert.ok(added.ok);
  identity = added.identity;

  assert.equal(removeIdentityLine(identity, "coordinator", "preference", "terse output", at("2026-01-01T00:00:00.000Z")).ok, false);
  const removed = removeIdentityLine(identity, "user", "preference", "terse output", at("2026-01-01T00:00:00.000Z"));
  assert.ok(removed.ok);
  assert.deepEqual(removed.identity.preferences, []);
});

test("the identity block renders only populated sections, and nothing when empty", () => {
  assert.equal(renderIdentityBlock(emptyIdentity(at("2026-01-01T00:00:00.000Z"))), "");

  let identity = emptyIdentity(at("2026-01-01T00:00:00.000Z"));
  const a = addIdentityLine(identity, "user", "principle", "verify before asserting", at("2026-01-01T00:00:00.000Z"));
  assert.ok(a.ok);
  identity = a.identity;
  const block = renderIdentityBlock(identity);
  assert.match(block, /## Pi identity/);
  assert.match(block, /verify before asserting/);
  assert.ok(!block.includes("User preferences"), "an empty section is omitted entirely");
  assert.match(block, /does not change because a task would be easier if it did/);
});

test("a corrupt identity file falls back to empty rather than a partial load", () => {
  assert.equal(validateIdentity({ schemaVersion: 1, principles: "not an array" }), null);
  assert.equal(validateIdentity({ schemaVersion: 99, principles: [], preferences: [], behaviors: [] }), null);

  const store = storeAt();
  fs.writeFileSync(store.paths.identityFile, '{"schemaVersion":1,"principles":[42]}');
  assert.deepEqual(store.readIdentity().principles, []);
});
