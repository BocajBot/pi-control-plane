/**
 * Section 32 recovery representation: per-session structured state, the
 * global session index, the two-layer WORKSTATE, and the audit hash chain as
 * the store applies it.
 *
 * These tests use a real temp directory for the same reason the v0.1 store
 * tests do: what is under test here is which file ends up holding what, and
 * a fake filesystem would only be testing the fake.
 *
 * Several tests carry an explicit control - the v0.1 behaviour, or the
 * behaviour of a store that re-read the file - because most of the claims in
 * this file are of the form "A rather than B", and an assertion on A alone
 * would pass just as happily if A and B were the same thing.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import {
  chainEvent,
  legacyPrefixDigest,
  makeAuditEvent,
  type AuditContext,
} from "../src/harness/audit.ts";
import { harnessPaths, sessionStateFileFor, workstateFileFor } from "../src/harness/config.ts";
import { createScope } from "../src/harness/scope.ts";
import { closeSession, createSession, sessionIndexEntry } from "../src/harness/state.ts";
import { appendJsonl, HarnessStore, writeAtomic } from "../src/harness/store.ts";
import { HARNESS_SCHEMA_VERSION, type AuditEvent, type SessionState } from "../src/harness/types.ts";
import { renderWorkstate } from "../src/harness/workstate.ts";

const at = (iso: string) => () => new Date(iso);
let seq = 0;
const ids = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;

const tmpRoots: string[] = [];
function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-v2-test-"));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/** A store over `<root>/harness` for the project `<root>/<name>`. Two stores
 * built from the same root share one harness home - which is what makes the
 * session index testable across projects. */
function storeAt(root: string, name = "proj"): HarnessStore {
  const store = new HarnessStore(
    harnessPaths(root, path.join(root, name), { PI_HARNESS_HOME: path.join(root, "harness") }),
  );
  store.init();
  return store;
}

function sessionIn(projectRoot: string, startedAt: string): SessionState {
  return createSession(
    {
      projectRoot,
      deviceId: "dev_test",
      scope: createScope(projectRoot, "user", {}, at(startedAt)),
      reasoningMode: "balanced",
      autonomy: "guided",
      approvalPolicy: "mutations",
      coordinator: { provider: "llama-swap", model: "model-a" },
    },
    at(startedAt),
    ids,
  );
}

/* ---------------------------------------------------------------- *
 * Per-session structured state
 * ---------------------------------------------------------------- */

test("init creates the per-session state and workstate directories", () => {
  const store = storeAt(tmpdir());
  assert.ok(fs.existsSync(store.paths.sessionsDir), "sessions/ must exist before the first write");
  assert.ok(fs.existsSync(store.paths.workstatesDir), "workstates/ must exist too");
});

test("two sessions in one project both survive; the second does not overwrite the first", () => {
  const dir = tmpdir();
  const store = storeAt(dir);
  const root = path.join(dir, "proj");
  const first = sessionIn(root, "2026-01-01T00:00:00.000Z");
  const second = sessionIn(root, "2026-01-02T00:00:00.000Z");

  store.writeSessionStateFor(first);
  store.writeSessionStateFor(second);

  assert.notEqual(first.id, second.id);
  assert.equal(store.readSessionStateFor(first.id)?.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(store.readSessionStateFor(second.id)?.startedAt, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(
    store.listSessionStates().map((s) => s.id),
    [second.id, first.id],
    "newest startedAt first",
  );
  assert.ok(fs.existsSync(sessionStateFileFor(store.paths, first.id)));
  assert.ok(fs.existsSync(sessionStateFileFor(store.paths, second.id)));

  // The v0.1 behaviour, as a control: one mutable snapshot per project means
  // the earlier session is simply gone. This is the defect the per-session
  // layout exists to fix, so the test states it rather than implying it.
  store.writeSessionState(first);
  store.writeSessionState(second);
  assert.equal(store.readSessionState()?.id, second.id);
  assert.notEqual(store.readSessionState()?.id, first.id);
});

test("listSessionStates orders by the startedAt inside the file, not by write order", () => {
  const dir = tmpdir();
  const store = storeAt(dir);
  const root = path.join(dir, "proj");
  const middle = sessionIn(root, "2026-02-02T00:00:00.000Z");
  const newest = sessionIn(root, "2026-03-03T00:00:00.000Z");
  const oldest = sessionIn(root, "2026-01-01T00:00:00.000Z");
  // Deliberately written newest-last-but-one so write order cannot be
  // mistaken for the sort key.
  store.writeSessionStateFor(middle);
  store.writeSessionStateFor(newest);
  store.writeSessionStateFor(oldest);

  assert.deepEqual(
    store.listSessionStates().map((s) => s.startedAt),
    ["2026-03-03T00:00:00.000Z", "2026-02-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
  );
});

test("listSessionStates skips unreadable and wrong-version files rather than failing the scan", () => {
  const dir = tmpdir();
  const store = storeAt(dir);
  const good = sessionIn(path.join(dir, "proj"), "2026-01-01T00:00:00.000Z");
  store.writeSessionStateFor(good);
  fs.writeFileSync(path.join(store.paths.sessionsDir, "ses_broken.json"), "{not json");
  writeAtomic(
    path.join(store.paths.sessionsDir, "ses_future.json"),
    JSON.stringify({ ...good, id: "ses_future", schemaVersion: 99 }),
  );

  assert.deepEqual(
    store.listSessionStates().map((s) => s.id),
    [good.id],
    "one damaged session file must not hide the intact ones",
  );
});

test("readLatestSessionState falls back to the legacy snapshot, and prefers a per-session file", () => {
  const dir = tmpdir();
  const store = storeAt(dir);
  const root = path.join(dir, "proj");

  assert.equal(store.readLatestSessionState(), null, "nothing stored yet");

  // A v0.1 session interrupted before the upgrade: its only structured state
  // is the legacy single snapshot. Recovery must still find it.
  const legacy = sessionIn(root, "2026-05-05T00:00:00.000Z");
  store.writeSessionState(legacy);
  assert.equal(store.readLatestSessionState()?.id, legacy.id);

  // Once a per-session file exists it wins outright, even though this one
  // started earlier: the legacy path is a fallback, not a candidate. Its
  // timestamp records when a single mutable file was last written, which is
  // not evidence about which session is current.
  const perSession = sessionIn(root, "2026-04-04T00:00:00.000Z");
  store.writeSessionStateFor(perSession);
  assert.equal(store.readLatestSessionState()?.id, perSession.id);

  // And the legacy file is only ever read: writing per-session state must not
  // touch it, or the upgrade would keep re-creating the defect.
  assert.equal(store.readSessionState()?.id, legacy.id, "the legacy snapshot is never rewritten");
});

/* ---------------------------------------------------------------- *
 * Global session index
 * ---------------------------------------------------------------- */

test("the index resolves a session id to its project root, across projects", () => {
  const dir = tmpdir();
  const alpha = storeAt(dir, "alpha");
  const beta = storeAt(dir, "beta");
  assert.equal(alpha.paths.sessionsIndexFile, beta.paths.sessionsIndexFile, "one index per device");
  assert.notEqual(alpha.paths.projectDir, beta.paths.projectDir);

  const inAlpha = sessionIn(path.join(dir, "alpha"), "2026-01-01T00:00:00.000Z");
  const inBeta = sessionIn(path.join(dir, "beta"), "2026-01-02T00:00:00.000Z");
  alpha.upsertSessionIndex(sessionIndexEntry(inAlpha));
  beta.upsertSessionIndex(sessionIndexEntry(inBeta));

  assert.equal(alpha.findSessionProject(inBeta.id), path.join(dir, "beta"));
  assert.equal(beta.findSessionProject(inAlpha.id), path.join(dir, "alpha"));
  assert.equal(alpha.findSessionProject("ses_never_seen"), null, "unknown means unknown");
  assert.deepEqual(
    alpha.readSessionIndex().map((e) => e.id),
    [inAlpha.id, inBeta.id],
  );
});

test("upsertSessionIndex replaces a row in place rather than appending a second one", () => {
  const dir = tmpdir();
  const store = storeAt(dir);
  const root = path.join(dir, "proj");
  const first = sessionIn(root, "2026-01-01T00:00:00.000Z");
  const second = sessionIn(root, "2026-01-02T00:00:00.000Z");
  store.upsertSessionIndex(sessionIndexEntry(first));
  store.upsertSessionIndex(sessionIndexEntry(second));

  const closed = closeSession(first, at("2026-01-01T09:00:00.000Z"));
  store.upsertSessionIndex(sessionIndexEntry(closed));

  const rows = store.readSessionIndex();
  assert.equal(rows.length, 2, "closing a session must not create a second row for it");
  assert.deepEqual(rows.map((r) => r.id), [first.id, second.id], "rows keep their position");
  assert.equal(rows[0].endedAt, "2026-01-01T09:00:00.000Z");
  assert.equal(rows[1].endedAt, null);
});

test("a damaged index row is dropped, never repaired into a lookup answer", () => {
  const dir = tmpdir();
  const store = storeAt(dir);
  const good = sessionIndexEntry(sessionIn(path.join(dir, "proj"), "2026-01-01T00:00:00.000Z"));
  writeAtomic(
    store.paths.sessionsIndexFile,
    JSON.stringify([
      good,
      { schemaVersion: HARNESS_SCHEMA_VERSION, id: "ses_no_root", startedAt: "x", endedAt: null },
      { schemaVersion: HARNESS_SCHEMA_VERSION, id: "ses_bad_root", projectRoot: 7, startedAt: "x", endedAt: null },
    ]),
  );

  assert.deepEqual(store.readSessionIndex().map((r) => r.id), [good.id]);
  assert.equal(store.findSessionProject("ses_no_root"), null);
  assert.equal(store.findSessionProject("ses_bad_root"), null);
  assert.equal(store.findSessionProject(good.id), good.projectRoot);

  writeAtomic(store.paths.sessionsIndexFile, "not json at all");
  assert.deepEqual(store.readSessionIndex(), [], "an unreadable index reads as empty, not as a throw");
});

test("sessionIndexEntry copies only the fields needed to find the session", () => {
  const state = sessionIn("/home/u/proj", "2026-01-01T00:00:00.000Z");
  assert.deepEqual(sessionIndexEntry(state), {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: state.id,
    projectRoot: "/home/u/proj",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
  });
});

/* ---------------------------------------------------------------- *
 * Two-layer WORKSTATE
 * ---------------------------------------------------------------- */

function workstateFor(state: SessionState): string {
  return renderWorkstate({
    session: state,
    currentTask: null,
    decisions: [],
    incidents: [],
    recentAudit: [],
  });
}

test("a per-session workstate is written, reads back, and names its own session", () => {
  const dir = tmpdir();
  const store = storeAt(dir);
  const root = path.join(dir, "proj");
  const first = sessionIn(root, "2026-01-01T00:00:00.000Z");
  const second = sessionIn(root, "2026-01-02T00:00:00.000Z");

  store.writeWorkstateFor(first.id, workstateFor(first));
  store.writeWorkstateFor(second.id, workstateFor(second));
  // The current-session layer, overwritten by whoever checkpointed last.
  store.writeWorkstate(workstateFor(second));

  const recovered = store.readWorkstateFor(first.id) ?? "";
  assert.match(recovered, new RegExp(first.id), "a recovery copy must identify its own session");
  assert.ok(!recovered.includes(second.id), "and must not be the other session's snapshot");
  assert.match(store.readWorkstateFor(second.id) ?? "", new RegExp(second.id));
  assert.ok(fs.existsSync(workstateFileFor(store.paths, first.id)));
  assert.ok(
    fs.existsSync(path.join(root, ".pi", "workstates", `${first.id}.md`)),
    "the copies live beside WORKSTATE.md in the project",
  );

  // WORKSTATE.md holds only the most recent session, which is exactly why the
  // per-session layer exists: on its own it cannot answer "what was the
  // session that crashed doing".
  assert.match(store.readWorkstate() ?? "", new RegExp(second.id));
  assert.equal(store.readWorkstateFor("ses_never_written"), null);
});

/* ---------------------------------------------------------------- *
 * Audit chaining through the store
 * ---------------------------------------------------------------- */

const ctx: AuditContext = {
  session: "ses_1",
  actor: "coordinator",
  actorModel: { provider: "llama-swap", model: "model-a" },
  scope: createScope("/home/u/proj", "user", {}, at("2026-01-01T00:00:00.000Z")),
};

function event(request: string, iso = "2026-01-01T00:00:00.000Z"): AuditEvent {
  return makeAuditEvent(ctx, { eventType: "checkpoint", request, result: "ok" }, at(iso), ids);
}

test("appendAudit chains every event, and verifyAudit accepts the result", () => {
  const store = storeAt(tmpdir());
  for (let i = 0; i < 4; i++) store.appendAudit(event(`n=${i}`));

  const { records } = store.readAudit();
  assert.equal(records.length, 4);
  assert.equal(records[0].prevHash, null, "an empty file has nothing to anchor to");
  for (let i = 1; i < records.length; i++) {
    assert.equal(records[i].prevHash, records[i - 1].hash, `event ${i} links to its predecessor`);
    assert.notEqual(records[i].hash, null);
  }

  const verified = store.verifyAudit();
  assert.equal(verified.ok, true, verified.reason);
  assert.equal(verified.verifiedCount, 4);
  assert.equal(verified.legacyPrefixLength, 0);
  assert.equal(verified.brokenAt, null);
});

test("appending onto a legacy-only file anchors to the legacy prefix digest", () => {
  const store = storeAt(tmpdir());
  // v0.1 lines: written straight to the file, unchained, exactly as the
  // previous harness left them.
  appendJsonl(store.paths.auditFile, event("legacy-a"));
  appendJsonl(store.paths.auditFile, event("legacy-b"));
  const legacy = store.readAudit().records;
  assert.deepEqual(legacy.map((r) => r.hash), [null, null]);

  store.appendAudit(event("first-v2"));

  const records = store.readAudit().records;
  assert.equal(records.length, 3);
  assert.equal(
    records[2].prevHash,
    legacyPrefixDigest(legacy),
    "the first chained event anchors to the exact prefix that preceded it",
  );

  const verified = store.verifyAudit();
  assert.equal(verified.ok, true, verified.reason);
  assert.equal(verified.legacyPrefixLength, 2, "the v0.1 lines stay declared unverified");
  assert.equal(verified.verifiedCount, 1);
  assert.match(verified.reason, /legacy/);
});

test("verifyAudit reports an edited event instead of accepting the file", () => {
  const store = storeAt(tmpdir());
  store.appendAudit(event("one"));
  store.appendAudit(event("two"));
  store.appendAudit(event("three"));
  assert.equal(store.verifyAudit().ok, true, "control: the untouched file verifies");

  const lines = fs.readFileSync(store.paths.auditFile, "utf8").trimEnd().split("\n");
  const tampered = JSON.parse(lines[1]);
  tampered.result = "ok (actually failed)";
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(store.paths.auditFile, `${lines.join("\n")}\n`);

  const verified = store.verifyAudit();
  assert.equal(verified.ok, false);
  assert.equal(verified.brokenAt, 1, "the earliest damage, not its downstream consequences");
});

test("every append re-derives its predecessor from the file, never from a cached tip", () => {
  // This asserts the opposite of what it once did, and the reversal is the
  // whole audit-serialization fix. The old behaviour was "advance the tip in
  // memory and trust it across appends"; that in-memory tip was exactly the
  // fork's root cause - two processes each held a tip that went stale the
  // instant the other appended, and both chained onto it. Measured pre-fix:
  // 32 concurrent appenders, 3 prevHash collisions, verifyAudit broke at 12.
  //
  // The correct property, checked here: an append reads the current tip from
  // the file (under the audit lock) every time, so an event written behind
  // the store's back is chained ONTO rather than forked away from - even by
  // the same in-process store that still holds a now-stale cache.
  function setup() {
    const dir = tmpdir();
    const store = storeAt(dir);
    store.appendAudit(event("first"));
    const first = store.readAudit().records[0];
    // Rewrite the file behind the store's back with a different chained
    // event, so "what the file says the tip is" and "what this process
    // remembers" have provably different answers.
    const other = chainEvent(event("rewritten-behind-our-back"), null);
    fs.writeFileSync(store.paths.auditFile, `${JSON.stringify(other)}\n`);
    assert.notEqual(other.hash, first.hash);
    return { store, firstHash: first.hash, otherHash: other.hash };
  }

  // The store that already appended once, and holds a stale in-memory tip,
  // must still chain onto what the file actually says now.
  const stale = setup();
  stale.store.appendAudit(event("second"));
  assert.equal(
    stale.store.readAudit().records[1].prevHash,
    stale.otherHash,
    "a stale in-memory tip must not be trusted; the predecessor is re-read from the file",
  );
  assert.notEqual(
    stale.store.readAudit().records[1].prevHash,
    stale.firstHash,
    "chaining onto the remembered tip instead of the file is the fork this fix removes",
  );

  // A fresh process must reach the identical answer: the source of truth is
  // the file, not which object happens to hold a cache.
  const fresh = setup();
  new HarnessStore(fresh.store.paths).appendAudit(event("second"));
  assert.equal(
    fresh.store.readAudit().records[1].prevHash,
    fresh.otherHash,
    "a fresh store and a stale store agree, because both read the file",
  );
});
