import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvalStatement,
  latestDelegationJobs,
  makeDelegationJob,
  matchingUserApproval,
  orphanedDelegationJobs,
  transitionDelegationJob,
  validateDelegationJob,
} from "../src/harness/delegation-jobs.ts";
import { HARNESS_SCHEMA_VERSION, type DecisionRecord, type DelegationContract } from "../src/harness/types.ts";

const contract: DelegationContract = {
  schemaVersion: HARNESS_SCHEMA_VERSION,
  id: "dlg_11111111-1111-4111-8111-111111111111",
  kind: "subagent",
  objective: "inspect",
  scope: {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    root: "/p/src",
    allowedRoots: ["/p/src"],
    automaticExpansionEnabled: false,
    automaticExpansionBudget: 0,
    networkGrant: false,
    unsafeBuiltinBashGrant: false,
    autoExpansionCeiling: "/p/src",
    grantedBy: "coordinator",
    updatedAt: "2026-08-22T00:00:00.000Z",
  },
  allowedCapabilities: ["scoped_read", "scoped_list", "request_read_scope"],
  autonomy: "guided",
  approvalPolicy: "mutations",
  contextPackage: [],
  expectedOutput: "handoff",
  escalationBehavior: "surface exact request",
  parentSession: "ses_22222222-2222-4222-8222-222222222222",
  parentActor: "coordinator",
  createdAt: "2026-08-22T00:00:00.000Z",
};

test("delegation jobs: append-only transitions reduce to the latest state", () => {
  const running = makeDelegationJob(contract, { status: "running", detail: "started", ownerPid: 42 });
  const blocked = transitionDelegationJob(running, "blocked", "needs docs", { pendingReadRoot: "/p/docs" });
  assert.deepEqual(latestDelegationJobs([running, blocked]), [blocked]);
  assert.equal(validateDelegationJob(blocked)?.status, "blocked");
});

test("delegation jobs: only running attempts owned by a dead process become orphan candidates", () => {
  const running = makeDelegationJob(contract, { status: "running", detail: "started", ownerPid: 42 });
  const completed = transitionDelegationJob(running, "completed", "done");
  assert.deepEqual(orphanedDelegationJobs([running], () => false).map((j) => j.id), [contract.id]);
  assert.deepEqual(orphanedDelegationJobs([running], (pid) => pid === 42), []);
  assert.deepEqual(orphanedDelegationJobs([running, completed], () => false), []);
});

test("delegation jobs: approval must be user-authored and match contract plus canonical root exactly", () => {
  const exact = approvalStatement(contract.id, "/p/docs");
  const base: DecisionRecord = {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: "dec_33333333-3333-4333-8333-333333333333",
    session: contract.parentSession,
    kind: "durable",
    statement: exact,
    rationale: "approved",
    alternatives: [],
    rejectionReasons: [],
    evidence: [],
    revisitCondition: null,
    supersedes: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    createdBy: "user",
  };
  assert.equal(matchingUserApproval([base], base.id, contract.id, "/p/docs")?.id, base.id);
  assert.equal(matchingUserApproval([{ ...base, createdBy: "coordinator" }], base.id, contract.id, "/p/docs"), null);
  assert.equal(matchingUserApproval([base], base.id, contract.id, "/p/doc"), null);
  assert.equal(matchingUserApproval([base], base.id, "dlg_other", "/p/docs"), null);
});

test("delegation jobs: malformed durable lifecycle records fail closed", () => {
  const running = makeDelegationJob(contract, { status: "running", detail: "started", ownerPid: 42 });
  assert.equal(validateDelegationJob({ ...running, status: "magically-resumed" }), null);
  assert.equal(validateDelegationJob({ ...running, ownerPid: -1 }), null);
  assert.equal(validateDelegationJob({ ...running, id: "dec_wrong-kind" }), null);
});
