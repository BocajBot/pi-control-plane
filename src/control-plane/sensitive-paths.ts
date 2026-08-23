/**
 * Sensitive-read denylist (Decision "reads free by default", part 1).
 *
 * Read-class tools no longer prompt for out-of-scope targets by default - a
 * normal read workload should not raise a yes/no every few seconds. The exfil
 * gate is kept exactly where it matters: reads whose resolved path matches a
 * sensitive-path rule still require confirmation.
 *
 * Two deliberate carve-outs on the agent directory (`<harness-home>/agent`):
 *   - Pi reading its OWN skills/config there is Pi's own operation, not exfil,
 *     so everything under the agent directory reads freely...
 *   - ...EXCEPT `agent/auth.json`, which is a live credential and stays gated.
 *
 * Pure and fs-free: paths are already canonicalized by the caller. Defaults are
 * a sane baseline; callers may extend them (e.g. from the Restricted policy's
 * deny patterns) so the list is configurable.
 */

import * as path from "node:path";

/** Extra sensitive patterns a caller can merge with the defaults. */
export interface SensitiveReadExtra {
  /** Exact basenames, e.g. "credentials". */
  basenames?: readonly string[];
  /** Substrings matched anywhere in the full path, e.g. "/.ssh/". */
  pathSubstrings?: readonly string[];
}

/** Exact file basenames that are categorically sensitive. */
export const DEFAULT_SENSITIVE_BASENAMES: readonly string[] = [
  "credentials",
  "credentials.json",
  "auth.json",
  ".netrc",
  ".pgpass",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
];

/** Basename suffixes that mark a secret file regardless of the stem. */
export const DEFAULT_SENSITIVE_SUFFIXES: readonly string[] = [".env", ".pem", ".key", "_rsa"];

/** Substrings within the basename that mark a secret. Kept narrow so ordinary
 * source files (tokenizer.ts, author.md) are not swept in; extend via config
 * when a project needs more. */
export const DEFAULT_SENSITIVE_BASENAME_SUBSTRINGS: readonly string[] = ["secret", "password"];

/** Substrings within the full path that mark a secret location. */
export const DEFAULT_SENSITIVE_PATH_SUBSTRINGS: readonly string[] = [
  "/.ssh/",
  "/.aws/",
  "/.gnupg/",
  "/.hermes/config.yaml",
];

/**
 * True when a canonical read target is sensitive and must still be confirmed.
 *
 * @param canonical  Already-canonicalized absolute path of the read target.
 * @param agentDir   Canonical path of `<harness-home>/agent` (the always-readable
 *                   agent directory), or null when it cannot be determined.
 * @param extra      Optional extra patterns merged with the defaults.
 */
export function isSensitiveReadTarget(
  canonical: string,
  agentDir: string | null,
  extra: SensitiveReadExtra = {},
): boolean {
  // Agent-directory carve-outs, checked first.
  if (agentDir !== null) {
    const authFile = path.join(agentDir, "auth.json");
    if (canonical === authFile) return true; // live credential: always gated
    if (canonical === agentDir || canonical.startsWith(agentDir + path.sep)) {
      return false; // Pi reading its own skills/config is not exfil
    }
  }

  const base = path.basename(canonical);
  const basenames = new Set([...DEFAULT_SENSITIVE_BASENAMES, ...(extra.basenames ?? [])]);
  if (basenames.has(base)) return true;
  for (const suffix of DEFAULT_SENSITIVE_SUFFIXES) {
    if (base.endsWith(suffix)) return true;
  }
  for (const sub of DEFAULT_SENSITIVE_BASENAME_SUBSTRINGS) {
    if (base.includes(sub)) return true;
  }
  for (const sub of [...DEFAULT_SENSITIVE_PATH_SUBSTRINGS, ...(extra.pathSubstrings ?? [])]) {
    if (canonical.includes(sub)) return true;
  }
  return false;
}
