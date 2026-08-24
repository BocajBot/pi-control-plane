/**
 * Audit invariants AU1-AU5, recovery invariants R1-R5, and the storage
 * layer that carries them.
 *
 * The store tests use a real temp directory rather than a fake filesystem.
 * The properties under test - atomic replacement, an append that survives,
 * a truncated trailing line - are properties of the filesystem, and a fake
 * would only be testing the fake.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { formatAuditEvent, makeAuditEvent, makeCorrectionEvent, validateAuditEvent } from "../src/harness/audit.ts";
import { defaultConfig, harnessPaths, modelAgentsFile, validateConfig } from "../src/harness/config.ts";
import { inferProjectRoot, type ProjectFsOps } from "../src/harness/project.ts";
import { createScope } from "../src/harness/scope.ts";
import { builtinBashBlocked, plan, withoutBuiltinBash, type SandboxProbe } from "../src/harness/sandbox.ts";
import { addNote, checkpoint, createSession, reconcile, switchCoordinator } from "../src/harness/state.ts";
import { appendJsonl, HarnessStore, readJsonl, writeAtomic } from "../src/harness/store.ts";
import { HARNESS_SCHEMA_VERSION, type AuditEvent } from "../src/harness/types.ts";
import { renderWorkstate } from "../src/harness/workstate.ts";

const at = (iso: string) => () => new Date(iso);
let seq = 0;
const ids = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;

const tmpRoots: string[] = [];
function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-test-"));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const scope = createScope("/home/u/proj", "user", {}, at("2026-01-01T00:00:00.000Z"));

function session() {
  return createSession(
    {
      projectRoot: "/home/u/proj",
      deviceId: "dev_test",
      scope,
      reasoningMode: "balanced",
      autonomy: "guided",
      approvalPolicy: "mutations",
      coordinator: { provider: "llama-swap", model: "model-a" },
    },
    at("2026-01-01T00:00:00.000Z"),
    ids,
  );
}

/* ---------------------------------------------------------------- *
 * Audit
 * ---------------------------------------------------------------- */

const ctx = {
  session: "ses_1",
  actor: "coordinator" as const,
  actorModel: { provider: "llama-swap", model: "model-a" },
  scope,
};

test("AU2: a model-driven event carries its model; a user event never does", () => {
  const byModel = makeAuditEvent(ctx, { eventType: "tool_call", request: "read x", result: "ok" }, at("2026-01-01T00:00:00.000Z"), ids);
  assert.equal(byModel.actorModel?.model, "model-a");

  const byUser = makeAuditEvent(
    { ...ctx, actor: "user" },
    { eventType: "config_change", request: "set autonomy", result: "ok" },
    at("2026-01-01T00:00:00.000Z"),
    ids,
  );
  assert.equal(byUser.actorModel, null, "a user action must never be attributed to a model");
});

test("AU1: a correction is a new event that points at the original", () => {
  const original = makeAuditEvent(ctx, { eventType: "tool_call", request: "read x", result: "ok" }, at("2026-01-01T00:00:00.000Z"), ids);
  const correction = makeCorrectionEvent(
    ctx,
    original.id,
    { eventType: "tool_call", request: "read x", result: "actually failed" },
    at("2026-01-01T00:01:00.000Z"),
    ids,
  );
  assert.notEqual(correction.id, original.id);
  assert.equal(correction.metadata.corrects, original.id);
  assert.equal(original.result, "ok", "the original event is not edited");
});

test("AU5: an audit line from a newer schema is preserved, not discarded", () => {
  const future = validateAuditEvent({
    schemaVersion: 99,
    id: "aud_x",
    timestamp: "2026-01-01T00:00:00.000Z",
    session: "ses_1",
    actor: "coordinator",
    actorModel: null,
    eventType: "something_new",
    request: "r",
    result: "s",
    scope: "/x",
    metadata: {},
    extraFieldFromTheFuture: true,
  });
  assert.notEqual(future, null, "evidence must not be dropped to satisfy a schema");
  assert.equal(future?.eventType, "something_new");
});

test("validateAuditEvent: a structurally broken line is rejected", () => {
  assert.equal(validateAuditEvent({ id: 7 }), null);
  assert.equal(validateAuditEvent("nope"), null);
  assert.equal(validateAuditEvent(null), null);
});

test("formatAuditEvent: one readable line including the acting model", () => {
  const event = makeAuditEvent(ctx, { eventType: "tool_call", request: "read x", result: "ok" }, at("2026-01-01T00:00:00.000Z"), ids);
  assert.match(formatAuditEvent(event), /coordinator\(model-a\) tool_call: read x -> ok/);
});

/* ---------------------------------------------------------------- *
 * Store
 * ---------------------------------------------------------------- */

function storeAt(root: string): HarnessStore {
  const store = new HarnessStore(harnessPaths(root, path.join(root, "proj"), { PI_HARNESS_HOME: path.join(root, "harness") }));
  store.init();
  return store;
}

test("AU1: appended audit lines accumulate and read back in order", () => {
  const store = storeAt(tmpdir());
  for (let i = 0; i < 3; i++) {
    store.appendAudit(
      makeAuditEvent(ctx, { eventType: "checkpoint", request: `n=${i}`, result: "ok" }, at(`2026-01-0${i + 1}T00:00:00.000Z`), ids),
    );
  }
  const { records, invalid, truncatedTail } = store.readAudit();
  assert.equal(records.length, 3);
  assert.equal(invalid, 0);
  assert.equal(truncatedTail, false);
  assert.deepEqual(records.map((r) => r.request), ["n=0", "n=1", "n=2"]);
});

test("R4: a truncated final line is reported as truncated, and the intact prefix survives", () => {
  const dir = tmpdir();
  const store = storeAt(dir);
  store.appendAudit(makeAuditEvent(ctx, { eventType: "checkpoint", request: "complete", result: "ok" }, at("2026-01-01T00:00:00.000Z"), ids));
  // Simulate a process killed mid-append: a partial line with no newline.
  fs.appendFileSync(store.paths.auditFile, '{"schemaVersion":1,"id":"aud_par');

  const result = store.readAudit();
  assert.equal(result.records.length, 1, "the complete line is kept");
  assert.equal(result.truncatedTail, true);
  assert.equal(result.invalid, 0, "a truncated tail is not the same as an invalid line");
});

test("a malformed line in the middle counts as invalid, not as a truncated tail", () => {
  const dir = tmpdir();
  const file = path.join(dir, "records.jsonl");
  fs.writeFileSync(file, `{"schemaVersion":1,"id":"a"}\nnot json\n{"schemaVersion":1,"id":"b"}\n`);
  const result = readJsonl<{ id: string }>(file, (value) =>
    typeof value === "object" && value !== null && "id" in value ? (value as { id: string }) : null,
  );
  assert.deepEqual(result.records.map((r) => r.id), ["a", "b"]);
  assert.equal(result.invalid, 1);
  assert.equal(result.truncatedTail, false);
});

test("R5: writeAtomic leaves no partial file behind and replaces in place", () => {
  const dir = tmpdir();
  const file = path.join(dir, "nested", "state.json");
  writeAtomic(file, "first");
  writeAtomic(file, "second");
  assert.equal(fs.readFileSync(file, "utf8"), "second");
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp.")),
    [],
    "no temp file may be left behind",
  );
});

test("store: session state round-trips, and a wrong schema version reads back as null", () => {
  const store = storeAt(tmpdir());
  const state = session();
  store.writeSessionState(state);
  assert.equal(store.readSessionState()?.id, state.id);

  writeAtomic(store.paths.sessionStateFile, JSON.stringify({ ...state, schemaVersion: 99 }));
  assert.equal(store.readSessionState(), null, "an unknown version is rejected, never migrated in place");
});

test("store: tasks and the review queue round-trip; unparseable entries are dropped", () => {
  const store = storeAt(tmpdir());
  store.writeTasks([]);
  assert.deepEqual(store.readTasks(), []);

  writeAtomic(store.paths.tasksFile, JSON.stringify([{ schemaVersion: 1, id: "tsk_1" }, { nope: true }]));
  assert.equal(store.readTasks().length, 1);

  writeAtomic(store.paths.reviewQueueFile, "not json at all");
  assert.deepEqual(store.readReviewQueue(), []);
});

test("store: a missing file reads as empty rather than throwing", () => {
  const store = storeAt(tmpdir());
  assert.deepEqual(store.readAudit().records, []);
  assert.deepEqual(store.readDecisions().records, []);
  assert.equal(store.readWorkstate(), null);
  assert.equal(store.readSessionState(), null);
});

test("appendJsonl: every record is newline-terminated so the next append cannot merge", () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.jsonl");
  appendJsonl(file, { a: 1 });
  appendJsonl(file, { a: 2 });
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}\n{"a":2}\n');
});

/* ---------------------------------------------------------------- *
 * Config and layout
 * ---------------------------------------------------------------- */

test("config: the layout matches spec section 28", () => {
  const paths = harnessPaths("/home/u", "/home/u/proj", {});
  assert.equal(paths.home, "/home/u/.pi/agent/pi-harness");
  assert.equal(paths.configFile, "/home/u/.pi/agent/pi-harness/config.json");
  assert.equal(paths.memoryFile, "/home/u/.pi/agent/pi-harness/memory.jsonl");
  assert.equal(paths.workstateFile, "/home/u/proj/.pi/WORKSTATE.md");
  assert.match(paths.sessionStateFile, /projects\/proj-[0-9a-f]{12}\/session-state\.json$/);
});

test("config: two checkouts with the same basename get different project directories", () => {
  const a = harnessPaths("/home/u", "/home/u/work/api", {});
  const b = harnessPaths("/home/u", "/home/u/scratch/api", {});
  assert.notEqual(a.projectDir, b.projectDir);
});

test("config: a model directory is one directory per model, slashes flattened", () => {
  const paths = harnessPaths("/home/u", "/home/u/proj", {});
  const file = modelAgentsFile(paths, { provider: "openrouter", model: "meta-llama/Llama-3.3" });
  assert.match(file, /models\/openrouter__meta-llama-Llama-3\.3\/AGENTS\.md$/);
});

test("config: defaults are guided autonomy with mutation approval, and no sandbox mounts assumed", () => {
  const config = defaultConfig(at("2026-01-01T00:00:00.000Z"));
  assert.equal(config.defaultAutonomy, "guided");
  assert.equal(config.defaultApprovalPolicy, "mutations");
  assert.deepEqual(config.sandboxReadOnlyPaths, []);
});

test("config: validation rejects an unknown key rather than accepting a partial config", () => {
  const config = defaultConfig(at("2026-01-01T00:00:00.000Z"));
  assert.notEqual(validateConfig({ ...config }), null);
  assert.equal(validateConfig({ ...config, surprise: 1 }), null);
  assert.equal(validateConfig({ ...config, defaultAutonomy: "godmode" }), null);
  assert.equal(validateConfig({ ...config, schemaVersion: HARNESS_SCHEMA_VERSION + 1 }), null);
});

/* ---------------------------------------------------------------- *
 * Project inference
 * ---------------------------------------------------------------- */

/** Directories are declared explicitly rather than guessed from the name: a
 * dot in the basename does not mean "file" (`.pi` and `.git` are both
 * directories), and a fixture that assumes it silently mis-answers the one
 * question this test asks. */
function fakeTree(files: string[], dirs: string[] = []): ProjectFsOps {
  const all = new Set([...files, ...dirs]);
  const dirSet = new Set(dirs);
  return { exists: (p) => all.has(p), isDirectory: (p) => dirSet.has(p) };
}

test("project: an explicit .pi directory wins over everything above it", () => {
  const ops = fakeTree([], ["/home/u/proj/.git", "/home/u/proj/sub/.pi"]);
  const result = inferProjectRoot("/home/u/proj/sub/deep", "/home/u", ops);
  assert.equal(result.root, "/home/u/proj/sub");
  assert.equal(result.reason, "pi-directory");
});

test("project: the outermost VCS root wins, so a submodule stays part of its parent", () => {
  const ops = fakeTree([], ["/home/u/outer/.git", "/home/u/outer/inner/.git"]);
  const result = inferProjectRoot("/home/u/outer/inner/src", "/home/u", ops);
  assert.equal(result.root, "/home/u/outer");
  assert.equal(result.reason, "vcs-root");
});

test("project: a package marker is used when there is no VCS root", () => {
  const ops = fakeTree(["/home/u/proj/package.json"]);
  const result = inferProjectRoot("/home/u/proj/src", "/home/u", ops);
  assert.equal(result.root, "/home/u/proj");
  assert.equal(result.marker, "package.json");
});

test("project: with no markers at all, inference stops at the start directory, never at $HOME", () => {
  const result = inferProjectRoot("/home/u/loose/dir", "/home/u", fakeTree([]));
  assert.equal(result.root, "/home/u/loose/dir");
  assert.equal(result.reason, "start-directory");
});

// Decision A1 (2026-08-23): a nearer project marker outranks a farther ancestor
// `.pi/` such as a home-level `~/.pi`; a bare directory with no local marker
// still falls back to that ancestor `.pi/` as before.

test("A1: a project-local .git outranks an ancestor .pi home", () => {
  const ops = fakeTree([], ["/home/u/.pi", "/home/u/proj/.git"]);
  const result = inferProjectRoot("/home/u/proj/src", "/home/u", ops);
  assert.equal(result.root, "/home/u/proj");
  assert.equal(result.reason, "vcs-root");
  assert.equal(result.marker, ".git");
});

test("A1: a project-local .pi outranks an ancestor .pi home", () => {
  const ops = fakeTree([], ["/home/u/.pi", "/home/u/proj/.pi"]);
  const result = inferProjectRoot("/home/u/proj/src", "/home/u", ops);
  assert.equal(result.root, "/home/u/proj");
  assert.equal(result.reason, "pi-directory");
});

test("A1: a bare directory under $HOME still resolves to the ancestor .pi home", () => {
  const ops = fakeTree([], ["/home/u/.pi"]);
  const result = inferProjectRoot("/home/u/scratch/work", "/home/u", ops);
  assert.equal(result.root, "/home/u");
  assert.equal(result.reason, "pi-directory");
});

test("A1: an explicit .pi at the same depth as .git still wins (override unaffected)", () => {
  const ops = fakeTree([], ["/home/u/.pi", "/home/u/proj/.pi", "/home/u/proj/.git"]);
  const result = inferProjectRoot("/home/u/proj/src", "/home/u", ops);
  assert.equal(result.root, "/home/u/proj");
  assert.equal(result.reason, "pi-directory");
});

/* ---------------------------------------------------------------- *
 * Sandbox boundary
 * ---------------------------------------------------------------- */

const available: SandboxProbe = { bwrapAvailable: () => true, exists: () => true };
const config = { ...defaultConfig(at("2026-01-01T00:00:00.000Z")), sandboxReadOnlyPaths: ["/usr", "/etc"] };

test("section 9: with no bubblewrap the shell refuses instead of falling back", () => {
  const outcome = plan("ls", scope, config, "/home/u/proj", { bwrapAvailable: () => false, exists: () => true });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.reason : "", /refuses to run rather than fall back/);
});

test("section 9: read-only by default - the scope root is mounted read-only, nothing is writable", () => {
  const outcome = plan("wc -l x", scope, config, "/home/u/proj", available);
  assert.ok(outcome.ok);
  assert.equal(outcome.mounts.writable, false);
  assert.equal(outcome.mounts.readWrite, "(none: read-only)");
  assert.match(outcome.command, /'--ro-bind' '\/home\/u\/proj' '\/home\/u\/proj'/);
  assert.ok(!outcome.command.includes("'--bind' '/home/u/proj'"), "the scope root is not read-write bound in read mode");
  assert.equal(outcome.mounts.network, false);
  assert.match(outcome.command, /--unshare-all/);
});

test("section 9: mode write makes the scope root the only read-write mount, network still off", () => {
  const outcome = plan("touch f", scope, config, "/home/u/proj", available, { writable: true });
  assert.ok(outcome.ok);
  assert.equal(outcome.mounts.writable, true);
  assert.equal(outcome.mounts.readWrite, "/home/u/proj");
  assert.equal(outcome.mounts.network, false);
  assert.match(outcome.command, /--unshare-all/);
  assert.ok(!outcome.command.includes("--share-net"));
  assert.match(outcome.command, /'--bind' '\/home\/u\/proj' '\/home\/u\/proj'/);
});

test("section 9: network is shared only when the scope object grants it", () => {
  const outcome = plan("curl x", { ...scope, networkGrant: true }, config, "/home/u/proj", available);
  assert.ok(outcome.ok);
  assert.match(outcome.command, /--share-net/);
});

test("section 9: a working directory outside the scope root is refused", () => {
  const outcome = plan("ls", scope, config, "/home/u/elsewhere", available);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false ? outcome.rule : "", "S3");
});

test("section 9: an unconfigured mount set refuses rather than guessing at the host", () => {
  const outcome = plan("ls", scope, defaultConfig(at("2026-01-01T00:00:00.000Z")), "/home/u/proj", available);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.reason : "", /no runtime mounts are configured/);
});

test("section 9: the builtin shell is blocked unless explicitly granted, and dropped from the tool set", () => {
  assert.equal(builtinBashBlocked(scope), true);
  assert.equal(builtinBashBlocked({ ...scope, unsafeBuiltinBashGrant: true }), false);
  assert.deepEqual(withoutBuiltinBash(["read", "bash", "grep"]), ["read", "grep"]);
});

/* ---------------------------------------------------------------- *
 * Session state and recovery
 * ---------------------------------------------------------------- */

test("M2: session notes are provisional and deduplicated", () => {
  let state = session();
  state = addNote(state, "assumption", "the retry is idempotent", at("2026-01-02T00:00:00.000Z"));
  state = addNote(state, "assumption", "the retry is idempotent", at("2026-01-03T00:00:00.000Z"));
  assert.deepEqual(state.assumptions, ["the retry is idempotent"]);
  assert.equal(state.findings.length, 0, "an assumption never becomes a finding by being repeated");
});

test("MO3/S5: switching the coordinator changes the model and nothing about authority", () => {
  const before = checkpoint(session(), "tests green", at("2026-01-02T00:00:00.000Z"));
  const after = switchCoordinator(before, { provider: "llama-swap", model: "model-b" }, at("2026-01-03T00:00:00.000Z"));
  assert.equal(after.coordinator?.model, "model-b");
  assert.deepEqual(after.scope, before.scope);
  assert.equal(after.autonomy, before.autonomy);
  assert.equal(after.approvalPolicy, before.approvalPolicy);
  assert.equal(after.currentTaskId, before.currentTaskId);
  assert.equal(after.lastVerifiedState, before.lastVerifiedState);
});

test("R1: with no structured state at all, recovery reports it and refuses to continue", () => {
  const report = reconcile(null, { projectRootExists: true, missingScopeRoots: [], auditTruncated: false }, []);
  assert.equal(report.canContinue, false);
  assert.deepEqual(report.conflicts, ["no structured session state found"]);
});

test("R3: recovery continues only from a verified checkpoint", () => {
  const unverified = session();
  const report = reconcile(unverified, { projectRootExists: true, missingScopeRoots: [], auditTruncated: false }, []);
  assert.equal(report.canContinue, false);
  assert.match(report.conflicts.join(" "), /nothing safe to resume from/);

  const verified = checkpoint(unverified, "226 tests pass at a847590", at("2026-01-02T00:00:00.000Z"));
  const closed = { ...verified, endedAt: "2026-01-02T01:00:00.000Z" };
  const ok = reconcile(closed, { projectRootExists: true, missingScopeRoots: [], auditTruncated: false }, []);
  assert.equal(ok.canContinue, true);
  assert.equal(ok.resumeFrom, "226 tests pass at a847590");
});

test("R2: a vanished project root or scope root is a conflict, not something to work around", () => {
  const state = checkpoint(session(), "verified", at("2026-01-02T00:00:00.000Z"));
  const report = reconcile(
    state,
    { projectRootExists: false, missingScopeRoots: ["/home/u/proj"], auditTruncated: false },
    [],
  );
  assert.equal(report.canContinue, false);
  assert.equal(report.conflicts.length, 2);
});

test("R4: an interrupted operation stays uncertain and never becomes a conflict or a guess", () => {
  const state = checkpoint(session(), "verified", at("2026-01-02T00:00:00.000Z"));
  const lastEvent: AuditEvent = makeAuditEvent(
    ctx,
    { eventType: "tool_call", request: "write src/a.ts", result: "started" },
    at("2026-01-02T00:00:00.000Z"),
    ids,
  );
  const report = reconcile(
    state,
    { projectRootExists: true, missingScopeRoots: [], auditTruncated: true },
    [lastEvent],
  );
  assert.equal(report.uncertain.length, 2, "truncated tail plus an unclosed session");
  assert.match(report.uncertain.join(" "), /may or may not have completed/);
  assert.equal(report.conflicts.length, 0, "uncertainty must not be reported as a known failure");
  assert.equal(report.lastEvent?.id, lastEvent.id);
});

/* ---------------------------------------------------------------- *
 * WORKSTATE
 * ---------------------------------------------------------------- */

test("R2: WORKSTATE states its own subordinate status, and marks assumptions provisional", () => {
  let state = checkpoint(session(), "226 tests pass", at("2026-01-02T00:00:00.000Z"));
  state = addNote(state, "assumption", "the caller retries", at("2026-01-02T00:00:00.000Z"));
  state = addNote(state, "next-action", "add the regression test", at("2026-01-02T00:00:00.000Z"));

  const markdown = renderWorkstate({ session: state, currentTask: null, decisions: [], incidents: [], recentAudit: [] });
  assert.match(markdown, /not the authoritative record/);
  assert.match(markdown, /outrank this file/);
  assert.match(markdown, /Active assumptions \(provisional\)/);
  assert.match(markdown, /226 tests pass/);
  assert.match(markdown, /add the regression test/);
});

test("WORKSTATE: with nothing verified it says so rather than implying a safe resume point", () => {
  const markdown = renderWorkstate({ session: session(), currentTask: null, decisions: [], incidents: [], recentAudit: [] });
  assert.match(markdown, /no safe resume point/);
});

test("store: WORKSTATE round-trips through the project .pi directory", () => {
  const dir = tmpdir();
  const store = storeAt(dir);
  store.writeWorkstate("# WORKSTATE\n\nhello\n");
  assert.match(store.readWorkstate() ?? "", /hello/);
  assert.ok(fs.existsSync(path.join(dir, "proj", ".pi", "WORKSTATE.md")));
});
