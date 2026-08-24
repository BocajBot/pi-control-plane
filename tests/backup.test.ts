/**
 * Unit tests for the backup-before-edit decision logic (src/control-plane/backup.ts).
 * Pure: fake fs ops, no real disk, no Pi. Mirrors the read-before-edit test style.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
  backupTargetPath,
  defaultBackupRoot,
  mirroredDir,
  planBackup,
  resolveNonCollidingPath,
  sanitizeSegment,
  type BackupFsOps,
} from "../src/control-plane/backup.ts";

/** In-memory exists() over a fixed set of paths. */
function memOps(existing: Set<string>): BackupFsOps {
  return { exists: (p) => existing.has(p) };
}

// ---- sanitizeSegment ----

test("sanitizeSegment: strips unsafe chars, collapses runs, caps length", () => {
  assert.equal(sanitizeSegment("a/b\\c d"), "a_b_c_d");
  assert.equal(sanitizeSegment("___x___y___"), "_x_y_");
  assert.equal(sanitizeSegment("x".repeat(200)).length, 64);
});

test("sanitizeSegment: never yields empty, dot, or double-dot", () => {
  assert.equal(sanitizeSegment(""), "_");
  assert.equal(sanitizeSegment("///"), "_");
  assert.equal(sanitizeSegment(".."), "_");
  assert.equal(sanitizeSegment("..."), "_");
  assert.equal(sanitizeSegment("."), "_");
});

// ---- mirroredDir ----

test("mirroredDir: mirrors the directory tree with _ separators", () => {
  const m = mirroredDir("/home/bocaj/config/llama-swap/x.yaml");
  assert.equal(m, "home_bocaj_config_llama-swap");
  // Two different dirs, same basename -> distinct mirrored prefixes.
  assert.notEqual(
    mirroredDir("/a/b/file.txt"),
    mirroredDir("/c/d/file.txt"),
  );
});

// ---- backupTargetPath ----

test("backupTargetPath: <root>/<mirrored>/<basename>.<tag>.bak", () => {
  const p = backupTargetPath("/home/u/proj/config.yaml", "sess1", "/bk");
  assert.equal(p, path.join("/bk", "home_u_proj", "config.yaml.sess1.bak"));
});

test("backupTargetPath: sanitizes an untrusted basename and tag", () => {
  const p = backupTargetPath("/a/b/../../etc/passwd", "s..t", "/bk");
  // basename "../../etc/passwd" -> basename is "passwd"; dir mirrored.
  assert.ok(!p.includes(".."), "no path traversal in the backup name");
  assert.match(p, /passwd\.s_t\.bak$/);
});

// ---- planBackup ----

test("planBackup: existing file -> a plan under the root", () => {
  const canonical = "/home/u/proj/config.yaml";
  const ops = memOps(new Set([canonical]));
  const plan = planBackup(canonical, "sess1", "/bk", ops);
  assert.ok(plan !== null);
  assert.equal(plan!.canonical, canonical);
  assert.equal(plan!.sessionTag, "sess1");
  assert.ok(plan!.targetPath.startsWith("/bk/"));
});

test("planBackup: new (nonexistent) file -> null (exempt)", () => {
  const ops = memOps(new Set());
  assert.equal(planBackup("/home/u/proj/new.txt", "sess1", "/bk", ops), null);
});

test("planBackup: empty canonical -> null", () => {
  const ops = memOps(new Set(["/x"]));
  assert.equal(planBackup("", "sess1", "/bk", ops), null);
});

// ---- resolveNonCollidingPath ----

test("resolveNonCollidingPath: no collision -> planned path unchanged", () => {
  const p = "/bk/d/f.sess1.bak";
  assert.equal(resolveNonCollidingPath(p, memOps(new Set())), p);
});

test("resolveNonCollidingPath: collision -> counter increments, never overwrites", () => {
  const p = "/bk/d/f.sess1.bak";
  // .bak exists, .1.bak free -> picks .1.bak
  let ops = memOps(new Set([p]));
  assert.equal(resolveNonCollidingPath(p, ops), "/bk/d/f.sess1.1.bak");
  // .bak and .1.bak exist, .2.bak free -> picks .2.bak
  ops = memOps(new Set([p, "/bk/d/f.sess1.1.bak"]));
  assert.equal(resolveNonCollidingPath(p, ops), "/bk/d/f.sess1.2.bak");
});

// ---- defaultBackupRoot ----

test("defaultBackupRoot: honors PI_BACKUP_DIR override", () => {
  assert.equal(defaultBackupRoot({ PI_BACKUP_DIR: "/custom" } as NodeJS.ProcessEnv, "/h"), "/custom");
});

test("defaultBackupRoot: falls back to harness-home/backups (PI_HARNESS_HOME then ~/.pi)", () => {
  assert.equal(
    defaultBackupRoot({ PI_HARNESS_HOME: "/hh" } as NodeJS.ProcessEnv, "/h"),
    path.join("/hh", "backups"),
  );
  assert.equal(
    defaultBackupRoot({} as NodeJS.ProcessEnv, "/home/bocaj"),
    path.join("/home/bocaj", ".pi", "backups"),
  );
});
