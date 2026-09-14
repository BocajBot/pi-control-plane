/**
 * Pi Harness - audit event construction (spec section 15, invariants
 * AU1-AU5).
 *
 * Construction only. This module cannot write, amend, or delete anything;
 * store.ts owns the append. That split is the mechanical form of AU1: there
 * is no function anywhere in the harness that edits an existing audit line,
 * so "append-oriented" is a property of the code shape rather than a
 * convention someone has to remember.
 *
 * A correction is a new event referencing the old one via
 * `metadata.corrects`. The original stays exactly as first written, wrong
 * and readable - which is the point, since a retrospective reviewer's job
 * (spec section 11) is to explain what actually happened, and it cannot do
 * that against a record that has been tidied.
 *
 * v0.2 (spec section 32) adds a SHA-256 hash chain over appended events.
 * Append-orientation is a property of this code; the chain is what lets a
 * reader detect that someone edited the file *outside* this code. The two
 * are different claims and the second one needs evidence, not a promise.
 *
 * Records written by v0.1 carry no hash and are never given one. A digest
 * computed today over a line written months ago proves only that the line
 * reads as it currently reads - it says nothing about whether it was
 * altered in between - so back-filling would manufacture exactly the false
 * assurance the chain exists to avoid. Those records stay a declared
 * legacy-unverified prefix, and the first chained event anchors to the
 * digest of that prefix so that any edit made to it *after* the anchor was
 * written does surface.
 */

import {
  HARNESS_SCHEMA_VERSION,
  type AuditTip,
  type Actor,
  type AuditChainVerification,
  type AuditEvent,
  type AuditEventType,
  type ModelConfiguration,
  type ScopeState,
} from "./types.ts";
import { describeScope } from "./scope.ts";
import { isRecord, makeId, nowIso, sha256, type Clock, type RandomSource } from "./util.ts";

export interface AuditContext {
  session: string;
  actor: Actor;
  actorModel: ModelConfiguration | null;
  scope: ScopeState | null;
}

export interface AuditInput {
  eventType: AuditEventType;
  request: string;
  result: string;
  metadata?: Record<string, unknown>;
}

/**
 * Build one audit event.
 *
 * `actorModel` is nulled for the two non-model actors rather than trusted
 * from the caller. A "user" event carrying a model id would read, later, as
 * though a model had done something the user did - exactly the provenance
 * confusion AU2 exists to prevent.
 */
export function makeAuditEvent(
  ctx: AuditContext,
  input: AuditInput,
  clock: Clock = () => new Date(),
  random?: RandomSource,
): AuditEvent {
  const isModelActor = ctx.actor !== "user" && ctx.actor !== "core";
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: makeId("audit", random),
    timestamp: nowIso(clock),
    session: ctx.session,
    actor: ctx.actor,
    actorModel: isModelActor ? ctx.actorModel : null,
    eventType: input.eventType,
    request: input.request,
    result: input.result,
    scope: ctx.scope ? describeScope(ctx.scope) : "(no scope)",
    metadata: input.metadata ?? {},
    // Unchained on construction. Only the append path knows the current tip
    // of the file, and an event that guessed at it would produce a chain
    // that verifies against nothing. `chainEvent()` fills both fields in at
    // the moment the event is written (spec section 32).
    prevHash: null,
    hash: null,
  };
}

/**
 * Build the correction of an earlier event.
 *
 * Returns a *new* event; the caller appends it. There is intentionally no
 * variant that takes the original event and returns a modified copy, because
 * such a function would be the obvious thing to reach for and would quietly
 * break AU1 the first time someone wrote it back to the same file.
 */
export function makeCorrectionEvent(
  ctx: AuditContext,
  correctsEventId: string,
  input: AuditInput,
  clock: Clock = () => new Date(),
  random?: RandomSource,
): AuditEvent {
  return makeAuditEvent(
    ctx,
    { ...input, metadata: { ...(input.metadata ?? {}), corrects: correctsEventId } },
    clock,
    random,
  );
}

/**
 * Validate one line read back from `audit.jsonl`.
 *
 * Unlike the config validator, this one does *not* reject unknown keys.
 * Audit files are long-lived evidence: a line written by a newer harness
 * with an extra field is still a true record of something that happened, and
 * discarding it would lose evidence to satisfy a schema. Unknown *event
 * types* are likewise preserved rather than rejected - the reader's job is
 * to surface the record, not to decide it never occurred.
 */
export function validateAuditEvent(value: unknown): AuditEvent | null {
  if (!isRecord(value)) return null;
  if (typeof value.schemaVersion !== "number") return null;
  if (typeof value.id !== "string") return null;
  if (typeof value.timestamp !== "string") return null;
  if (typeof value.session !== "string") return null;
  if (typeof value.actor !== "string") return null;
  if (typeof value.eventType !== "string") return null;
  if (typeof value.request !== "string") return null;
  if (typeof value.result !== "string") return null;
  if (typeof value.scope !== "string") return null;
  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    timestamp: value.timestamp,
    session: value.session,
    actor: value.actor as Actor,
    actorModel: isRecord(value.actorModel) ? (value.actorModel as unknown as ModelConfiguration) : null,
    eventType: value.eventType as AuditEventType,
    request: value.request,
    result: value.result,
    scope: value.scope,
    metadata: isRecord(value.metadata) ? value.metadata : {},
    // Absent means "written before the chain existed", which is a legitimate
    // state, not a broken line: defaulting to null loads a v0.1 record as
    // what it is - unchained - instead of rejecting evidence over a field
    // that could not have been there. A non-string value is treated the same
    // way rather than coerced, because a repaired hash is a false one.
    prevHash: typeof value.prevHash === "string" ? value.prevHash : null,
    hash: typeof value.hash === "string" ? value.hash : null,
  };
}

/* ------------------------------------------------------------------ *
 * Hash chain (spec section 32)
 * ------------------------------------------------------------------ */

/**
 * The fields covered by an event's digest, in the order they are hashed.
 *
 * The order lives here, in the code, rather than in whatever order the
 * object literal happened to be built. An event reconstructed by
 * `validateAuditEvent()` from a JSONL line, an event built by
 * `makeAuditEvent()`, and an event spread into a copy all have different
 * key insertion orders; if the digest followed insertion order, the same
 * record would hash three different ways and the chain would "break" on a
 * plain read-back.
 *
 * `hash` is excluded because it is the output. Everything else is included,
 * `prevHash` above all - that is the link, and a digest that omitted it
 * would let any event be moved to any position in the file.
 *
 * This list is tied to the schema version. A field added in a later schema
 * must be appended here, and events written by that later harness will then
 * fail to verify under this one. That failure is correct and must be read
 * as "this reader cannot verify these records", never as tampering.
 */
const CANONICAL_FIELDS = [
  "schemaVersion",
  "id",
  "timestamp",
  "session",
  "actor",
  "actorModel",
  "eventType",
  "request",
  "result",
  "scope",
  "metadata",
  "prevHash",
] as const;

/**
 * JSON with every object's keys sorted, applied recursively.
 *
 * `metadata` is an open `Record<string, unknown>` filled in by call sites,
 * so its insertion order is whatever the caller's code path produced. Two
 * runs that record the same facts in a different order must not produce
 * different digests, otherwise the chain reports tampering when nothing
 * happened. Arrays keep their order: element order is data.
 *
 * Values `JSON.stringify` cannot represent (undefined, functions, symbols)
 * become `null`, matching what would land in the file when the event is
 * actually written - the digest must describe the bytes on disk, not the
 * richer in-memory object.
 */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      // Skip undefined members exactly as JSON.stringify does, so an
      // explicit `{ a: undefined }` and an absent `a` hash identically -
      // they serialize identically on the way to disk.
      if (record[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/**
 * Deterministic serialization of one event, excluding `hash`.
 *
 * The result is a JSON object literal, which matters for
 * `legacyPrefixDigest()`: `{...}{...}` is unambiguous without a separator,
 * so no delimiter is needed to keep two events from being confusable with
 * one.
 */
export function canonicalAuditPayload(event: AuditEvent): string {
  const source = event as unknown as Record<string, unknown>;
  const parts = CANONICAL_FIELDS.map(
    (field) => `${JSON.stringify(field)}:${stableStringify(source[field] ?? null)}`,
  );
  return `{${parts.join(",")}}`;
}

/** SHA-256 over the canonical payload. */
export function hashAuditEvent(event: AuditEvent): string {
  return sha256(canonicalAuditPayload(event));
}

/**
 * Digest of a run of events treated as one opaque block.
 *
 * Used for the legacy prefix: those records were written without hashes and
 * cannot be linked individually after the fact, but they can be committed
 * to *as a block* by the first chained event. That commitment is honest
 * about what it proves - the prefix has not changed since the anchor was
 * written - and silent about anything earlier.
 *
 * An empty array yields `sha256("")`, a real value rather than a special
 * case, so the very first chained event in an empty file has something well
 * defined to anchor to if a caller ever asks for it.
 */
export function legacyPrefixDigest(events: AuditEvent[]): string {
  return sha256(events.map(canonicalAuditPayload).join(""));
}

/**
 * What the next appended event must anchor to, given the whole file as it
 * currently stands.
 *
 * The tip is the *last* chained event's hash, not the last event's: if an
 * unchained line somehow follows chained ones (a v0.1 process writing to a
 * file a v0.2 process has already chained), anchoring to it would silently
 * fork the chain. Anchoring past it keeps the chain continuous and leaves
 * the stray line visible to `verifyAuditChain()` as the anomaly it is.
 */
export function chainTip(events: AuditEvent[]): {
  prevHash: string | null;
  legacyPrefixLength: number;
  legacyPrefixDigest: string | null;
} {
  let legacyPrefixLength = 0;
  while (legacyPrefixLength < events.length && events[legacyPrefixLength].hash === null) {
    legacyPrefixLength += 1;
  }
  const prefixDigest =
    legacyPrefixLength > 0 ? legacyPrefixDigest(events.slice(0, legacyPrefixLength)) : null;

  let lastChained: string | null = null;
  for (const event of events) {
    if (event.hash !== null) lastChained = event.hash;
  }
  if (lastChained !== null) {
    return { prevHash: lastChained, legacyPrefixLength, legacyPrefixDigest: prefixDigest };
  }

  // Nothing chained yet. A non-empty file is entirely legacy, so the first
  // chained event anchors to the whole of it; an empty file has nothing to
  // anchor to and starts the chain from null.
  return {
    prevHash: prefixDigest,
    legacyPrefixLength,
    legacyPrefixDigest: prefixDigest,
  };
}

/**
 * Return a chained copy of `event`.
 *
 * Copies rather than mutates for the same reason there is no
 * amend-in-place correction helper: nothing in this module hands a caller a
 * mutable reference to a record that is already evidence. The caller passes
 * the tip in; this function does not read the file, so it cannot disagree
 * with the append that follows it about what the tip was.
 */
export function chainEvent(event: AuditEvent, prevHash: string | null): AuditEvent {
  const linked: AuditEvent = { ...event, prevHash, hash: null };
  return { ...linked, hash: hashAuditEvent(linked) };
}

/**
 * Verify a whole audit file.
 *
 * Reports rather than throws, and reports the shape of the file rather than
 * a bare boolean: "400 unverifiable v0.1 lines followed by 12 verified
 * ones" is a different evidentiary object from "412 verified lines", and a
 * verifier that collapsed the two would be making the claim about v0.1
 * records that spec section 32 exists to prevent.
 *
 * `brokenAt` is the index of the *first* event that fails, so a reader gets
 * pointed at the earliest damage rather than at its downstream consequences.
 * Everything after a break is left unverified rather than reported as bad -
 * once the chain is cut, later links say nothing about the original file.
 */
export function verifyAuditChain(events: AuditEvent[]): AuditChainVerification {
  let legacyPrefixLength = 0;
  while (legacyPrefixLength < events.length && events[legacyPrefixLength].hash === null) {
    legacyPrefixLength += 1;
  }
  const prefixDigest =
    legacyPrefixLength > 0 ? legacyPrefixDigest(events.slice(0, legacyPrefixLength)) : null;

  if (legacyPrefixLength === events.length) {
    // No chained events at all. This verifies as "ok" in the only sense
    // available: there is no chain, and we are not pretending otherwise.
    return {
      ok: true,
      legacyPrefixLength,
      legacyPrefixDigest: prefixDigest,
      verifiedCount: 0,
      brokenAt: null,
      reason:
        events.length === 0
          ? "empty audit file"
          : `${events.length} legacy record(s), declared unverified: no hash chain present`,
    };
  }

  const broken = (index: number, why: string): AuditChainVerification => ({
    ok: false,
    legacyPrefixLength,
    legacyPrefixDigest: prefixDigest,
    verifiedCount: index - legacyPrefixLength,
    brokenAt: index,
    reason: `event ${index}: ${why}`,
  });

  for (let index = legacyPrefixLength; index < events.length; index += 1) {
    const event = events[index];
    if (event.hash === null) {
      // An unchained line inside the chained region. Either something wrote
      // to the file without going through the append path, or a chained
      // record lost its hash - both are exactly what this check is for.
      return broken(index, "unchained record follows chained records");
    }
    const expectedPrev =
      index === legacyPrefixLength ? prefixDigest : events[index - 1].hash;
    if (event.prevHash !== expectedPrev) {
      const why =
        index === legacyPrefixLength
          ? "first chained event does not anchor to the legacy prefix digest"
          : "prevHash does not match the preceding event's hash";
      return broken(index, why);
    }
    if (hashAuditEvent(event) !== event.hash) {
      return broken(index, "content does not match its recorded hash");
    }
  }

  const verifiedCount = events.length - legacyPrefixLength;
  return {
    ok: true,
    legacyPrefixLength,
    legacyPrefixDigest: prefixDigest,
    verifiedCount,
    brokenAt: null,
    reason:
      legacyPrefixLength === 0
        ? `${verifiedCount} chained event(s) verified`
        : `${verifiedCount} chained event(s) verified after ${legacyPrefixLength} legacy record(s) declared unverified`,
  };
}

/** One audit line, human-readable, for `/harness audit` and WORKSTATE. */
export function formatAuditEvent(event: AuditEvent): string {
  const who = event.actorModel ? `${event.actor}(${event.actorModel.model})` : event.actor;
  return `${event.timestamp} ${who} ${event.eventType}: ${event.request} -> ${event.result}`;
}

/* ------------------------------------------------------------------ *
 * Endpoint commitment (adversarial hardening)
 * ------------------------------------------------------------------ */

/**
 * Build the tip commitment for the log as it currently stands.
 *
 * A hash chain answers "was any record I can see altered". It cannot answer
 * "is a record missing from the end", because a truncated chain is a valid
 * chain - every link that remains still checks out. That is not a defect in
 * the chain; it is a property of chains, and the only fix is to commit to the
 * endpoint somewhere the chain does not live.
 */
export function makeAuditTip(events: AuditEvent[], clock: Clock = () => new Date()): AuditTip {
  const last = events.length > 0 ? events[events.length - 1] : null;
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    count: events.length,
    lastHash: last?.hash ?? null,
    updatedAt: nowIso(clock),
  };
}

export function validateAuditTip(value: unknown): AuditTip | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.count !== "number" || !Number.isInteger(record.count) || record.count < 0) return null;
  if (record.lastHash !== null && typeof record.lastHash !== "string") return null;
  if (typeof record.updatedAt !== "string") return null;
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : HARNESS_SCHEMA_VERSION,
    count: record.count,
    lastHash: record.lastHash as string | null,
    updatedAt: record.updatedAt,
  };
}

/**
 * Compare a log against its recorded endpoint.
 *
 * Three distinguishable outcomes, because they mean different things:
 *
 * - fewer records than the tip claims, or the same number ending on a
 *   different hash: records were removed or the tail was replaced. This is
 *   the case the chain alone cannot see.
 * - more records than the tip claims: the tip is simply behind, which is
 *   what a crash between the append and the tip write looks like, and what a
 *   second concurrent writer looks like. Not tampering, and reported as not
 *   tampering - calling it tampering would train the reader to ignore it.
 * - exact agreement: consistent.
 */
export function checkAuditTip(
  events: AuditEvent[],
  tip: AuditTip | null,
): { consistent: boolean; reason: string } {
  if (tip === null) {
    return { consistent: true, reason: "no endpoint commitment recorded yet" };
  }
  if (events.length < tip.count) {
    return {
      consistent: false,
      reason: `log holds ${events.length} record(s) but the endpoint commitment expects ${tip.count}: ${tip.count - events.length} were removed`,
    };
  }
  if (events.length === tip.count) {
    const last = events.length > 0 ? (events[events.length - 1].hash ?? null) : null;
    if (last !== tip.lastHash) {
      return { consistent: false, reason: "the final record does not match the endpoint commitment: the tail was replaced" };
    }
    return { consistent: true, reason: "log matches its endpoint commitment" };
  }
  return {
    consistent: true,
    reason: `endpoint commitment is behind by ${events.length - tip.count} record(s) (crash before the tip write, or a second writer)`,
  };
}
