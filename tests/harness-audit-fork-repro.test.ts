/**
 * Executable reproduction of the pre-serialization audit-chain fork
 * (Phase 3 closeout §5-§7) - converting an asserted-not-shown claim into a
 * shown one.
 *
 * The docstring of harness-audit-concurrency.test.ts *describes* the defect
 * ("32 concurrent appenders produced 3 prevHash collisions and verifyAudit
 * broke at event 12") and that file proves the FIX (N real processes -> one
 * linear chain). What was never executed here is the FAILING half: the fork
 * itself. This test reproduces it deterministically behind a test seam, then
 * shows the current locked append refusing the same interleave.
 *
 * The bug in one line: each process chained a new event onto a tip it had read
 * BEFORE the others appended, so two events claimed the same predecessor. The
 * fix re-derives the predecessor from disk INSIDE an exclusive lock, so a second
 * writer chains onto the first instead of onto a stale cached tip. (The true
 * cross-process case is covered by harness-audit-concurrency.test.ts §7; this
 * file isolates the mechanism deterministically.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { harnessPaths } from "../src/harness/config.ts";
import { HarnessStore, appendJsonl } from "../src/harness/store.ts";
import { chainEvent, chainTip } from "../src/harness/audit.ts";
import type { AuditEvent } from "../src/harness/types.ts";

function freshPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fork-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "fork-proj-"));
  const paths = harnessPaths(home, proj, { PI_HARNESS_HOME: path.join(home, "hh") });
  new HarnessStore(paths).init();
  return paths;
}

const ev = (r: string): AuditEvent => ({
  schemaVersion: 2, id: "aud_" + r.padEnd(32, "0"), timestamp: "2026-01-01T00:00:00.000Z",
  session: "ses_" + "0".repeat(32), actor: "core", actorModel: null,
  eventType: "checkpoint", request: r, result: "ok", scope: "/p", metadata: {},
  prevHash: null, hash: null,
});

test("pre-fix (reproduced): two unlocked appends from a cached tip FORK the chain", () => {
  const paths = freshPaths();
  // One committed event, so there is a real tip to cache.
  new HarnessStore(paths).appendAudit(ev("seed"));

  // Both "processes" read the SAME tip before either appends - the exact
  // pre-fix window. This is the OLD unlocked path re-created from the same
  // primitives the store uses, minus the lock and minus the inside-lock
  // re-derive.
  const cachedTip = chainTip(new HarnessStore(paths).readAudit().records).prevHash;
  appendJsonl(paths.auditFile, chainEvent(ev("procA"), cachedTip));
  appendJsonl(paths.auditFile, chainEvent(ev("procB"), cachedTip));

  const records = new HarnessStore(paths).readAudit().records;
  const prevs = records.map((r) => r.prevHash);
  const chain = new HarnessStore(paths).verifyAudit();

  console.log("pre-fix prevHashes:", prevs.map((p) => (p ? p.slice(0, 8) : "<anchor>")));
  console.log(`pre-fix verifyAudit: ok=${chain.ok} brokenAt=${chain.brokenAt}`);

  // The fork, shown: procA and procB claim the same predecessor...
  assert.notEqual(new Set(prevs).size, prevs.length, "a predecessor was reused - the chain forked");
  // ...and verification detects it rather than accepting a forked history.
  assert.equal(chain.ok, false, "verifyAudit must break on the fork");
  assert.equal(chain.brokenAt, 2, "the break is the second sibling that reused the tip");
});

test("fixed: the locked append re-derives the tip inside the lock and stays linear", () => {
  const paths = freshPaths();
  const store = new HarnessStore(paths);

  // The SAME three events through the current code. Each appendAudit re-derives
  // the predecessor from disk inside the exclusive lock, so procB chains onto
  // procA - never onto a stale cached tip - and no fork can form.
  store.appendAudit(ev("seed"));
  store.appendAudit(ev("procA"));
  store.appendAudit(ev("procB"));

  const records = store.readAudit().records;
  const prevs = records.map((r) => r.prevHash);
  const chain = store.verifyAudit();

  console.log("fixed prevHashes:", prevs.map((p) => (p ? p.slice(0, 8) : "<anchor>")));
  console.log(`fixed verifyAudit: ok=${chain.ok} verified=${chain.verifiedCount}`);

  assert.equal(new Set(prevs).size, prevs.length, "no predecessor reused - one linear chain");
  assert.equal(chain.ok, true, `chain verifies: brokenAt=${chain.brokenAt}`);
  assert.equal(chain.verifiedCount, 3);
  assert.equal(chain.tipConsistent, true, chain.tipReason ?? "");
});
