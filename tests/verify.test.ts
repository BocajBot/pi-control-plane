/**
 * Tests for the completion-criteria verification pass (verify.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCompletion } from "../src/control-plane/verify.ts";
import type { TaskBrief } from "../src/control-plane/types.ts";

function brief(deliverables: string[], completionCriteria: string[]): TaskBrief {
  return {
    id: "t1",
    objective: "objective",
    deliverables,
    includedScope: [],
    excludedScope: [],
    constraints: [],
    assumptions: [],
    unknowns: [],
    completionCriteria,
    approvalBoundaries: [],
    sourceRequest: "request",
    source: "direct",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("a written deliverable reports satisfied; an unwritten one reports missing", () => {
  const report = verifyCompletion({
    brief: brief(["src/foo.ts", "src/bar.ts"], []),
    writtenFiles: ["src/foo.ts"],
    auditEntries: [],
    fileExists: () => false,
  });
  assert.equal(report.deliverables.length, 2);
  assert.equal(report.deliverables[0].satisfied, true);
  assert.equal(report.deliverables[0].evidence, "written (src/foo.ts)");
  assert.equal(report.deliverables[1].satisfied, false);
  assert.equal(report.deliverables[1].evidence, "not written and not found (src/bar.ts)");
});

test("an existing-on-disk deliverable reports satisfied even when not written", () => {
  const report = verifyCompletion({
    brief: brief(["src/bar.ts"], []),
    writtenFiles: [],
    auditEntries: [],
    fileExists: (p) => p === "src/bar.ts",
  });
  assert.equal(report.deliverables[0].satisfied, true);
  assert.equal(report.deliverables[0].evidence, "exists on disk (src/bar.ts)");
});

test("a basename match counts a written path as satisfying the deliverable", () => {
  const report = verifyCompletion({
    brief: brief(["/abs/src/foo.ts"], []),
    writtenFiles: ["src/foo.ts"],
    auditEntries: [],
    fileExists: () => false,
  });
  assert.equal(report.deliverables[0].satisfied, true);
});

test("completion criteria matched by an audit entry count as satisfied", () => {
  const report = verifyCompletion({
    brief: brief([], ["tests pass"]),
    writtenFiles: [],
    auditEntries: [{ kind: "unattended-call-allowed", toolName: "bash", command: "ran npm tests; tests pass" }],
    fileExists: () => false,
  });
  assert.equal(report.completionCriteria.length, 1);
  assert.equal(report.completionCriteria[0].satisfied, true);
});

test("unmatched deliverables and criteria are reported as missing", () => {
  const report = verifyCompletion({
    brief: brief(["src/bar.ts"], ["docs written"]),
    writtenFiles: [],
    auditEntries: [{ kind: "unattended-call-allowed", toolName: "bash", command: "ls" }],
    fileExists: () => false,
  });
  assert.equal(report.deliverables[0].satisfied, false);
  assert.equal(report.completionCriteria[0].satisfied, false);
  assert.equal(report.satisfiedDeliverables, 0);
  assert.equal(report.satisfiedCriteria, 0);
});

test("empty brief verifies to zero totals", () => {
  const report = verifyCompletion({
    brief: brief([], []),
    writtenFiles: [],
    auditEntries: [],
    fileExists: () => false,
  });
  assert.equal(report.totalDeliverables, 0);
  assert.equal(report.totalCriteria, 0);
});
