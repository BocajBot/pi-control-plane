/**
 * Pi Harness - durable local state and append-only record files
 * (spec section 28; invariants AU1, AU5, M4, R1, R5).
 *
 * Unlike the rest of the harness this module does real I/O. It is the only
 * one that does, which is what lets everything else stay pure and unit-
 * testable. Tests here point `HarnessPaths` at a temp directory rather than
 * faking a filesystem, because the properties worth testing - atomic
 * replacement, append durability, a truncated last line - are properties of
 * the filesystem, and a fake would test the fake.
 *
 * Two disciplines run through everything below:
 *
 * Whole-file state (config, tasks, review queue, session state) is written
 * atomically: temp file in the same directory, then rename. A crash during
 * the write leaves the previous complete file, never a half-written one.
 * Invariant R5 says compaction cannot discard the only durable copy of
 * important state; a truncated state file discards it just as effectively.
 *
 * Append-only records (audit, decisions, incidents, memory) are appended
 * with a single `appendFileSync` per line and never rewritten. Reads
 * tolerate a damaged trailing line - a process killed mid-append leaves
 * exactly that, and the correct response is to surface the loss and keep the
 * intact prefix, not to refuse the whole file.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  chainEvent,
  chainTip,
  checkAuditTip,
  makeAuditTip,
  validateAuditEvent,
  validateAuditTip,
  verifyAuditChain,
} from "./audit.ts";
import { idKind } from "./util.ts";
import { emptyIdentity, validateIdentity } from "./identity.ts";
import { validateDelegationJob } from "./delegation-jobs.ts";
import { validateImprovementProposal, type ImprovementProposal } from "./decision-proposal.ts";
import { validateSoftPolicyRecord } from "./policy.ts";
import {
  defaultConfig,
  reviewDirFor,
  reviewGenerationFile,
  sessionStateFileFor,
  validateConfig,
  workstateFileFor,
  type HarnessPaths,
} from "./config.ts";
import {
  HARNESS_SCHEMA_VERSION,
  isSupportedSchemaVersion,
  type AuditChainVerification,
  type AuditEvent,
  type AuditTip,
  type DecisionRecord,
  type DelegationJobRecord,
  type HarnessConfig,
  type IncidentRecord,
  type MemoryEntry,
  type ReviewGeneration,
  type ReviewQueueItem,
  type GoalRecord,
  type IdentityState,
  type ProjectLink,
  type SessionIndexEntry,
  type SessionState,
  type SoftPolicyRecord,
  type TaskRecord,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/**
 * Modes for harness-owned state.
 *
 * This tree holds personal history, project detail, behavioural observations
 * about the user, and the full audit of what an agent did on their machine.
 * Under a normal 0022 umask every one of those files was world-readable. The
 * default is not a threat model - it is just the default - but "everything Pi
 * has ever noticed about you, readable by every account on the box" is not a
 * defensible one either.
 *
 * Applied only to files and directories the harness itself creates. Nothing
 * here touches project files.
 */
export const STATE_DIR_MODE = 0o700;
export const STATE_FILE_MODE = 0o600;

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
}

/**
 * Tighten a harness-owned file that already exists.
 *
 * `mode` on create does nothing for a file written before this rule existed,
 * and an append reuses the existing inode - so without this an upgraded
 * install would keep its 0644 audit log forever. Failures are swallowed: a
 * filesystem that cannot represent the mode (or a file owned by someone else)
 * is a reason to carry on writing, not a reason to lose the record.
 */
function tighten(file: string): void {
  try {
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, STATE_FILE_MODE);
  } catch {
    // Not fatal - see above.
  }
}

/**
 * Atomic whole-file write.
 *
 * The temp file must live in the same directory as the target: `rename` is
 * only atomic within a filesystem, and `/tmp` is frequently a different one.
 * The pid+counter suffix keeps two harness instances from colliding on the
 * temp name.
 */
let tempCounter = 0;
export function writeAtomic(file: string, contents: string): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp.${process.pid}.${tempCounter++}`;
  // The mode is set on the temp file, before the rename, so the target is
  // never briefly world-readable. Setting it afterwards would leave a window.
  fs.writeFileSync(temp, contents, { encoding: "utf8", mode: STATE_FILE_MODE });
  fs.renameSync(temp, file);
}

export function readJsonFile(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export interface JsonlReadResult<T> {
  records: T[];
  /** Lines that parsed as JSON but failed validation. Reported rather than
   * silently dropped: a rejected evidence line is itself a finding. */
  invalid: number;
  /** True when the final line was incomplete - the signature of a process
   * killed mid-append. Callers surface this during recovery (section 25)
   * instead of treating the file as clean. */
  truncatedTail: boolean;
}

/**
 * Read a JSONL file, keeping every record that validates.
 *
 * A malformed line in the *middle* counts as invalid; a malformed line at
 * the very end is reported as `truncatedTail` because that is what an
 * interrupted append looks like and it means something different for
 * recovery: the operation that was being logged may or may not have
 * happened, which is precisely invariant R4's "uncertain stays uncertain".
 */
export function readJsonl<T>(file: string, validate: (value: unknown) => T | null): JsonlReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { records: [], invalid: 0, truncatedTail: false };
  }
  if (raw.length === 0) return { records: [], invalid: 0, truncatedTail: false };

  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const records: T[] = [];
  let invalid = 0;
  let truncatedTail = false;

  lines.forEach((line, index) => {
    const isLast = index === lines.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (isLast && !endsWithNewline) truncatedTail = true;
      else invalid++;
      return;
    }
    const validated = validate(parsed);
    if (validated === null) invalid++;
    else records.push(validated);
  });

  return { records, invalid, truncatedTail };
}

/**
 * Hold an exclusive lock for the duration of `fn`.
 *
 * `O_EXCL` create is the primitive: it is atomic on every filesystem the
 * harness targets, including over NFS for local-scope use. The spin is
 * synchronous because every store method is, and making one of them async
 * would push a colour change through the whole extension.
 *
 * A read-modify-write on a shared file without this is not "mostly fine" -
 * measured, 60 concurrent writers lost 14 rows. That the lost rows were
 * *recoverable* by other means is a separate fact and not a reason to drop
 * them.
 *
 * A lock older than `STALE_LOCK_MS` is broken rather than waited on: the
 * holder crashed, and blocking a session forever on a dead process is worse
 * than the small race window that breaking it reopens.
 */
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock<T>(target: string, fn: () => T): T {
  const lock = `${target}.lock`;
  ensureDir(path.dirname(target));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: number | null = null;
  for (;;) {
    try {
      handle = fs.openSync(lock, "wx", STATE_FILE_MODE);
      break;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // The holder released it between our open and our stat; retry.
      }
      if (Date.now() > deadline) {
        // Proceeding unlocked would silently reintroduce the lost update this
        // function exists to stop, so the caller is told instead.
        throw new Error(`timed out waiting for lock on ${path.basename(target)}`);
      }
      sleepSync(2 + Math.floor(Math.random() * 8));
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (handle !== null) fs.closeSync(handle);
    } catch {
      /* already closed */
    }
    fs.rmSync(lock, { force: true });
  }
}

/** Append one record. Always newline-terminated, so the next append cannot
 * merge with this line and a reader can trust `truncatedTail`. */
export function appendJsonl(file: string, record: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: STATE_FILE_MODE });
  tighten(file);
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Permissive validator for the versioned record kinds whose full shape is
 * asserted at construction time. Rejects anything that is not an object with
 * a supported schema version and an id - enough to catch a corrupted line
 * without re-implementing every field check in two places.
 *
 * "Supported" rather than "current": a v0.1 record is real evidence of
 * something that happened, and a reader that discards it to satisfy the
 * current schema destroys history to tidy a type. Modules that need the
 * fields v0.1 lacked upgrade explicitly at the point of use, where the
 * default chosen is visible. */
function versionedRecord<T>(value: unknown): T | null {
  if (!isRecordObject(value)) return null;
  if (!isSupportedSchemaVersion(value.schemaVersion)) return null;
  if (typeof value.id !== "string") return null;
  return value as unknown as T;
}

/**
 * Strict validation for one row of the global session index.
 *
 * Stricter than `versionedRecord` because the whole value of this file is the
 * `projectRoot` field, and a row with a damaged one is worse than a missing
 * row: `findSessionProject` would answer with a non-path, and the caller
 * would go looking for another project's state under it. A dropped row costs
 * one lookup, which the caller can still satisfy by scanning the projects
 * directory; a repaired guess costs the caller the wrong project.
 */
function validateSessionIndexEntry(value: unknown): SessionIndexEntry | null {
  if (!isRecordObject(value)) return null;
  if (!isSupportedSchemaVersion(value.schemaVersion)) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  // The id must be one the harness could have issued. The index is a lookup
  // hint that a caller may use to *go and read another project's state*, so a
  // row with a made-up id and a chosen root is a redirection primitive. This
  // does not make the file trustworthy - see the threat-model note on
  // `readSessionIndex` - but it does stop a malformed or casually edited row
  // from resolving to somewhere no session ever ran.
  if (idKind(value.id) !== "session") return null;
  if (typeof value.projectRoot !== "string" || value.projectRoot.length === 0) return null;
  if (!path.isAbsolute(value.projectRoot)) return null;
  if (value.projectRoot.includes("\0")) return null;
  if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) return null;
  if (value.endedAt !== null && typeof value.endedAt !== "string") return null;
  return {
    schemaVersion: value.schemaVersion as number,
    id: value.id,
    projectRoot: value.projectRoot,
    startedAt: value.startedAt,
    endedAt: value.endedAt as string | null,
  };
}

/**
 * How far ahead of now a `startedAt` may be before the record is treated as
 * not-a-session. Generous enough to absorb ordinary clock skew between a
 * laptop and an NTP correction, small enough that a planted far-future file
 * cannot win the sort.
 */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Sort key for `listSessionStates`. `versionedRecord` does not re-check
 * every field, so a hand-edited file can carry a non-string here; such a file
 * sorts oldest rather than throwing from inside a comparator. */
function startedAtKey(state: SessionState): string {
  return typeof state.startedAt === "string" ? state.startedAt : "";
}

/**
 * The durable side of the harness.
 *
 * Constructed with an explicit `HarnessPaths`, never with a home directory:
 * config.ts owns the layout, and a store that could compute its own paths
 * would be a second place for the layout to live.
 */
export class HarnessStore {
  /** Declared and assigned explicitly rather than as a constructor parameter
   * property: Node runs this package's TypeScript in strip-only mode, which
   * does not support that syntax. */
  readonly paths: HarnessPaths;

  /**
   * In-memory tip of the audit hash chain (spec section 32).
   *
   * Read from the file once, on this process's first append, then advanced in
   * memory. Deriving it from the file on every append would make writing the
   * evidence quadratic in the length of the evidence, and audit.jsonl is the
   * file that grows fastest of any in the layout.
   *
   * `auditTipLoaded` is a separate flag rather than a `null` check because
   * `null` is a legitimate tip value: it is what an empty audit file has, and
   * conflating the two would re-read the file on every append for exactly the
   * session that starts from empty.
   */
  private auditTip: string | null = null;
  private auditTipLoaded = false;

  constructor(paths: HarnessPaths) {
    this.paths = paths;
  }

  /** Create the directory skeleton. Idempotent; safe to call at every
   * session start. */
  init(): void {
    ensureDir(this.paths.home);
    ensureDir(this.paths.modelsDir);
    ensureDir(this.paths.reviewsDir);
    ensureDir(this.paths.projectDir);
    ensureDir(this.paths.sessionsDir);
    // Lives inside the project rather than the harness home, next to
    // WORKSTATE.md: someone recovering by hand (spec section 16) is reading
    // the project, and a recovery copy they cannot find is not a recovery
    // copy.
    ensureDir(this.paths.workstatesDir);
  }

  /* --- config ---------------------------------------------------- */

  readConfig(): HarnessConfig {
    const validated = validateConfig(readJsonFile(this.paths.configFile));
    return validated ?? defaultConfig();
  }

  writeConfig(config: HarnessConfig): void {
    writeAtomic(this.paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
  }

  /* --- session state --------------------------------------------- */

  /**
   * Session state is whole-file rather than append-only because it is a
   * *current* value, not a history. Its history lives in the audit log,
   * where it cannot be overwritten - that separation is what lets this file
   * be replaced freely without weakening AU1.
   *
   * This pair addresses the legacy v0.1 path, one snapshot per project.
   * v0.2 code writes `writeSessionStateFor` instead; see
   * `readLatestSessionState` for why the legacy file is still read.
   */
  readSessionState(): SessionState | null {
    return versionedRecord<SessionState>(readJsonFile(this.paths.sessionStateFile));
  }

  writeSessionState(state: SessionState): void {
    writeAtomic(this.paths.sessionStateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  /* --- per-session state (spec section 32) ------------------------ */

  /**
   * Structured state for one session, at `sessions/<session-id>.json`.
   *
   * v0.1 kept a single mutable `session-state.json` per project, which meant
   * the second session in a project silently destroyed the first one's state:
   * the interrupted session a reviewer most wanted to read back was the one
   * whose file had already been overwritten by its successor. One file per
   * session is the fix, and it is also what makes two concurrent sessions in
   * the same project representable at all.
   */
  writeSessionStateFor(state: SessionState): void {
    writeAtomic(sessionStateFileFor(this.paths, state.id), `${JSON.stringify(state, null, 2)}\n`);
  }

  readSessionStateFor(sessionId: string): SessionState | null {
    return versionedRecord<SessionState>(readJsonFile(sessionStateFileFor(this.paths, sessionId)));
  }

  /**
   * Every per-session state in this project, newest `startedAt` first.
   *
   * Ordered by the timestamp inside the file rather than by mtime: mtime
   * moves every time a session checkpoints, so mtime order answers "most
   * recently written", which would rank a long-dead session that received one
   * late write above the session that is actually current. Ties break on the
   * id so the order is total - an unstable order here would make
   * `readLatestSessionState` non-deterministic, and recovery picking a
   * different session on each run is worse than picking the wrong one
   * consistently.
   */
  listSessionStates(now: number = Date.now()): SessionState[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.paths.sessionsDir);
    } catch {
      return [];
    }
    const states: SessionState[] = [];
    for (const name of names) {
      // Skips the `.tmp.<pid>.<n>` files writeAtomic leaves in flight, which
      // are by definition half-written.
      if (!name.endsWith(".json")) continue;
      const state = versionedRecord<SessionState>(
        readJsonFile(path.join(this.paths.sessionsDir, name)),
      );
      if (state === null) continue;

      // The filename is derived from the id when the harness writes one, so a
      // mismatch means the file was not written by this code path. Cheap, and
      // it is the difference between "a session" and "a file someone put in
      // the sessions directory".
      if (path.basename(sessionStateFileFor(this.paths, state.id)) !== name) continue;

      // A start time in the future is not a session; it is a clock that is
      // wrong or a file that was planted. Either way it must not sort to the
      // front and become the resume point - which is what it would otherwise
      // do, since this list is ordered by `startedAt` and the caller takes
      // the head. Recovery reading the wrong session's scope and posture is
      // the failure R2 and R3 exist to prevent, and it does not require an
      // attacker to happen.
      const startedAt = Date.parse(startedAtKey(state));
      if (Number.isNaN(startedAt) || startedAt > now + FUTURE_SKEW_MS) continue;

      states.push(state);
    }
    return states.sort((a, b) => {
      const byStart = startedAtKey(b).localeCompare(startedAtKey(a));
      return byStart !== 0 ? byStart : b.id.localeCompare(a.id);
    });
  }

  /**
   * The newest per-session state, falling back to the legacy
   * `session-state.json` when this project has no per-session file.
   *
   * The legacy file is read and never written. A v0.1 session interrupted
   * before the upgrade left its only structured state in that file, and a
   * v0.2 harness that ignored it would orphan precisely the session that
   * needs recovering. Writing it back would instead recreate the
   * single-snapshot defect the per-session layout exists to remove, so the
   * legacy path is strictly an input.
   */
  readLatestSessionState(now: number = Date.now()): SessionState | null {
    const states = this.listSessionStates(now);
    if (states.length > 0) return states[0];
    return this.readSessionState();
  }

  /* --- global session index (spec section 32) --------------------- */

  /**
   * Every `sessionId -> projectRoot` row known on this device.
   *
   * The index is derived state: it could be rebuilt by scanning every
   * project's `sessions/` directory. It exists because that scan presupposes
   * knowing the project, and the question this file answers - "which project
   * was session X in" - is asked exactly when that is what is missing.
   *
   * Threat model: this file is unsigned and derived, and anything that can
   * write the harness home can write a convincing row. Row validation below
   * rejects malformed and implausible entries; it does not make the file
   * trustworthy against an attacker who already has that access. The boundary
   * the harness actually enforces is that a *model* cannot write here - the
   * harness home is outside every project scope, so a scope-checked tool call
   * cannot reach it. Treat a row as a hint to be corroborated, never as
   * authority.
   */
  readSessionIndex(): SessionIndexEntry[] {
    const raw = readJsonFile(this.paths.sessionsIndexFile);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => validateSessionIndexEntry(item))
      .filter((entry): entry is SessionIndexEntry => entry !== null);
  }

  /**
   * Insert or replace one row, rewriting the whole file atomically.
   *
   * Whole-file rather than append-only because a row is a current value:
   * `endedAt` is filled in when the session closes. Nothing is lost by
   * rewriting it, because the events this file summarises are already in the
   * audit log, which cannot be rewritten.
   *
   * An existing row keeps its position instead of moving to the end, so the
   * file stays readable as a chronological list of sessions rather than as a
   * list ordered by whichever session closed last.
   *
   * Read-modify-write means two harness processes upserting at the same
   * instant can lose one row. That is tolerable only because the index is
   * derived - the losing row is recoverable by scanning the project - and it
   * is the reason nothing but a lookup hint is ever stored here.
   */
  upsertSessionIndex(entry: SessionIndexEntry): void {
    // The read and the write are one critical section. Without the lock this
    // is a textbook lost update, and it was: 60 concurrent writers, 14 rows
    // gone, zero errors reported.
    withFileLock(this.paths.sessionsIndexFile, () => {
      const entries = this.readSessionIndex();
      const at = entries.findIndex((item) => item.id === entry.id);
      if (at >= 0) entries[at] = entry;
      else entries.push(entry);
      writeAtomic(this.paths.sessionsIndexFile, `${JSON.stringify(entries, null, 2)}\n`);
    });
  }

  /**
   * Rebuild the index for this project by scanning its session files.
   *
   * The index is a cache, and this is the proof: everything in it can be
   * recomputed from the per-session state files, which are the authority.
   * Recovery never needs this to have been called - `listSessionStates()`
   * scans directly - but a user who lost rows to an older build, or to a
   * lock timeout, can put them back.
   */
  rebuildSessionIndex(): number {
    const states = this.listSessionStates();
    return withFileLock(this.paths.sessionsIndexFile, () => {
      const existing = this.readSessionIndex();
      const byId = new Map(existing.map((row) => [row.id, row]));
      for (const state of states) {
        byId.set(state.id, {
          schemaVersion: HARNESS_SCHEMA_VERSION,
          id: state.id,
          projectRoot: state.projectRoot,
          startedAt: state.startedAt,
          endedAt: state.endedAt,
        });
      }
      const rows = [...byId.values()];
      writeAtomic(this.paths.sessionsIndexFile, `${JSON.stringify(rows, null, 2)}\n`);
      return rows.length - existing.length;
    });
  }

  /** The project a session belonged to, or null when the index has never
   * seen that id. Null means "unknown", not "no project": the caller may
   * still find the session by scanning, and must not read the absence as
   * evidence the session did not exist. */
  findSessionProject(sessionId: string): string | null {
    const entry = this.readSessionIndex().find((item) => item.id === sessionId);
    return entry ? entry.projectRoot : null;
  }

  /* --- append-only records --------------------------------------- */

  /**
   * Append one audit event, chained to the current tip (spec section 32).
   *
   * The hash is applied here rather than by the caller so that there is no
   * code path capable of writing an unchained line: chaining is a property of
   * the append, not a courtesy each caller has to remember.
   *
   * Two processes appending to the same file concurrently would each chain
   * from their own tip and produce a fork. That is left for `verifyAudit()`
   * to report rather than repaired here - a repaired chain is
   * indistinguishable from one that was never broken, and interleaved writers
   * are exactly the case a reader must be told about.
   */
  appendAudit(event: AuditEvent): void {
    // The whole read-tip -> chain -> append -> commit transaction is globally
    // serialized across harness processes on one host. Without this, two
    // processes read the same tip, both derive valid-looking successors, and
    // the chain can no longer represent both as one linear history - measured
    // pre-fix, 32 concurrent appenders produced 3 prevHash collisions and
    // verifyAudit broke at event 12. Per-line JSONL append is itself atomic,
    // so nothing was lost; what forked was the chain.
    //
    // Assumptions of the lock (see withFileLock): local-filesystem O_EXCL
    // semantics, NOT safe on NFS; a lock older than STALE_LOCK_MS is assumed
    // dead and broken; acquisition throws on timeout rather than proceeding
    // unlocked.
    withFileLock(this.paths.auditFile, () => {
      // The predecessor tip is re-derived from the file INSIDE the lock. The
      // per-process `auditTip` cache is stale the instant another process
      // appends, and trusting it is precisely the fork this method exists to
      // prevent. So the cache is never read here - only written, after the
      // append, for this process's own later reads.
      const before = this.readAudit().records;
      const chained = chainEvent(event, chainTip(before).prevHash);
      appendJsonl(this.paths.auditFile, chained);
      this.auditTip = chained.hash;
      this.auditTipLoaded = true;
      this.auditCount = before.length + 1;
      // Endpoint commitment, written after the append and never before, and
      // still inside the lock. The order matters: a crash between the two
      // leaves a tip that is *behind* the log, which `checkAuditTip` reports
      // as exactly that, and which the next locked append self-heals because
      // it recomputes the tip from the records (the orphaned event included).
      // Writing the tip first would leave one that is *ahead*, which is
      // indistinguishable from records having been deleted - the alarm this
      // file exists to raise. If the process dies here holding the lock, the
      // stale-break lets the next writer recover.
      writeAtomic(
        this.paths.auditTipFile,
        `${JSON.stringify({ schemaVersion: HARNESS_SCHEMA_VERSION, count: this.auditCount, lastHash: chained.hash, updatedAt: chained.timestamp }, null, 2)}\n`,
      );
    });
  }

  readAuditTip(): AuditTip | null {
    return validateAuditTip(readJsonFile(this.paths.auditTipFile));
  }

  /**
   * Verify the stored chain: which prefix is declared legacy-unverified,
   * which suffix actually hashes, and where it first breaks.
   *
   * Reads the file every time, unlike the append path. Verification is rare
   * and its whole purpose is to check what is on disk, so a cached answer
   * would be verifying the process's memory of the file instead.
   */
  verifyAudit(): AuditChainVerification {
    const records = this.readAudit().records;
    const chain = verifyAuditChain(records);
    const tip = checkAuditTip(records, this.readAuditTip());
    // The chain result stands on its own; the tip is an additional, weaker
    // check reported alongside rather than folded into `ok`. Folding them
    // would make "someone deleted two events" and "this record was edited"
    // the same answer, and they call for different responses.
    return { ...chain, tipConsistent: tip.consistent, tipReason: tip.reason };
  }

  /** Lazily-loaded chain tip. See the `auditTip` field for why this is read
   * once per process rather than once per append. */
  /** Records the log held at the last append this process made. Undefined
   * until the first append, when it is seeded from the file. */
  private auditCount: number | undefined = undefined;

  private auditChainTip(): string | null {
    if (!this.auditTipLoaded) {
      this.auditTip = chainTip(this.readAudit().records).prevHash;
      this.auditTipLoaded = true;
    }
    return this.auditTip;
  }

  readAudit(): JsonlReadResult<AuditEvent> {
    return readJsonl(this.paths.auditFile, validateAuditEvent);
  }

  /** Most recent `count` events, oldest first. Used by WORKSTATE and by
   * recovery, which needs the tail rather than the whole history. */
  readRecentAudit(count: number): AuditEvent[] {
    const { records } = this.readAudit();
    return records.slice(Math.max(0, records.length - count));
  }

  appendDecision(decision: DecisionRecord): void {
    appendJsonl(this.paths.decisionsFile, decision);
  }

  readDecisions(): JsonlReadResult<DecisionRecord> {
    return readJsonl(this.paths.decisionsFile, versionedRecord<DecisionRecord>);
  }

  appendDelegation(record: DelegationJobRecord): void {
    appendJsonl(this.paths.delegationsFile, record);
  }

  readDelegations(): JsonlReadResult<DelegationJobRecord> {
    return readJsonl(this.paths.delegationsFile, validateDelegationJob);
  }

  /** Phase 4.3: append one improvement proposal to the write-only channel.
   * There is deliberately no update or apply method - a proposal is enacted
   * only by a human editing AGENTS.md / config / memory. */
  appendImprovementProposal(record: ImprovementProposal): void {
    appendJsonl(this.paths.improvementProposalsFile, record);
  }

  readImprovementProposals(): JsonlReadResult<ImprovementProposal> {
    return readJsonl(this.paths.improvementProposalsFile, validateImprovementProposal);
  }

  appendIncident(incident: IncidentRecord): void {
    appendJsonl(this.paths.incidentsFile, incident);
  }

  readIncidents(): JsonlReadResult<IncidentRecord> {
    return readJsonl(this.paths.incidentsFile, versionedRecord<IncidentRecord>);
  }

  appendMemory(entry: MemoryEntry): void {
    appendJsonl(this.paths.memoryFile, entry);
  }

  readMemory(): JsonlReadResult<MemoryEntry> {
    return readJsonl(this.paths.memoryFile, versionedRecord<MemoryEntry>);
  }

  /* --- tasks and review queue ------------------------------------ */

  /**
   * Tasks are a whole-file JSON array rather than JSONL because a task's
   * *status* changes over its life and the queue is a current-state object.
   * Every transition is still recorded in the audit log, so replacing this
   * file loses no history (T1-T3 rely on the audit copy, not on this one).
   */
  readTasks(): TaskRecord[] {
    const raw = readJsonFile(this.paths.tasksFile);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => versionedRecord<TaskRecord>(item))
      .filter((item): item is TaskRecord => item !== null);
  }

  writeTasks(tasks: TaskRecord[]): void {
    writeAtomic(this.paths.tasksFile, `${JSON.stringify(tasks, null, 2)}\n`);
  }

  readReviewQueue(): ReviewQueueItem[] {
    const raw = readJsonFile(this.paths.reviewQueueFile);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => versionedRecord<ReviewQueueItem>(item))
      .filter((item): item is ReviewQueueItem => item !== null);
  }

  writeReviewQueue(items: ReviewQueueItem[]): void {
    writeAtomic(this.paths.reviewQueueFile, `${JSON.stringify(items, null, 2)}\n`);
  }

  /* --- review generations (spec section 32) ----------------------- */

  /**
   * Generation numbers already stored for one session, ascending.
   *
   * A resumed session can be reviewed more than once, and each run is kept
   * rather than overwriting the last. The second reviewer reading a longer
   * session does not make the first reading untrue - it makes it the reading
   * of a shorter session, which is a fact about when it was taken, not an
   * error to be corrected away.
   */
  listReviewGenerations(sessionId: string): number[] {
    let names: string[];
    try {
      names = fs.readdirSync(reviewDirFor(this.paths, sessionId));
    } catch {
      return [];
    }
    return names
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number.parseInt(name.slice(0, -".json".length), 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  }

  writeReviewGeneration(record: ReviewGeneration): void {
    writeAtomic(
      reviewGenerationFile(this.paths, record.sessionId, record.generation),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  readReviewGenerations(sessionId: string): ReviewGeneration[] {
    const out: ReviewGeneration[] = [];
    for (const generation of this.listReviewGenerations(sessionId)) {
      const parsed = versionedRecord<ReviewGeneration>(
        readJsonFile(reviewGenerationFile(this.paths, sessionId, generation)),
      );
      if (parsed !== null) out.push(parsed);
    }
    return out;
  }

  /* --- WORKSTATE -------------------------------------------------- */

  /**
   * The recovery file is written whole and lives inside the project, not in
   * the harness home. It is a snapshot for a human to read when structured
   * state is unavailable (spec section 16) - so it is deliberately the one
   * artifact that does not need the harness to interpret it.
   */
  writeWorkstate(markdown: string): void {
    writeAtomic(this.safeProjectPath(this.paths.workstateFile, "WORKSTATE.md"), markdown);
  }

  /**
   * Resolve a project-local recovery path, or divert to a harness-owned one.
   *
   * The attack this closes: `project/.pi` is a symlink to somewhere else, so
   * every Core-owned recovery write lands wherever the link points. Nothing
   * in the harness noticed, because writing a file the harness itself chose
   * the path for never went through a scope check - scope guards what the
   * *model* touches, and this is Core writing its own metadata.
   *
   * The check is on the resolved parent, not the file: the file usually does
   * not exist yet, and it is the directory that gets redirected. An existing
   * file that is itself a symlink is checked too, because `writeAtomic`
   * renames over the name rather than following it - but a pre-existing
   * `WORKSTATE.md` symlink would still be read through, and a reader that
   * followed it out of the project would report someone else's state as this
   * project's.
   *
   * Diverting rather than throwing is deliberate. Recovery metadata is what a
   * human reaches for when things have already gone wrong; refusing to write
   * it at all would turn a redirected file into no file.
   */
  private safeProjectPath(intended: string, label: string, mode: "read" | "write" = "write"): string {
    const root = this.paths.projectRoot;
    if (typeof root !== "string" || root.length === 0) return intended;
    let resolvedParent: string;
    try {
      resolvedParent = fs.realpathSync(path.dirname(intended));
    } catch {
      // The directory does not exist yet. Resolve the nearest ancestor that
      // does, so a symlinked `.pi` is still caught before it is created
      // through.
      let probe = path.dirname(intended);
      let guard = 0;
      while (!fs.existsSync(probe) && path.dirname(probe) !== probe && guard++ < 64) {
        probe = path.dirname(probe);
      }
      try {
        resolvedParent = fs.realpathSync(probe);
      } catch {
        return intended;
      }
    }
    let resolvedRoot: string;
    try {
      resolvedRoot = fs.realpathSync(root);
    } catch {
      return intended;
    }
    const inside = resolvedParent === resolvedRoot || resolvedParent.startsWith(resolvedRoot + path.sep);
    if (inside) {
      // The parent is fine; the leaf may still be a symlink pointing out.
      try {
        const linkTarget = fs.realpathSync(intended);
        if (!(linkTarget === resolvedRoot || linkTarget.startsWith(resolvedRoot + path.sep))) {
          this.divertedRecovery.push(`${label} -> ${linkTarget}`);
          return path.join(this.paths.recoveryFallbackDir, path.basename(intended));
        }
      } catch {
        // Does not exist yet, which is the ordinary case.
      }
      // A hardlink has no target to resolve: every path-based check says the
      // file is inside the project, because it is. What it is *also* is a
      // second name for an inode something outside the project can rewrite
      // afterwards, without ever touching the project again.
      //
      // Only reads care. `writeAtomic` renames a fresh temp file over the
      // name, which breaks the alias and leaves a clean project-local file -
      // so diverting a write here would exile a user's WORKSTATE for a
      // condition the write itself repairs. And because every harness write
      // goes through that rename, `nlink > 1` on a harness-owned recovery
      // file means someone else linked it, not that the harness did.
      if (mode === "read") {
        try {
          if (fs.lstatSync(intended).nlink > 1) {
            this.divertedRecovery.push(`${label} -> hardlink alias (nlink > 1)`);
            return path.join(this.paths.recoveryFallbackDir, path.basename(intended));
          }
        } catch {
          // Absent. Nothing to read, and nothing to be suspicious of.
        }
      }
      return intended;
    }
    this.divertedRecovery.push(`${label} -> ${resolvedParent}`);
    return path.join(this.paths.recoveryFallbackDir, path.basename(intended));
  }

  /**
   * Recovery writes that were redirected away from the project, as
   * `<what> -> <where it would have gone>`.
   *
   * Reported rather than thrown so the caller can audit it. A silent divert
   * would leave a user looking for `.pi/WORKSTATE.md` and finding nothing,
   * with no explanation anywhere.
   */
  readonly divertedRecovery: string[] = [];

  /**
   * Read the human-readable recovery snapshot - through the same boundary
   * the write went through.
   *
   * The write path was guarded and the read path was not, which is a real
   * asymmetry rather than a cosmetic one: `project/.pi` is attacker-
   * influenceable, so a symlink there made `readWorkstate()` return content
   * from anywhere on the filesystem while the harness attributed it to this
   * project. Reproduced on five vectors - a `.pi` symlink, a `workstates`
   * symlink, a `WORKSTATE.md` symlink, a per-session file symlink, and a
   * hardlink alias.
   *
   * "Non-authoritative" is not a licence to ingest. Nothing downstream reads
   * this file for control flow, but it is shown to a human as the state of
   * *this* project during recovery, which is exactly when they are least
   * placed to doubt it.
   *
   * An unsafe path reads the harness-owned fallback instead of refusing, for
   * the same reason the write diverts there: during recovery, no file is
   * worse than a file, and the diversion is recorded either way.
   */
  readWorkstate(): string | null {
    return this.readRecovery(this.paths.workstateFile, "WORKSTATE.md");
  }

  private readRecovery(intended: string, label: string): string | null {
    try {
      return fs.readFileSync(this.safeProjectPath(intended, label, "read"), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Per-session recovery copy at `.pi/workstates/<session-id>.md`.
   *
   * `WORKSTATE.md` is overwritten by whichever session checkpointed last, so
   * on its own it answers "what was happening most recently" and loses "what
   * was happening in the session that died". Both layers stay subordinate to
   * structured state and to the observed environment (invariant R2): a
   * per-session copy is a better snapshot, not a source of truth, and neither
   * file is read back by the harness for anything but display.
   */
  writeWorkstateFor(sessionId: string, markdown: string): void {
    writeAtomic(
      this.safeProjectPath(workstateFileFor(this.paths, sessionId), `workstates/${sessionId}.md`),
      markdown,
    );
  }

  readWorkstateFor(sessionId: string): string | null {
    return this.readRecovery(workstateFileFor(this.paths, sessionId), `workstates/${sessionId}.md`);
  }

  /* --- identity, goals, and policy state (spec sections 13, 17) --- */

  readIdentity(): IdentityState {
    return validateIdentity(readJsonFile(this.paths.identityFile)) ?? emptyIdentity();
  }

  writeIdentity(identity: IdentityState): void {
    writeAtomic(this.paths.identityFile, `${JSON.stringify(identity, null, 2)}\n`);
  }

  readGoals(): GoalRecord[] {
    const raw = readJsonFile(this.paths.goalsFile);
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => versionedRecord<GoalRecord>(item)).filter((g): g is GoalRecord => g !== null);
  }

  writeGoals(goals: GoalRecord[]): void {
    writeAtomic(this.paths.goalsFile, `${JSON.stringify(goals, null, 2)}\n`);
  }

  /** Project links have no id - they are identified by (from, to, kind) -
   * so they cannot use `versionedRecord`, which keys off one. */
  readProjectLinks(): ProjectLink[] {
    const raw = readJsonFile(this.paths.projectLinksFile);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is ProjectLink =>
        isRecordObject(item) &&
        item.schemaVersion === HARNESS_SCHEMA_VERSION &&
        typeof item.from === "string" &&
        typeof item.to === "string" &&
        typeof item.kind === "string",
    );
  }

  writeProjectLinks(links: ProjectLink[]): void {
    writeAtomic(this.paths.projectLinksFile, `${JSON.stringify(links, null, 2)}\n`);
  }

  private policyFileFor(level: "global" | "device" | "project"): string {
    if (level === "global") return this.paths.globalPolicyFile;
    if (level === "device") return this.paths.devicePolicyFile;
    return this.paths.projectPolicyFile;
  }

  readSoftPolicy(level: "global" | "device" | "project"): SoftPolicyRecord | null {
    return this.readSoftPolicyLayer(level).record;
  }

  /**
   * Read one policy layer, distinguishing absent from corrupt.
   *
   * `readSoftPolicy` returns null for both, and that conflation is what let a
   * persisted `additionalDeniedTools: ["write"]` become no restriction at all
   * the moment the file was damaged. Callers that care about authority must
   * use this; the null-returning wrapper stays for the ones that only want a
   * value.
   */
  readSoftPolicyLayer(level: "global" | "device" | "project"): {
    status: "absent" | "valid" | "corrupt";
    record: SoftPolicyRecord | null;
  } {
    const file = this.policyFileFor(level);
    if (!fs.existsSync(file)) return { status: "absent", record: null };
    const record = validateSoftPolicyRecord(readJsonFile(file));
    if (record === null) return { status: "corrupt", record: null };
    return { status: "valid", record };
  }

  /**
   * Every readable layer, plus the levels that exist and are unreadable.
   *
   * Returned together because a caller given only the records cannot tell the
   * difference between "no project policy" and "the project policy is
   * damaged", and those must not resolve to the same posture.
   */
  readSoftPolicyState(): { records: SoftPolicyRecord[]; unresolved: string[] } {
    const records: SoftPolicyRecord[] = [];
    const unresolved: string[] = [];
    for (const level of ["global", "device", "project"] as const) {
      const layer = this.readSoftPolicyLayer(level);
      if (layer.status === "valid" && layer.record !== null) records.push(layer.record);
      else if (layer.status === "corrupt") unresolved.push(level);
    }
    return { records, unresolved };
  }

  /**
   * Move a damaged policy layer aside so it can be inspected and replaced.
   *
   * Not deleted: the corrupt bytes are the only evidence of what the user had
   * configured, and a recovery path that destroys them is not a recovery
   * path. Returns the quarantine location, or null if there was nothing to
   * move.
   */
  quarantineSoftPolicy(level: "global" | "device" | "project", stamp: string): string | null {
    const file = this.policyFileFor(level);
    if (!fs.existsSync(file)) return null;
    const target = `${file}.corrupt.${stamp.replace(/[^0-9A-Za-z]/g, "")}`;
    try {
      fs.renameSync(file, target);
      return target;
    } catch {
      return null;
    }
  }

  writeSoftPolicy(record: SoftPolicyRecord): void {
    if (record.level !== "global" && record.level !== "device" && record.level !== "project") return;
    writeAtomic(this.policyFileFor(record.level), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** Every stored layer, broadest first. Missing layers are simply absent -
   * resolveSoftPolicy() starts from the defaults regardless. */
  readSoftPolicyChain(): SoftPolicyRecord[] {
    return (["global", "device", "project"] as const)
      .map((level) => this.readSoftPolicy(level))
      .filter((record): record is SoftPolicyRecord => record !== null);
  }

  /* --- model-specific instruction layer (spec section 6.4) -------- */

  readModelInstructions(file: string): string | null {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  appendGuidanceProposal(file: string, proposal: unknown): void {
    appendJsonl(file, proposal);
  }
}
