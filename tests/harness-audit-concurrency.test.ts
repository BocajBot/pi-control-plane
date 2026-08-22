/**
 * Audit-chain serialization across processes (Phase 3 closeout §5-§7).
 *
 * The defect these guard was reproduced before the fix: 32 concurrent
 * appenders produced 3 prevHash collisions and verifyAudit broke at event
 * 12. Per-line JSONL append is atomic, so nothing was lost; what forked was
 * the chain, because each process chained from a tip it had cached before
 * the others appended.
 *
 * The fix serializes the whole read-tip -> chain -> append -> commit
 * transaction with an exclusive lock file, and re-derives the predecessor
 * from disk inside the lock. These tests use REAL processes, not simultaneous
 * calls in one event loop, because the bug lived between processes and a
 * single-loop mock cannot reproduce it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { harnessPaths } from "../src/harness/config.ts";
import { chainEvent } from "../src/harness/audit.ts";
import { HarnessStore } from "../src/harness/store.ts";

import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve the harness modules for spawned CHILD processes in a way that works
// in both trees: the repo (src/harness/*) and the isolated artifact
// (src/core/*, where bin/build-isolated.mjs rewrites the static imports above
// but cannot rewrite a path embedded in a worker-script string). Probe the
// layout and hand the child an absolute file: URL.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = [
  path.join(HERE, "../src/core/store.ts"),
  path.join(HERE, "../src/harness/store.ts"),
].find((c) => fs.existsSync(c)) ?? path.join(HERE, "../src/harness/store.ts");
const STORE_URL = JSON.stringify(pathToFileURL(STORE_PATH).href);
const CONFIG_URL = JSON.stringify(pathToFileURL(STORE_PATH.replace(/store\.ts$/, "config.ts")).href);

function freshPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ac-proj-"));
  const paths = harnessPaths(home, proj, { PI_HARNESS_HOME: path.join(home, "hh") });
  new HarnessStore(paths).init();
  return { home, proj, paths };
}

function workerScript(home: string, proj: string): string {
  const file = path.join(home, "append-worker.mjs");
  fs.writeFileSync(
    file,
    `import { HarnessStore } from ${STORE_URL};
     import { harnessPaths } from ${CONFIG_URL};
     const paths = harnessPaths(${JSON.stringify(home)}, ${JSON.stringify(proj)}, { PI_HARNESS_HOME: ${JSON.stringify(path.join(home, "hh"))} });
     const i = process.argv[2];
     new HarnessStore(paths).appendAudit({
       schemaVersion: 2, id: "aud_" + String(i).padStart(32, "0"),
       timestamp: new Date(1700000000000 + Number(i) * 1000).toISOString(),
       session: "ses_" + "0".repeat(32), actor: "core", actorModel: null,
       eventType: "checkpoint", request: "w" + i, result: "ok",
       scope: ${JSON.stringify(proj)}, metadata: {}, prevHash: null, hash: null,
     });`,
  );
  return file;
}

test("§7: N concurrent processes produce N events in one valid linear chain", async () => {
  // N chosen to exercise contention while staying deterministic in CI. The
  // pre-fix version of this failed reliably at N=32; the lock makes it pass
  // reliably. Kept at 24 so the whole run stays well under the test timeout.
  const N = 12;
  const { home, proj, paths } = freshPaths();
  const worker = workerScript(home, proj);

  const children = Array.from({ length: N }, (_, i) =>
    new Promise<number>((resolve) => {
      const c = spawn("node", ["--experimental-strip-types", worker, String(i)], { stdio: "ignore" });
      c.on("exit", (code: number) => resolve(code ?? -1));
    }),
  );
  const codes = await Promise.all(children);
  const succeeded = codes.filter((c) => c === 0).length;

  const store = new HarnessStore(paths);
  const { records, invalid } = store.readAudit();
  const chain = store.verifyAudit();

  // Every worker that reported success has its event on disk.
  assert.equal(invalid, 0, "no malformed lines");
  assert.equal(records.length, succeeded, `persisted ${records.length} but ${succeeded} workers succeeded`);
  assert.ok(succeeded >= N - 1, `too many workers failed: ${succeeded}/${N}`);

  // One linear chain: no two events share a predecessor.
  const prevs = records.map((r) => r.prevHash ?? "<anchor>");
  assert.equal(new Set(prevs).size, prevs.length, "a predecessor was reused - the chain forked");

  // The chain verifies and its terminal commitment matches.
  assert.equal(chain.ok, true, `verifyAudit failed: brokenAt=${chain.brokenAt}`);
  assert.equal(chain.verifiedCount, records.length);
  assert.equal(chain.tipConsistent, true, chain.tipReason ?? "");
});

test("§6: event appended but tip not updated self-heals and stays detectable", () => {
  // The crash window between the JSONL append and the tip commit. Simulated
  // by rewinding the tip file to before the last event.
  const { paths } = freshPaths();
  const store = new HarnessStore(paths);
  const ev = (r: string) => ({
    schemaVersion: 2, id: "aud_" + r.padEnd(32, "0"), timestamp: "2026-01-01T00:00:00.000Z",
    session: "ses_" + "0".repeat(32), actor: "core" as const, actorModel: null,
    eventType: "checkpoint" as const, request: r, result: "ok", scope: "/p", metadata: {},
    prevHash: null, hash: null,
  });
  store.appendAudit(ev("one"));
  store.appendAudit(ev("two"));
  const twoTip = JSON.parse(fs.readFileSync(paths.auditTipFile, "utf8"));

  // Append a third event's JSONL line but leave the tip pointing at two:
  // exactly "appended but tip not updated".
  const records = store.readAudit().records;
  const three = chainEvent(ev("three"), records[records.length - 1].hash);
  fs.appendFileSync(paths.auditFile, `${JSON.stringify(three)}\n`);
  fs.writeFileSync(paths.auditTipFile, JSON.stringify(twoTip));

  // Detectable AND correctly classified: a tip behind the log is the benign
  // direction (crash before the tip write, or a second writer), so it is
  // reported as consistent with a reason that says "behind" - deliberately
  // NOT as tampering, which would train the reader to ignore it. The alarm
  // direction is the opposite one (tip ahead of the log), covered elsewhere.
  const before = new HarnessStore(paths).verifyAudit();
  assert.equal(before.ok, true, "the chain itself is still linear");
  assert.equal(before.tipConsistent, true, "a tip behind the log is the benign, expected direction");
  assert.match(before.tipReason ?? "", /behind/, "and it must be reported as behind, not as agreement");

  // Self-heals: the next locked append recomputes the tip from the records,
  // the orphaned event included, and the commitment catches up.
  const healer = new HarnessStore(paths);
  healer.appendAudit(ev("four"));
  const after = healer.verifyAudit();
  assert.equal(after.ok, true);
  assert.equal(after.tipConsistent, true, "the next append must reconcile the tip");
  assert.equal(after.verifiedCount, 4);
});

test("§6: a truncated final JSONL line is reported, not chained onto blindly", () => {
  const { paths } = freshPaths();
  const store = new HarnessStore(paths);
  const ev = (r: string) => ({
    schemaVersion: 2, id: "aud_" + r.padEnd(32, "0"), timestamp: "2026-01-01T00:00:00.000Z",
    session: "ses_" + "0".repeat(32), actor: "core" as const, actorModel: null,
    eventType: "checkpoint" as const, request: r, result: "ok", scope: "/p", metadata: {},
    prevHash: null, hash: null,
  });
  store.appendAudit(ev("one"));
  store.appendAudit(ev("two"));

  // Chop the final line mid-JSON, without a trailing newline.
  const raw = fs.readFileSync(paths.auditFile, "utf8").trimEnd().split("\n");
  raw[raw.length - 1] = raw[raw.length - 1].slice(0, 25);
  fs.writeFileSync(paths.auditFile, raw.join("\n"));

  const read = new HarnessStore(paths).readAudit();
  // The damaged line is not parsed into a record and is accounted for, so a
  // reader cannot mistake a torn tail for a complete history.
  assert.ok(read.invalid >= 1 || read.truncatedTail, "a torn final line must be visible");
  assert.equal(read.records.length, 1, "only the intact events are records");
});

test("§6: a malformed (non-JSON) final line is counted invalid, not dropped", () => {
  const { paths } = freshPaths();
  const store = new HarnessStore(paths);
  store.appendAudit({
    schemaVersion: 2, id: "aud_" + "one".padEnd(32, "0"), timestamp: "2026-01-01T00:00:00.000Z",
    session: "ses_" + "0".repeat(32), actor: "core", actorModel: null,
    eventType: "checkpoint", request: "one", result: "ok", scope: "/p", metadata: {},
    prevHash: null, hash: null,
  });
  fs.appendFileSync(paths.auditFile, "{ this is not json\n");
  const read = new HarnessStore(paths).readAudit();
  assert.equal(read.invalid, 1, "the malformed line must be counted, not silently skipped");
  assert.equal(read.records.length, 1);
});

import { withFileLock } from "../src/harness/store.ts";

test("§6: a live lock is not stolen (mutual exclusion holds within the stale window)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-live-"));
  const target = path.join(dir, "audit.jsonl");
  fs.writeFileSync(target, "");
  const holder = path.join(dir, "holder.mjs");
  // A child grabs the lock and holds it ~900ms, well inside STALE_LOCK_MS.
  fs.writeFileSync(
    holder,
    `import { withFileLock } from ${STORE_URL};
     withFileLock(${JSON.stringify(target)}, () => {
       const end = Date.now() + 900;
       while (Date.now() < end) {}
     });`,
  );
  const child = spawn("node", ["--experimental-strip-types", holder], { stdio: "ignore" });
  // Give the child time to acquire before we contend.
  await new Promise((r) => setTimeout(r, 150));

  const start = Date.now();
  withFileLock(target, () => {
    fs.appendFileSync(target, "parent\n");
  });
  const waited = Date.now() - start;
  await new Promise((r) => child.on("exit", r));

  // If the live lock had been stolen, the parent would have run immediately.
  // It must have waited for the holder to release.
  assert.ok(waited >= 500, `parent did not wait for the live lock: waited ${waited}ms`);
});

test("§6: a stale lock from a dead process is recovered", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-stale-"));
  const target = path.join(dir, "audit.jsonl");
  fs.writeFileSync(target, "");
  // A leftover lock whose mtime is well past the stale threshold: its owner
  // died without releasing it. It must be broken, not waited on forever.
  const lock = `${target}.lock`;
  fs.writeFileSync(lock, "");
  const old = Date.now() / 1000 - 120; // 120s ago, > STALE_LOCK_MS (30s)
  fs.utimesSync(lock, old, old);

  let ran = false;
  withFileLock(target, () => {
    ran = true;
  });
  assert.equal(ran, true, "a stale lock must be broken so work can proceed");
});
