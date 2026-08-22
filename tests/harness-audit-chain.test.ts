/**
 * Audit hash chain (spec section 32, invariant AU1).
 *
 * The chain exists to make one specific claim checkable: nothing edited the
 * audit file behind the harness's back. These tests are written as refusals -
 * each one takes a file that verifies, damages it the way a tampering or a
 * corruption would, and asserts that verification says so and points at the
 * damage. A test that only ever proved "a good chain verifies" would pass
 * against a verifier that returned `ok: true` unconditionally.
 *
 * The other half is the legacy prefix: v0.1 records have no hashes and never
 * get one, so an all-legacy file must verify while reporting zero verified
 * events. Anything that reported those records as protected would be the
 * false claim section 32 was written to prevent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalAuditPayload,
  chainEvent,
  chainTip,
  hashAuditEvent,
  legacyPrefixDigest,
  makeAuditEvent,
  validateAuditEvent,
  verifyAuditChain,
  type AuditContext,
} from "../src/harness/audit.ts";
import { createScope } from "../src/harness/scope.ts";
import type { AuditEvent } from "../src/harness/types.ts";

let seq = 0;
const ids = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
const at = (iso: string) => () => new Date(iso);

const scope = createScope("/home/u/proj", "user", {}, at("2026-01-01T00:00:00.000Z"));

const ctx: AuditContext = {
  session: "ses_1",
  actor: "coordinator",
  actorModel: { provider: "llama-swap", model: "model-a" },
  scope,
};

/** An unchained event, i.e. exactly the shape a v0.1 line loads back as. */
function legacyEvent(n: number): AuditEvent {
  return makeAuditEvent(
    ctx,
    { eventType: "tool_call", request: `legacy ${n}`, result: "ok", metadata: { n } },
    at(`2026-01-0${n}T00:00:00.000Z`),
    ids,
  );
}

/** Append through the same path the store must use: read the tip, chain, push. */
function appendChained(file: AuditEvent[], event: AuditEvent): AuditEvent[] {
  return [...file, chainEvent(event, chainTip(file).prevHash)];
}

function buildFile(legacyCount: number, chainedCount: number): AuditEvent[] {
  let file: AuditEvent[] = [];
  for (let i = 0; i < legacyCount; i += 1) file.push(legacyEvent(i + 1));
  for (let i = 0; i < chainedCount; i += 1) {
    file = appendChained(
      file,
      makeAuditEvent(
        ctx,
        { eventType: "checkpoint", request: `chained ${i}`, result: "ok", metadata: { i, tag: "chained" } },
        at(`2026-02-0${i + 1}T00:00:00.000Z`),
        ids,
      ),
    );
  }
  return file;
}

/* ---------------------------------------------------------------- *
 * Construction
 * ---------------------------------------------------------------- */

test("a freshly constructed event is unchained: only the append path knows the tip", () => {
  const event = makeAuditEvent(ctx, { eventType: "tool_call", request: "r", result: "ok" }, at("2026-01-01T00:00:00.000Z"), ids);
  assert.equal(event.prevHash, null);
  assert.equal(event.hash, null);
});

test("chainEvent returns a copy and never mutates the event it was given", () => {
  const event = makeAuditEvent(ctx, { eventType: "tool_call", request: "r", result: "ok" }, at("2026-01-01T00:00:00.000Z"), ids);
  const chained = chainEvent(event, "abc");
  assert.equal(event.prevHash, null, "the original must not acquire a link");
  assert.equal(event.hash, null, "the original must not acquire a hash");
  assert.equal(chained.prevHash, "abc");
  assert.equal(chained.hash, hashAuditEvent(chained));
  assert.notEqual(chained, event);
});

test("a v0.1 line without prevHash/hash still loads, as unchained", () => {
  const loaded = validateAuditEvent({
    schemaVersion: 1,
    id: "aud_old",
    timestamp: "2026-01-01T00:00:00.000Z",
    session: "ses_1",
    actor: "coordinator",
    actorModel: null,
    eventType: "tool_call",
    request: "r",
    result: "ok",
    scope: "/home/u/proj",
    metadata: {},
  });
  assert.notEqual(loaded, null, "a pre-chain record is evidence, not a broken line");
  assert.equal(loaded?.prevHash, null);
  assert.equal(loaded?.hash, null);
});

test("a chained line round-trips through JSON and the validator with its digest intact", () => {
  const file = buildFile(0, 3);
  const reloaded = file.map((event) => validateAuditEvent(JSON.parse(JSON.stringify(event))) as AuditEvent);
  assert.equal(reloaded.every((event) => event !== null), true);
  // The digest must survive serialization, or every read-back would look
  // like tampering.
  const outcome = verifyAuditChain(reloaded);
  assert.equal(outcome.ok, true, outcome.reason);
  assert.equal(outcome.verifiedCount, 3);
});

/* ---------------------------------------------------------------- *
 * Canonical form
 * ---------------------------------------------------------------- */

test("hashing ignores JavaScript key insertion order, at the top level and inside metadata", () => {
  const base = buildFile(0, 1)[0];

  // Same record, assembled in a different order at both levels. This is not
  // hypothetical: an event built by makeAuditEvent, one rebuilt by the
  // validator, and one spread into a copy all differ this way.
  const reordered: AuditEvent = {
    hash: base.hash,
    prevHash: base.prevHash,
    metadata: Object.fromEntries(Object.entries(base.metadata).reverse()),
    scope: base.scope,
    result: base.result,
    request: base.request,
    eventType: base.eventType,
    actorModel: base.actorModel ? { model: base.actorModel.model, provider: base.actorModel.provider } : null,
    actor: base.actor,
    session: base.session,
    timestamp: base.timestamp,
    id: base.id,
    schemaVersion: base.schemaVersion,
  };

  assert.equal(canonicalAuditPayload(reordered), canonicalAuditPayload(base));
  assert.equal(hashAuditEvent(reordered), hashAuditEvent(base));
  assert.equal(verifyAuditChain([reordered]).ok, true);
});

test("nested metadata objects hash by sorted key order, not build order", () => {
  const one = chainEvent(
    makeAuditEvent(ctx, { eventType: "tool_call", request: "r", result: "ok", metadata: { a: { x: 1, y: [2, 3] }, b: "z" } }, at("2026-01-01T00:00:00.000Z"), () => "00000000-0000-4000-8000-000000000099"),
    null,
  );
  const two = chainEvent(
    makeAuditEvent(ctx, { eventType: "tool_call", request: "r", result: "ok", metadata: { b: "z", a: { y: [2, 3], x: 1 } } }, at("2026-01-01T00:00:00.000Z"), () => "00000000-0000-4000-8000-000000000099"),
    null,
  );
  assert.equal(one.hash, two.hash);
});

test("array order inside metadata is data and does change the digest", () => {
  const build = (list: number[]) =>
    chainEvent(
      makeAuditEvent(ctx, { eventType: "tool_call", request: "r", result: "ok", metadata: { list } }, at("2026-01-01T00:00:00.000Z"), () => "00000000-0000-4000-8000-000000000098"),
      null,
    );
  assert.notEqual(build([1, 2]).hash, build([2, 1]).hash);
});

test("the digest covers prevHash, so an event cannot be moved to another position", () => {
  const event = makeAuditEvent(ctx, { eventType: "tool_call", request: "r", result: "ok" }, at("2026-01-01T00:00:00.000Z"), ids);
  assert.notEqual(chainEvent(event, "aaa").hash, chainEvent(event, "bbb").hash);
});

/* ---------------------------------------------------------------- *
 * Legacy prefix
 * ---------------------------------------------------------------- */

test("a v0.1-only file verifies as an all-legacy prefix with nothing claimed as protected", () => {
  const file = buildFile(4, 0);
  const outcome = verifyAuditChain(file);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verifiedCount, 0, "no v0.1 record may be reported as cryptographically verified");
  assert.equal(outcome.legacyPrefixLength, 4);
  assert.equal(outcome.brokenAt, null);
  assert.equal(outcome.legacyPrefixDigest, legacyPrefixDigest(file));
  assert.match(outcome.reason, /unverified/);
});

test("an empty file has no chain and nothing to anchor to", () => {
  const outcome = verifyAuditChain([]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verifiedCount, 0);
  assert.equal(outcome.legacyPrefixLength, 0);
  assert.equal(outcome.legacyPrefixDigest, null);

  const tip = chainTip([]);
  assert.deepEqual(tip, { prevHash: null, legacyPrefixLength: 0, legacyPrefixDigest: null });
});

test("legacyPrefixDigest is defined for an empty prefix and changes with the prefix", () => {
  const empty = legacyPrefixDigest([]);
  assert.match(empty, /^[0-9a-f]{64}$/);
  const one = buildFile(1, 0);
  assert.notEqual(legacyPrefixDigest(one), empty);
  assert.notEqual(legacyPrefixDigest(buildFile(2, 0)), legacyPrefixDigest(one));
});

test("the first chained event after a legacy prefix anchors to that prefix's digest", () => {
  const legacy = buildFile(3, 0);
  const expected = legacyPrefixDigest(legacy);

  const tip = chainTip(legacy);
  assert.equal(tip.prevHash, expected);
  assert.equal(tip.legacyPrefixLength, 3);
  assert.equal(tip.legacyPrefixDigest, expected);

  const file = appendChained(legacy, makeAuditEvent(ctx, { eventType: "audit_anchor", request: "anchor", result: "ok" }, at("2026-03-01T00:00:00.000Z"), ids));
  assert.equal(file[3].prevHash, expected);

  const outcome = verifyAuditChain(file);
  assert.equal(outcome.ok, true, outcome.reason);
  assert.equal(outcome.legacyPrefixLength, 3);
  assert.equal(outcome.verifiedCount, 1);
  assert.equal(outcome.legacyPrefixDigest, expected);
});

test("editing a legacy record after the anchor exists breaks the anchor", () => {
  // The anchor cannot prove the prefix was intact when it was written. It
  // does prove the prefix has not changed since - which is the only claim
  // section 32 makes about v0.1 records.
  const file = buildFile(3, 2);
  const damaged = [...file];
  damaged[1] = { ...damaged[1], result: "quietly rewritten" };

  const outcome = verifyAuditChain(damaged);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.brokenAt, 3, "the break surfaces at the first chained event");
  assert.match(outcome.reason, /legacy prefix digest/);
});

test("chainTip anchors past a stray unchained line rather than forking the chain", () => {
  const file = [...buildFile(1, 2), legacyEvent(9)];
  const tip = chainTip(file);
  assert.equal(tip.prevHash, file[2].hash, "the tip is the last chained hash, not the last line");
  assert.equal(tip.legacyPrefixLength, 1);

  // And the stray line is still reported as the anomaly it is.
  const outcome = verifyAuditChain(file);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.brokenAt, 3);
  assert.match(outcome.reason, /unchained record follows chained records/);
});

/* ---------------------------------------------------------------- *
 * Verification
 * ---------------------------------------------------------------- */

test("a chain of several events verifies end to end", () => {
  const file = buildFile(0, 5);
  for (let i = 1; i < file.length; i += 1) {
    assert.equal(file[i].prevHash, file[i - 1].hash);
  }
  const outcome = verifyAuditChain(file);
  assert.equal(outcome.ok, true, outcome.reason);
  assert.equal(outcome.verifiedCount, 5);
  assert.equal(outcome.legacyPrefixLength, 0);
  assert.equal(outcome.brokenAt, null);
});

test("editing ANY field of a chained event is refused, at that event's index", () => {
  const fields: Array<[string, (event: AuditEvent) => AuditEvent]> = [
    ["request", (e) => ({ ...e, request: "something else" })],
    ["result", (e) => ({ ...e, result: "actually failed" })],
    ["timestamp", (e) => ({ ...e, timestamp: "2020-01-01T00:00:00.000Z" })],
    ["actor", (e) => ({ ...e, actor: "user" })],
    ["actorModel", (e) => ({ ...e, actorModel: { provider: "llama-swap", model: "model-b" } })],
    ["eventType", (e) => ({ ...e, eventType: "session_close" })],
    ["scope", (e) => ({ ...e, scope: "/" })],
    ["metadata", (e) => ({ ...e, metadata: { ...e.metadata, injected: true } })],
    ["id", (e) => ({ ...e, id: "aud_forged" })],
    ["schemaVersion", (e) => ({ ...e, schemaVersion: 1 })],
    ["prevHash", (e) => ({ ...e, prevHash: "0".repeat(64) })],
    ["hash", (e) => ({ ...e, hash: "0".repeat(64) })],
  ];

  for (const [field, damage] of fields) {
    for (const index of [0, 2, 4]) {
      const file = buildFile(0, 5);
      const damaged = [...file];
      damaged[index] = damage(damaged[index]);
      const outcome = verifyAuditChain(damaged);
      assert.equal(outcome.ok, false, `editing ${field} at ${index} must be refused`);
      assert.equal(outcome.brokenAt, index, `editing ${field} must break at ${index}`);
      assert.equal(outcome.verifiedCount, index, "events before the break stay verified");
    }
  }
});

test("reordering two chained events is refused at the first moved position", () => {
  const file = buildFile(0, 4);
  const swapped = [...file];
  swapped[1] = file[2];
  swapped[2] = file[1];

  const outcome = verifyAuditChain(swapped);
  assert.equal(outcome.ok, false, "order is part of the record");
  assert.equal(outcome.brokenAt, 1);
  assert.equal(outcome.verifiedCount, 1);
});

test("deleting an event from the middle is refused", () => {
  const file = buildFile(0, 4);
  const outcome = verifyAuditChain([file[0], file[2], file[3]]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.brokenAt, 1);
});

test("inserting a forged event is refused even when it is internally well formed", () => {
  const file = buildFile(0, 3);
  // Self-consistent - its own hash recomputes - but it does not link into
  // the file it was dropped into.
  const forged = chainEvent(
    makeAuditEvent(ctx, { eventType: "authorization", request: "grant everything", result: "ok" }, at("2026-04-01T00:00:00.000Z"), ids),
    "f".repeat(64),
  );
  assert.equal(hashAuditEvent(forged), forged.hash, "the forgery is internally consistent");

  const outcome = verifyAuditChain([file[0], forged, file[1], file[2]]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.brokenAt, 1);
});

test("truncating the tail still verifies the surviving prefix", () => {
  const file = buildFile(2, 5);
  for (let keep = file.length; keep >= 2; keep -= 1) {
    const outcome = verifyAuditChain(file.slice(0, keep));
    assert.equal(outcome.ok, true, `truncated to ${keep}: ${outcome.reason}`);
    assert.equal(outcome.legacyPrefixLength, 2);
    assert.equal(outcome.verifiedCount, keep - 2);
    assert.equal(outcome.brokenAt, null);
  }
});

test("appending continues a chain that already exists rather than restarting it", () => {
  const file = buildFile(2, 3);
  const extended = appendChained(file, makeAuditEvent(ctx, { eventType: "session_close", request: "close", result: "ok" }, at("2026-05-01T00:00:00.000Z"), ids));
  assert.equal(extended[5].prevHash, file[4].hash);
  const outcome = verifyAuditChain(extended);
  assert.equal(outcome.ok, true, outcome.reason);
  assert.equal(outcome.verifiedCount, 4);
  assert.equal(outcome.legacyPrefixLength, 2);
});
