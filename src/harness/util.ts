/**
 * Pi Harness - ids, timestamps, device and project keys.
 *
 * This module is pure in the same sense as src/control-plane/sandbox.ts:
 * every ambient input (clock, randomness, hostname, home directory) arrives
 * as an argument with a default, so unit tests can pin all of them and the
 * harness stays deterministic under test. Nothing here touches the
 * filesystem.
 *
 * Ids are prefixed by record kind on purpose. The MVP storage layout (spec
 * section 28) is append-only JSONL split across several files; a bare uuid
 * in an audit line tells a human reading the file nothing, whereas `dec_...`
 * immediately identifies which log to look in. Provenance is the whole point
 * of the audit format (invariant AU2), so it is worth six characters.
 */

import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";

/** Record-kind prefixes. Extend by adding here, never by inlining a literal
 * at a call site - `idKind()` below must stay able to recover the kind. */
export const ID_PREFIXES = {
  session: "ses",
  task: "tsk",
  decision: "dec",
  incident: "inc",
  memory: "mem",
  audit: "aud",
  review: "rev",
  checkpoint: "chk",
  delegation: "dlg",
  run: "run",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export type RandomSource = () => string;

/** `<prefix>_<32 hex>`. The hex body is a uuid with dashes stripped: no
 * added entropy assumptions, just a shorter line in the JSONL. */
export function makeId(kind: IdKind, random: RandomSource = randomUUID): string {
  return `${ID_PREFIXES[kind]}_${random().replace(/-/g, "")}`;
}

/** Recover the record kind from an id, or null if the id was not produced by
 * makeId. Used when reconciling cross-file references during recovery (spec
 * section 25 crash recovery) - a dangling `dec_...` reference tells the
 * reconciler which file it failed to find the target in. */
export function idKind(id: string): IdKind | null {
  const prefix = id.split("_", 1)[0];
  for (const [kind, value] of Object.entries(ID_PREFIXES)) {
    if (value === prefix) return kind as IdKind;
  }
  return null;
}

export type Clock = () => Date;

/** ISO-8601 with milliseconds, always UTC. Audit ordering is by this string,
 * so the format must be lexicographically sortable - `toISOString()` is, and
 * a locale-formatted timestamp would not be. */
export function nowIso(clock: Clock = () => new Date()): string {
  return clock().toISOString();
}

/**
 * Stable per-machine identifier.
 *
 * Deliberately derived (hostname + platform + arch + home) rather than
 * random-and-persisted: device state (spec section 17) is machine-local, and
 * a derived id means a wiped `~/.pi` still reconciles to the same device
 * rather than silently forking the device history. Hashed so a hostname -
 * which is often a person's name - never lands in an audit file.
 */
export function deviceId(
  env: { hostname: string; platform: string; arch: string; home: string } = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    home: os.homedir(),
  },
): string {
  const material = [env.hostname, env.platform, env.arch, env.home].join(" ");
  return `dev_${sha256(material).slice(0, 16)}`;
}

/**
 * Stable key for a project root, used as the directory name under
 * `projects/` in the storage layout.
 *
 * The basename is kept as a human-readable hint and the hash disambiguates
 * two checkouts of the same repository. The hash covers the *full* path, so
 * `~/work/api` and `~/scratch/api` never collide - they are different
 * authority domains (spec section 13: project relationships do not create
 * cross-project authority) and must not share project state.
 */
export function projectKey(projectRoot: string): string {
  const base = projectRoot.split("/").filter(Boolean).pop() ?? "root";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "root";
  return `${safe}-${sha256(projectRoot).slice(0, 12)}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
