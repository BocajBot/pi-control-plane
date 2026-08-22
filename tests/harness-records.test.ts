/**
 * Memory (M1-M6), decision (D1-D4), incident (I1-I6) and task (T1-T4)
 * invariants from spec section 27.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeMemory,
  formatMemoryEntry,
  historyOf,
  promote,
  searchMemory,
  supersede,
} from "../src/harness/memory.ts";
import {
  activeDecisions,
  expiredDecisions,
  formatIncident,
  makeDecision,
  makeIncident,
  recordCorrection,
  reopen,
  similarIncidents,
} from "../src/harness/records.ts";
import { createScope } from "../src/harness/scope.ts";
import { createTask, formatTask, markValidated, queuedFor, transition, upsert } from "../src/harness/tasks.ts";
import type { Actor, MemoryEntry } from "../src/harness/types.ts";

const at = (iso: string) => () => new Date(iso);
let seq = 0;
const ids = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;

/* ---------------------------------------------------------------- *
 * Memory
 * ---------------------------------------------------------------- */

test("M1: only the user and the reviewer may write durable memory", () => {
  const draft = { category: "project", epistemicType: "fact" as const, content: "x", sourceReferences: ["e1"] };
  for (const actor of ["coordinator", "advisor", "subagent", "core"] as Actor[]) {
    const outcome = promote(actor, draft);
    assert.equal(outcome.ok, false, actor);
    assert.equal(outcome.ok === false && outcome.rule, "M1");
  }
  assert.equal(promote("user", draft).ok, true);
  assert.equal(promote("reviewer", draft).ok, true);
});

test("M5: a reviewer promotion without citations is refused; a user's is not", () => {
  const uncited = { category: "project", epistemicType: "fact" as const, content: "x" };
  const outcome = promote("reviewer", uncited);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "M5");

  // The user's direction is itself the source.
  assert.equal(promote("user", uncited).ok, true);
});

test("M3: the epistemic type survives into the rendering", () => {
  const outcome = promote("user", { category: "style", epistemicType: "opinion", content: "prefer tabs" });
  assert.ok(outcome.ok);
  assert.match(formatMemoryEntry(outcome.entry), /\(opinion\)/);
});

test("M4: supersession retires the old entry without erasing its content", () => {
  const first = promote("user", { category: "env", epistemicType: "fact", content: "node 20" }, at("2026-01-01T00:00:00.000Z"), ids);
  assert.ok(first.ok);

  const replaced = supersede(
    "user",
    first.entry,
    { category: "env", epistemicType: "fact", content: "node 24" },
    at("2026-02-01T00:00:00.000Z"),
    ids,
  );
  assert.ok(replaced.ok);
  assert.equal(replaced.entry.supersedes, first.entry.id);
  assert.equal(replaced.retired.status, "superseded");
  assert.equal(replaced.retired.content, "node 20", "history keeps what used to be true");

  const log = [first.entry, replaced.retired, replaced.entry];
  const active = activeMemory(log);
  assert.equal(active.length, 1);
  assert.equal(active[0].content, "node 24");
});

test("M4: an already-superseded entry cannot be superseded again", () => {
  const entry: MemoryEntry = {
    schemaVersion: 1,
    id: "mem_1",
    category: "c",
    subcategory: null,
    epistemicType: "fact",
    content: "old",
    sourceReferences: [],
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "superseded",
    supersedes: null,
  };
  const outcome = supersede("user", entry, { category: "c", epistemicType: "fact", content: "new" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "M4");
});

test("M6: the supersession chain stays walkable in both directions", () => {
  const a = promote("user", { category: "c", epistemicType: "fact", content: "v1" }, at("2026-01-01T00:00:00.000Z"), ids);
  assert.ok(a.ok);
  const b = supersede("user", a.entry, { category: "c", epistemicType: "fact", content: "v2" }, at("2026-01-02T00:00:00.000Z"), ids);
  assert.ok(b.ok);
  const c = supersede("user", b.entry, { category: "c", epistemicType: "fact", content: "v3" }, at("2026-01-03T00:00:00.000Z"), ids);
  assert.ok(c.ok);

  const log = [a.entry, b.retired, b.entry, c.retired, c.entry];
  const chain = historyOf(log, c.entry.id).map((entry) => entry.content);
  assert.deepEqual(chain, ["v3", "v2", "v1"]);
});

test("searchMemory: only the active view is searchable", () => {
  const a = promote("user", { category: "env", epistemicType: "fact", content: "node 20" }, at("2026-01-01T00:00:00.000Z"), ids);
  assert.ok(a.ok);
  const b = supersede("user", a.entry, { category: "env", epistemicType: "fact", content: "node 24" }, at("2026-02-01T00:00:00.000Z"), ids);
  assert.ok(b.ok);
  const results = searchMemory([a.entry, b.retired, b.entry], "node");
  assert.equal(results.length, 1);
  assert.equal(results[0].content, "node 24");
});

/* ---------------------------------------------------------------- *
 * Decisions
 * ---------------------------------------------------------------- */

const decisionDraft = {
  session: "ses_1",
  kind: "durable" as const,
  statement: "use JSONL for audit",
  rationale: "append-only is the invariant, and JSONL appends without a rewrite",
  alternatives: ["sqlite"],
  rejectionReasons: ["a database makes rewriting easy, which AU1 forbids"],
  createdBy: "user" as Actor,
};

test("D1: a decision without a rationale is refused", () => {
  const outcome = makeDecision({ ...decisionDraft, rationale: "  " });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "D1");
});

test("D2: rejected alternatives stay on the record", () => {
  const outcome = makeDecision(decisionDraft);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.decision.alternatives, ["sqlite"]);
  assert.equal(outcome.decision.rejectionReasons.length, 1);
});

test("D3: a temporary decision without a revisit condition is refused", () => {
  const outcome = makeDecision({ ...decisionDraft, kind: "temporary" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "D3");

  const ok = makeDecision({ ...decisionDraft, kind: "temporary", revisitCondition: "2026-12-01" });
  assert.equal(ok.ok, true);
});

test("D4: reopening creates a new record and leaves the original untouched", () => {
  const first = makeDecision(decisionDraft, at("2026-01-01T00:00:00.000Z"), ids);
  assert.ok(first.ok);
  const frozen = { ...first.decision };

  const second = reopen(
    first.decision,
    { ...decisionDraft, statement: "use sqlite after all", rationale: "measured append latency" },
    at("2026-06-01T00:00:00.000Z"),
    ids,
  );
  assert.ok(second.ok);
  assert.equal(second.decision.supersedes, first.decision.id);
  assert.deepEqual(first.decision, frozen, "the original record must not be mutated");

  const active = activeDecisions([first.decision, second.decision]);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, second.decision.id);
});

test("expiredDecisions: only parseable dates expire; prose conditions never do", () => {
  const dated = makeDecision(
    { ...decisionDraft, kind: "temporary", revisitCondition: "2026-01-01" },
    at("2026-01-01T00:00:00.000Z"),
    ids,
  );
  const prose = makeDecision(
    { ...decisionDraft, kind: "temporary", revisitCondition: "when the migration lands" },
    at("2026-01-01T00:00:00.000Z"),
    ids,
  );
  assert.ok(dated.ok && prose.ok);
  const expired = expiredDecisions([dated.decision, prose.decision], at("2026-08-01T00:00:00.000Z"));
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, dated.decision.id);
});

/* ---------------------------------------------------------------- *
 * Incidents
 * ---------------------------------------------------------------- */

const incidentDraft = {
  session: "ses_1",
  description: "edited a file outside the task scope",
  severity: "moderate" as const,
  detectedBy: "user" as Actor,
  model: { provider: "llama-swap", model: "model-a" },
  reasoningMode: "balanced" as const,
  observedEffect: "config.yaml changed although the task named only src/",
  suspectedCause: "model" as const,
};

test("I2: observed effect and suspected cause are separate required fields", () => {
  const outcome = makeIncident({ ...incidentDraft, observedEffect: "" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "I2");

  const ok = makeIncident(incidentDraft);
  assert.ok(ok.ok);
  assert.notEqual(ok.incident.observedEffect, ok.incident.suspectedCause);
});

test("I1: recording a correction leaves the incident and its original effect intact", () => {
  const outcome = makeIncident(incidentDraft, at("2026-01-01T00:00:00.000Z"), ids);
  assert.ok(outcome.ok);
  const corrected = recordCorrection(outcome.incident, "reverted the file", "scope respected since");
  assert.equal(corrected.correction, "reverted the file");
  assert.equal(corrected.description, incidentDraft.description);
  assert.equal(corrected.observedEffect, incidentDraft.observedEffect);
  assert.equal(outcome.incident.correction, null, "the original record is not mutated");
});

test("I3/MO2: similar incidents are matched by cause and model, not by wording", () => {
  const a = makeIncident(incidentDraft, at("2026-01-01T00:00:00.000Z"), ids);
  const sameCauseSameModel = makeIncident(
    { ...incidentDraft, description: "different words entirely" },
    at("2026-01-02T00:00:00.000Z"),
    ids,
  );
  const sameWordsOtherModel = makeIncident(
    { ...incidentDraft, model: { provider: "llama-swap", model: "model-b" } },
    at("2026-01-03T00:00:00.000Z"),
    ids,
  );
  const sameModelOtherCause = makeIncident(
    { ...incidentDraft, suspectedCause: "tool" },
    at("2026-01-04T00:00:00.000Z"),
    ids,
  );
  assert.ok(a.ok && sameCauseSameModel.ok && sameWordsOtherModel.ok && sameModelOtherCause.ok);

  const similar = similarIncidents(
    [a.incident, sameCauseSameModel.incident, sameWordsOtherModel.incident, sameModelOtherCause.incident],
    a.incident,
  );
  assert.deepEqual(similar.map((i) => i.id), [sameCauseSameModel.incident.id]);
});

test("I3: \"unknown\" is a valid cause, so no guess is required", () => {
  const outcome = makeIncident({ ...incidentDraft, suspectedCause: "unknown" });
  assert.ok(outcome.ok);
  assert.match(formatIncident(outcome.incident), /suspected cause: unknown/);
});

/* ---------------------------------------------------------------- *
 * Tasks
 * ---------------------------------------------------------------- */

const scope = createScope("/home/u/proj/src", "user");
const taskDraft = {
  objective: "add the retry path",
  project: "/home/u/proj",
  scope,
  autonomy: "guided" as const,
  approvalPolicy: "mutations" as const,
  createdBy: "user" as Actor,
  originSession: "ses_1",
};

test("T2: a task freezes its authority envelope at creation", () => {
  const task = createTask(taskDraft, at("2026-01-01T00:00:00.000Z"), ids);
  // Widening the session scope afterwards must not reach the queued task.
  scope.allowedRoots.push("/home/u");
  assert.deepEqual(task.scope.allowedRoots, ["/home/u/proj/src"]);
});

test("T3: illegal transitions are refused, and done is terminal", () => {
  const task = createTask(taskDraft, at("2026-01-01T00:00:00.000Z"), ids);
  assert.equal(transition(task, "done").ok, false, "queued cannot jump straight to done");

  const active = transition(task, "active");
  assert.ok(active.ok);
  const done = transition(active.task, "done");
  assert.ok(done.ok);
  assert.equal(transition(done.task, "active").ok, false, "done is terminal");
});

test("T4: claimed completion and validated completion are distinct", () => {
  const task = createTask(taskDraft, at("2026-01-01T00:00:00.000Z"), ids);
  const active = transition(task, "active");
  assert.ok(active.ok);
  const done = transition(active.task, "done");
  assert.ok(done.ok);
  assert.equal(done.task.validatedAt, null);
  assert.match(formatTask(done.task), /claimed, unvalidated/);

  assert.equal(markValidated(done.task, "   ").ok, false, "validation needs evidence");

  const validated = markValidated(done.task, "npm test: 226 pass 0 fail", at("2026-01-02T00:00:00.000Z"));
  assert.ok(validated.ok);
  assert.equal(validated.task.validatedAt, "2026-01-02T00:00:00.000Z");
});

test("T4: a task cannot be validated before it is claimed done", () => {
  const task = createTask(taskDraft, at("2026-01-01T00:00:00.000Z"), ids);
  assert.equal(markValidated(task, "tests pass").ok, false);
});

test("queuedFor: the queue is per project and ordered oldest first", () => {
  const a = createTask(taskDraft, at("2026-01-01T00:00:00.000Z"), ids);
  const b = createTask(taskDraft, at("2026-01-02T00:00:00.000Z"), ids);
  const other = createTask({ ...taskDraft, project: "/home/u/other" }, at("2026-01-03T00:00:00.000Z"), ids);
  const tasks = upsert(upsert(upsert([], b), a), other);
  assert.deepEqual(queuedFor(tasks, "/home/u/proj").map((t) => t.id), [a.id, b.id]);
});
