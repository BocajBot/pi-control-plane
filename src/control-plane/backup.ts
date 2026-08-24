/**
 * Backup-before-edit: decide WHETHER and WHERE a pre-mutation snapshot of an
 * existing file goes, before the first mutation of that file in a session.
 *
 * This module is pure decision logic — no side effects, injectable fs/path ops
 * so it unit-tests without a real disk. The actual copy + diagnostic emission
 * lives in the extension (wiring only), mirroring how read-before-edit splits
 * its decision (this dir) from its enforcement (extensions/control-plane.ts).
 *
 * Companion to read-before-edit: that rule guarantees the model has SEEN the
 * current contents; this rule guarantees a SAVED pre-image exists before the
 * contents change. "Seen" != "saved".
 *
 * The backup is planned at MUTATION time (not read time): a copy taken when the
 * file was last read would be stale if it changed in between. Planning just
 * before the write captures the true pre-mutation state.
 */

import * as os from "node:os";
import * as path from "node:path";

/** Injectable filesystem operations so backup-path logic is unit-testable.
 * Mirrors PathOps in tool-policy.ts (same shape, kept local so this module has
 * no cross-import beyond what it genuinely needs). */
export interface BackupFsOps {
  /** True if the path exists on disk. */
  exists(p: string): boolean;
}

/** A resolved plan for one backup. `targetPath` is where the snapshot goes. */
export interface BackupPlan {
  /** Canonical (absolute, symlink-resolved) target file being protected. */
  canonical: string;
  /** Where the pre-mutation snapshot will be written. */
  targetPath: string;
  /** The session tag baked into the name (per control-plane activation). */
  sessionTag: string;
}

/** Default backup root: `$PI_BACKUP_DIR`, else `<harness-home>/backups`, where
 * harness-home honors `PI_HARNESS_HOME` then `~/.pi` — matching agentDir() in
 * the extension so a relocated harness home relocates backups too. */
export function defaultBackupRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  const override = env.PI_BACKUP_DIR;
  if (typeof override === "string" && override.trim().length > 0) return override;
  const harnessHome =
    env.PI_HARNESS_HOME && env.PI_HARNESS_HOME.trim().length > 0
      ? env.PI_HARNESS_HOME
      : path.join(homedir, ".pi");
  return path.join(harnessHome, "backups");
}

/** Sanitize an untrusted path segment for use as a filename/dirname. Strips
 * everything not in [A-Za-z0-9._-], collapses runs of separators, caps length,
 * and can never yield ".." or the empty string (falls back to "_"). A target
 * path is untrusted input; this is mandatory (spec §54 "sanitize filenames").
 *
 * A SINGLE dot is preserved (so a legitimate basename like "config.yaml" keeps
 * its extension), but any dot-RUN of two or more dots — interior or at the
 * edges — is collapsed to one underscore. That is what stops an untrusted tag
 * like "s..t" from smuggling ".." into the backup filename: it becomes "s_t",
 * never "s..t". Leading/trailing lone dots are still trimmed so no segment
 * starts or ends with a dot (no hidden-file / "." / ".." collision). */
export function sanitizeSegment(segment: string, maxLen = 64): string {
  let cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "_");
  // Collapse any run of >=2 dots (interior or edge) to a single underscore so
  // no ".." survives; a lone dot is left intact for now.
  cleaned = cleaned.replace(/\.{2,}/g, "_").replace(/_{2,}/g, "_");
  if (cleaned.length === 0) return "_";
  // Trim leading/trailing lone dots (a run was already collapsed above).
  const trimmed = cleaned.replace(/^\.+/, "").replace(/\.+$/, "");
  const body = trimmed.length > 0 ? trimmed : "_";
  return body.slice(0, maxLen);
}

/** Mirror a canonical file's directory structure as sanitized path segments,
 * so two files with the same basename in different trees never collide.
 * `/home/bocaj/config/x.yaml` -> `home_bocaj_config__x.yaml`. */
export function mirroredDir(canonical: string): string {
  const dir = path.dirname(canonical);
  // Split on the platform separator; drop the leading empty (from a leading /).
  const segments = dir.split(path.sep).filter((s) => s.length > 0);
  return segments.map((s) => sanitizeSegment(s)).join("_");
}

/** Deterministic backup path for a canonical target under a session tag.
 * `<root>/<mirrored-dir>/<basename>.<sessionTag>.bak`. */
export function backupTargetPath(
  canonical: string,
  sessionTag: string,
  root: string,
): string {
  const base = sanitizeSegment(path.basename(canonical));
  const tag = sanitizeSegment(sessionTag);
  return path.join(root, mirroredDir(canonical), `${base}.${tag}.bak`);
}

/**
 * Decide whether a backup is needed for a mutation of `canonical`, and where.
 * Returns null (exempt — no backup) or a BackupPlan.
 *
 * Exemptions (must match read-before-edit exactly):
 *  - target does not exist yet (a NEW file: nothing to back up).
 *
 * Everything else that reaches here is an in-scope mutation of an existing
 * file and MUST be backed up. The caller (extension) is responsible for only
 * calling this for mutate-class tools on resolvable paths; the tool-category
 * gate lives in the hook, mirroring read-before-edit's placement.
 */
export function planBackup(
  canonical: string,
  sessionTag: string,
  root: string,
  ops: BackupFsOps,
): BackupPlan | null {
  if (canonical.trim().length === 0) return null;
  if (!ops.exists(canonical)) return null; // new file: nothing to read or back up
  return { canonical, targetPath: backupTargetPath(canonical, sessionTag, root), sessionTag };
}

/**
 * Resolve a NON-COLLIDING backup path: if the planned path already exists
 * (same session re-running, or a tag collision), append a monotonic counter —
 * `.bak`, `.1.bak`, `.2.bak` — so a backup never clobbers a prior one. A backup
 * that overwrote an earlier backup would defeat the purpose of keeping a
 * pre-image.
 */
export function resolveNonCollidingPath(
  planned: string,
  ops: BackupFsOps,
): string {
  if (!ops.exists(planned)) return planned;
  const dot = planned.lastIndexOf(".");
  const stem = dot > 0 ? planned.slice(0, dot) : planned;
  const ext = dot > 0 ? planned.slice(dot) : ".bak";
  for (let i = 1; ; i++) {
    const candidate = `${stem}.${i}${ext}`;
    if (!ops.exists(candidate)) return candidate;
    // Guard against a pathological unbounded run (should never happen in
    // practice); bail to a timestamped suffix rather than loop forever.
    if (i > 10_000) return `${stem}.${Date.now()}${ext}`;
  }
}
