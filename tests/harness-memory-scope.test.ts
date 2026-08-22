/**
 * Memory scope (spec section 32), on top of the M1-M6 invariants that
 * tests/harness-records.test.ts already pins.
 *
 * The load-bearing case here is a refusal that produces no error anywhere:
 * a project memory must not surface while working in a different project.
 * Nothing fails when it does - the coordinator simply reads a true-somewhere
 * statement as if it were true here - so the only place that can catch the
 * regression is a test that asserts the absence directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatMemoryEntry,
  promote,
  retrievableMemory,
  searchMemory,
  supersede,
  upgradeMemoryEntry,
} from "../src/harness/memory.ts";
import type { MemoryEntry } from "../src/harness/types.ts";

const at = (iso: string) => () => new Date(iso);
let seq = 0;
const ids = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;

const PROJECT_A = "/home/u/projects/alpha";
const PROJECT_B = "/home/u/projects/beta";

/** Promote and unwrap, so the scope assertions below are not buried in ok checks. */
/**
 * Promote as a caller whose authority matches the draft.
 *
 * The authority argument is threaded from the draft on purpose: these tests
 * are about *scoping*, and a caller authorized for exactly the project it is
 * writing is the ordinary case. The case where they differ is a separate
 * test below, and it is a refusal.
 */
function promoted(draft: Parameters<typeof promote>[1]): MemoryEntry {
  const outcome = promote("user", draft, at("2026-01-01T00:00:00.000Z"), ids, {
    permittedProject: draft.project ?? null,
  });
  assert.ok(outcome.ok, outcome.ok === false ? outcome.reason : "");
  return outcome.entry;
}

/** Supersede as a caller authorized for the entry's own project. */
function supersedeAs(
  actor: Parameters<typeof supersede>[0],
  old: MemoryEntry,
  draft: Parameters<typeof supersede>[2],
  clock?: Parameters<typeof supersede>[3],
  random?: Parameters<typeof supersede>[4],
) {
  return supersede(actor, old, draft, clock, random, { permittedProject: old.project ?? null });
}

/**
 * A record shaped the way v0.1 wrote them: no `scope`, no `project`.
 *
 * The cast is the subject of the test rather than a convenience - this is
 * exactly what a line from a v0.1 memory.jsonl deserializes to, and the
 * reader has to cope with it without being handed the fields.
 */
function v01Entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    schemaVersion: 1,
    id: "mem_legacy",
    category: "env",
    subcategory: null,
    epistemicType: "fact",
    content: "pkexec, never sudo",
    sourceReferences: [],
    createdBy: "user",
    createdAt: "2025-12-01T00:00:00.000Z",
    status: "active",
    supersedes: null,
    ...over,
  } as unknown as MemoryEntry;
}

/* ---------------------------------------------------------------- *
 * Retrieval
 * ---------------------------------------------------------------- */

test("section 32: a project A memory is NOT retrievable while working in project B", () => {
  const alpha = promoted({
    category: "build",
    epistemicType: "fact",
    content: "run codegen before the build",
    scope: "project",
    project: PROJECT_A,
  });

  const inB = retrievableMemory([alpha], PROJECT_B);
  assert.deepEqual(inB, [], "a memory about another repository is not a weak match, it is wrong here");

  // Also absent when there is no project at all, and present in its own.
  assert.deepEqual(retrievableMemory([alpha], null), []);
  assert.deepEqual(
    retrievableMemory([alpha], PROJECT_A).map((entry) => entry.id),
    [alpha.id],
  );
});

test("section 32: a global memory is retrievable in both projects and outside any project", () => {
  const global = promoted({
    category: "tooling",
    epistemicType: "fact",
    content: "pkexec, never sudo",
    scope: "global",
  });

  for (const root of [PROJECT_A, PROJECT_B, null]) {
    assert.deepEqual(
      retrievableMemory([global], root).map((entry) => entry.id),
      [global.id],
      `global entry missing for root ${String(root)}`,
    );
  }
});

test("section 32: retrieval mixes global with the current project only", () => {
  const global = promoted({ category: "tooling", epistemicType: "fact", content: "pkexec", scope: "global" });
  const alpha = promoted({
    category: "build",
    epistemicType: "fact",
    content: "codegen first",
    scope: "project",
    project: PROJECT_A,
  });
  const beta = promoted({
    category: "build",
    epistemicType: "fact",
    content: "vendored deps",
    scope: "project",
    project: PROJECT_B,
  });

  assert.deepEqual(
    retrievableMemory([global, alpha, beta], PROJECT_A).map((entry) => entry.content),
    ["pkexec", "codegen first"],
  );
});

test("section 32: retrieval still drops superseded entries", () => {
  const first = promoted({
    category: "build",
    epistemicType: "fact",
    content: "node 20",
    scope: "project",
    project: PROJECT_A,
  });
  const replaced = supersedeAs(
    "user",
    first,
    { category: "build", epistemicType: "fact", content: "node 24", scope: "project", project: PROJECT_A },
    at("2026-02-01T00:00:00.000Z"),
    ids,
  );
  assert.ok(replaced.ok);

  const view = retrievableMemory([first, replaced.retired, replaced.entry], PROJECT_A);
  assert.deepEqual(
    view.map((entry) => entry.content),
    ["node 24"],
  );
});

test("section 32: a project-scoped entry with no root is retrievable nowhere", () => {
  // Not constructible through promote() - only by hand-editing memory.jsonl -
  // so the reader has to make a call. Invisible is the conservative one.
  const broken = v01Entry({ id: "mem_broken", scope: "project", project: null });
  for (const root of [PROJECT_A, PROJECT_B, null]) {
    assert.deepEqual(retrievableMemory([broken], root), [], `leaked for root ${String(root)}`);
  }
});

/* ---------------------------------------------------------------- *
 * Promotion
 * ---------------------------------------------------------------- */

test("section 32: promote refuses project scope with no project root", () => {
  for (const project of [undefined, null, "   "]) {
    const outcome = promote("user", {
      category: "build",
      epistemicType: "fact",
      content: "codegen first",
      scope: "project",
      project,
    });
    assert.equal(outcome.ok, false, `accepted project root ${JSON.stringify(project)}`);
    assert.equal(outcome.ok === false && outcome.rule, "section 32");
  }
});

test("section 32: promote refuses global scope that carries a project", () => {
  const outcome = promote("user", {
    category: "tooling",
    epistemicType: "fact",
    content: "pkexec",
    scope: "global",
    project: PROJECT_A,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "section 32");
  assert.match(outcome.ok === false ? outcome.reason : "", /cannot also belong to project/);
});

test("section 32: promote refuses a scope this build does not know", () => {
  const outcome = promote("user", {
    category: "tooling",
    epistemicType: "fact",
    content: "pkexec",
    scope: "team" as never,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "section 32");
});

test("section 32: promote records scope and project on the entry", () => {
  const project = promoted({
    category: "build",
    epistemicType: "fact",
    content: "codegen first",
    scope: "project",
    project: PROJECT_A,
  });
  assert.equal(project.scope, "project");
  assert.equal(project.project, PROJECT_A);

  const global = promoted({ category: "tooling", epistemicType: "fact", content: "pkexec", scope: "global" });
  assert.equal(global.scope, "global");
  assert.equal(global.project, null);
});

test("section 32: the scope rules do not soften M1, M3 or M5", () => {
  const wellScoped = {
    category: "build",
    epistemicType: "fact" as const,
    content: "codegen first",
    scope: "project" as const,
    project: PROJECT_A,
  };
  const authority = { permittedProject: PROJECT_A };
  const byCoordinator = promote("coordinator", wellScoped, undefined, undefined, authority);
  assert.equal(byCoordinator.ok === false && byCoordinator.rule, "M1");

  const empty = promote("user", { ...wellScoped, content: "   " }, undefined, undefined, authority);
  assert.equal(empty.ok === false && empty.rule, "M3");

  const uncited = promote("reviewer", wellScoped, undefined, undefined, authority);
  assert.equal(uncited.ok === false && uncited.rule, "M5");
  assert.equal(
    promote("reviewer", { ...wellScoped, sourceReferences: ["ent_1"] }, undefined, undefined, authority).ok,
    true,
  );
});

test("A2: a promotion cannot plant a memory in a project the caller has no authority over", () => {
  // The attack this closes: a retrospective on project A promoting a memory
  // that fires while the user is working in project B. Every other rule
  // passes - real actor, real citation, well-formed project scope - and only
  // the caller's stated authority separates it from a legitimate write.
  const draft = {
    category: "deploy",
    epistemicType: "fact" as const,
    content: "always deploy straight to prod",
    sourceReferences: ["aud_1"],
    scope: "project" as const,
    project: PROJECT_B,
  };
  const crossProject = promote("reviewer", draft, undefined, undefined, { permittedProject: PROJECT_A });
  assert.equal(crossProject.ok, false);
  assert.match(crossProject.ok === false ? crossProject.reason : "", /authorized for/);

  // Unstated authority is refused too, rather than defaulting to the draft's
  // own claim - deny-by-default applied to the caller, not just the actor.
  const unstated = promote("reviewer", draft);
  assert.equal(unstated.ok, false);
  assert.match(unstated.ok === false ? unstated.reason : "", /must state the project/);

  // And the legitimate write still works.
  assert.equal(promote("reviewer", draft, undefined, undefined, { permittedProject: PROJECT_B }).ok, true);
});

/* ---------------------------------------------------------------- *
 * Supersession
 * ---------------------------------------------------------------- */

test("section 32: a project memory cannot be superseded by a global one", () => {
  const alpha = promoted({
    category: "build",
    epistemicType: "fact",
    content: "codegen first",
    scope: "project",
    project: PROJECT_A,
  });
  const outcome = supersedeAs("user", alpha, {
    category: "build",
    epistemicType: "fact",
    content: "codegen first, everywhere",
    scope: "global",
  });
  assert.equal(outcome.ok, false, "a supersession must not widen where the claim applies");
  assert.equal(outcome.ok === false && outcome.rule, "section 32");
});

test("section 32: a global memory cannot be superseded by a project-scoped one", () => {
  const global = promoted({ category: "tooling", epistemicType: "fact", content: "pkexec", scope: "global" });
  const outcome = supersedeAs("user", global, {
    category: "tooling",
    epistemicType: "fact",
    content: "pkexec here",
    scope: "project",
    project: PROJECT_A,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "section 32");
});

test("section 32: a project memory cannot be moved to another project by supersession", () => {
  const alpha = promoted({
    category: "build",
    epistemicType: "fact",
    content: "codegen first",
    scope: "project",
    project: PROJECT_A,
  });
  const outcome = supersedeAs("user", alpha, {
    category: "build",
    epistemicType: "fact",
    content: "codegen first",
    scope: "project",
    project: PROJECT_B,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.rule, "section 32");
});

test("section 32: supersession carries scope and project forward when the draft is silent", () => {
  const alpha = promoted({
    category: "build",
    epistemicType: "fact",
    content: "node 20",
    scope: "project",
    project: PROJECT_A,
  });
  const outcome = supersedeAs(
    "user",
    alpha,
    { category: "build", epistemicType: "fact", content: "node 24" } as never,
    at("2026-02-01T00:00:00.000Z"),
    ids,
  );
  assert.ok(outcome.ok);
  assert.equal(outcome.entry.scope, "project");
  assert.equal(outcome.entry.project, PROJECT_A);
  assert.equal(outcome.entry.supersedes, alpha.id);
  assert.equal(outcome.retired.status, "superseded");
  assert.equal(outcome.retired.content, "node 20", "M4 still holds");
});

test("section 32: superseding a v0.1 entry keeps it global rather than binding it to the current project", () => {
  const legacy = v01Entry();
  const outcome = supersedeAs(
    "user",
    legacy,
    { category: "env", epistemicType: "fact", content: "pkexec, and wrap it in timeout" } as never,
    at("2026-02-01T00:00:00.000Z"),
    ids,
  );
  assert.ok(outcome.ok);
  assert.equal(outcome.entry.scope, "global");
  assert.equal(outcome.entry.project, null);
});

/* ---------------------------------------------------------------- *
 * v0.1 upgrade
 * ---------------------------------------------------------------- */

test("section 32: upgradeMemoryEntry reads a v0.1 entry as global", () => {
  const upgraded = upgradeMemoryEntry(v01Entry());
  assert.equal(upgraded.scope, "global");
  assert.equal(upgraded.project, null);
  assert.equal(upgraded.content, "pkexec, never sudo", "upgrading is not rewriting");
  assert.equal(upgraded.schemaVersion, 1, "the record still says which version wrote it");
  // Global is the behaviour v0.1 actually had: one file, returned everywhere.
  assert.deepEqual(
    retrievableMemory([upgraded], PROJECT_B).map((entry) => entry.id),
    [upgraded.id],
  );
});

test("section 32: upgradeMemoryEntry leaves an already-scoped entry alone", () => {
  const scoped = promoted({
    category: "build",
    epistemicType: "fact",
    content: "codegen first",
    scope: "project",
    project: PROJECT_A,
  });
  assert.equal(upgradeMemoryEntry(scoped), scoped, "no copy, no change");
});

/* ---------------------------------------------------------------- *
 * Search and rendering
 * ---------------------------------------------------------------- */

test("section 32: searchMemory honours the project filter", () => {
  const global = promoted({ category: "build", epistemicType: "fact", content: "codegen is global", scope: "global" });
  const alpha = promoted({
    category: "build",
    epistemicType: "fact",
    content: "codegen in alpha",
    scope: "project",
    project: PROJECT_A,
  });
  const beta = promoted({
    category: "build",
    epistemicType: "fact",
    content: "codegen in beta",
    scope: "project",
    project: PROJECT_B,
  });
  const log = [global, alpha, beta];

  assert.deepEqual(
    searchMemory(log, "codegen", 20, PROJECT_A).map((entry) => entry.content),
    ["codegen is global", "codegen in alpha"],
  );
  assert.deepEqual(
    searchMemory(log, "codegen", 20, null).map((entry) => entry.content),
    ["codegen is global"],
    "outside a project, only global entries answer",
  );
});

test("section 32: an omitted projectRoot searches everything, as v0.1 callers expect", () => {
  const global = promoted({ category: "build", epistemicType: "fact", content: "codegen is global", scope: "global" });
  const alpha = promoted({
    category: "build",
    epistemicType: "fact",
    content: "codegen in alpha",
    scope: "project",
    project: PROJECT_A,
  });
  // Omitted is not the same request as null: it is the unscoped legacy path.
  assert.equal(searchMemory([global, alpha], "codegen").length, 2);
  assert.equal(searchMemory([global, alpha], "codegen", 1).length, 1, "the limit still applies");
});

test("section 32: the rendering names the scope, and still names the epistemic type", () => {
  const alpha = promoted({
    category: "build",
    epistemicType: "opinion",
    content: "codegen first",
    scope: "project",
    project: PROJECT_A,
  });
  const line = formatMemoryEntry(alpha);
  assert.match(line, /\(opinion\)/, "M3 rendering is unchanged");
  assert.match(line, new RegExp(`project ${PROJECT_A}`));

  const global = promoted({ category: "tooling", epistemicType: "fact", content: "pkexec", scope: "global" });
  assert.match(formatMemoryEntry(global), /global/);
  assert.doesNotMatch(formatMemoryEntry(global), /project/);
});
