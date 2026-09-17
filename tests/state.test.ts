import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coerceToMode,
  cycleAutonomy,
  cycleMode,
  cyclePhase,
  defaultState,
  modeOf,
  sanitizeRestoredState,
  stateForMode,
  normalizePhase,
  resolveAutonomyInput,
  restoreFromEntries,
  validateState,
} from "../src/control-plane/state.ts";
import { STATE_ENTRY_TYPE } from "../src/control-plane/types.ts";

test("safe default initialization is Discuss + Read-only", () => {
  const state = defaultState();
  assert.equal(state.phase, "discuss");
  assert.equal(state.autonomy, "read-only");
  assert.deepEqual(state.sourceToggles, {});
});

test("valid state serializes and restores through JSON round-trip", () => {
  const state = defaultState();
  state.phase = "execute";
  state.autonomy = "restricted";
  state.sourceToggles["tool:bash"] = false;
  const restored = validateState(JSON.parse(JSON.stringify(state)));
  assert.notEqual(restored, null);
  assert.equal(restored!.phase, "execute");
  assert.equal(restored!.autonomy, "restricted");
  assert.equal(restored!.sourceToggles["tool:bash"], false);
});

test("malformed state is rejected", () => {
  assert.equal(validateState(null), null);
  assert.equal(validateState("nope"), null);
  assert.equal(validateState({}), null);
  assert.equal(validateState({ ...defaultState(), phase: "yolo" }), null);
  assert.equal(validateState({ ...defaultState(), autonomy: "unrestricted" }), null);
  assert.equal(validateState({ ...defaultState(), autonomy: "sandboxed" }), null);
  assert.equal(validateState({ ...defaultState(), sourceToggles: { a: "yes" } }), null);
});

test("unknown schema version is rejected, including the pre-task-brief-removal schema (1)", () => {
  assert.equal(validateState({ ...defaultState(), schemaVersion: 1 }), null);
  assert.equal(validateState({ ...defaultState(), schemaVersion: 3 }), null);
  assert.equal(validateState({ ...defaultState(), schemaVersion: "2" }), null);
});

test("restoration walks backward, skips malformed entries, survives interleaved entry types", () => {
  const good = defaultState("2026-07-18T01:00:00.000Z");
  good.phase = "plan";
  const entries = [
    { type: "custom", customType: STATE_ENTRY_TYPE, data: good },
    { type: "message" },
    { type: "compaction" }, // compaction entries must not disturb restoration
    { type: "custom", customType: "someone-elses-entry", data: { schemaVersion: 1 } },
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { schemaVersion: 99, phase: "execute" } },
  ];
  const result = restoreFromEntries(entries, STATE_ENTRY_TYPE);
  assert.equal(result.restored, true);
  assert.equal(result.ignoredMalformed, 1);
  assert.equal(result.state.phase, "plan");
});

test("corrupted restoration falls back to Read-only; a truly fresh session opens edit-ready", () => {
  // Malformed/unknown prior state must never silently gain edit power: it falls
  // back to the safe read-only default (the corruption invariant).
  const corrupt = [
    [{ type: "custom", customType: STATE_ENTRY_TYPE, data: { schemaVersion: 1, phase: "execute", autonomy: "attended" } }], // malformed (missing fields)
    [{ type: "custom", customType: STATE_ENTRY_TYPE, data: "garbage" }],
  ];
  for (const entries of corrupt) {
    const result = restoreFromEntries(entries as never[], STATE_ENTRY_TYPE);
    assert.equal(result.restored, false);
    assert.equal(result.state.phase, "discuss");
    assert.equal(result.state.autonomy, "read-only");
  }
  // No prior state at all is a fresh start, not a failure: it opens edit-ready
  // (Execute + Auto) so the daily driver works without a mode switch.
  const fresh = restoreFromEntries([] as never[], STATE_ENTRY_TYPE);
  assert.equal(fresh.restored, false);
  assert.equal(fresh.state.phase, "execute");
  assert.equal(fresh.state.autonomy, "auto");
});

test("source toggles default to enabled (empty map) and persist through restore", () => {
  const persisted = defaultState();
  persisted.sourceToggles["skill:foo"] = false;
  const result = restoreFromEntries(
    [{ type: "custom", customType: STATE_ENTRY_TYPE, data: JSON.parse(JSON.stringify(persisted)) }],
    STATE_ENTRY_TYPE,
  );
  assert.equal(result.state.sourceToggles["skill:foo"], false);
  assert.equal(result.state.sourceToggles["skill:bar"], undefined); // absent = enabled
});

test("phase normalization handles case and rejects invalid names", () => {
  assert.equal(normalizePhase("Discuss"), "discuss");
  assert.equal(normalizePhase("  EXECUTE "), "execute");
  assert.equal(normalizePhase("planning"), null);
  assert.equal(normalizePhase(""), null);
});

test("autonomy normalization: sandboxed is only an alias for restricted; unattended is a direct value", () => {
  assert.deepEqual(resolveAutonomyInput("Read-Only"), { autonomy: "read-only", sandboxAliasUsed: false });
  assert.deepEqual(resolveAutonomyInput("sandboxed"), { autonomy: "restricted", sandboxAliasUsed: true });
  assert.deepEqual(resolveAutonomyInput("unattended"), { autonomy: "unattended", sandboxAliasUsed: false });
  assert.equal(resolveAutonomyInput("yolo"), null);
});

test("cycle orders: discuss->plan->execute->verify->discuss, read-only->attended->auto->restricted->unattended->read-only", () => {
  assert.equal(cyclePhase("discuss"), "plan");
  assert.equal(cyclePhase("plan"), "execute");
  assert.equal(cyclePhase("execute"), "verify");
  assert.equal(cyclePhase("verify"), "discuss");
  assert.equal(cycleAutonomy("read-only"), "attended");
  assert.equal(cycleAutonomy("attended"), "auto");
  assert.equal(cycleAutonomy("auto"), "restricted");
  assert.equal(cycleAutonomy("restricted"), "unattended");
  assert.equal(cycleAutonomy("unattended"), "read-only");
});

test("mode mapping: four modes round-trip; combos without a mode are null", () => {
  assert.deepEqual(stateForMode("plan"), { phase: "plan", autonomy: "read-only" });
  assert.deepEqual(stateForMode("manual"), { phase: "execute", autonomy: "attended" });
  assert.deepEqual(stateForMode("accept"), { phase: "execute", autonomy: "auto" });
  assert.deepEqual(stateForMode("auto"), { phase: "execute", autonomy: "unattended" });
  for (const mode of ["plan", "manual", "accept", "auto"] as const) {
    const { phase, autonomy } = stateForMode(mode);
    assert.equal(modeOf(phase, autonomy), mode);
  }
  assert.equal(modeOf("execute", "read-only"), null);
  assert.equal(modeOf("plan", "attended"), null);
});

test("coerceToMode never escalates legacy combos", () => {
  assert.equal(coerceToMode("execute", "read-only"), "plan");
  assert.equal(coerceToMode("plan", "attended"), "plan");
  assert.equal(coerceToMode("verify", "restricted"), "plan");
  assert.equal(coerceToMode("execute", "attended"), "manual");
});

test("cycleMode walks all four modes: plan -> manual -> accept -> auto -> plan", () => {
  // "accept" (accept-edits) sits one step past manual, mirroring where other
  // agents put it, and "auto" (full autonomy) is last, reached only after the
  // others, never as an accidental single step from read-only Plan.
  assert.equal(cycleMode("plan"), "manual");
  assert.equal(cycleMode("manual"), "accept");
  assert.equal(cycleMode("accept"), "auto");
  assert.equal(cycleMode("auto"), "plan");
});

test("sanitizeRestoredState coerces legacy combos without escalation", () => {
  const legacy = { ...defaultState(), phase: "plan" as const, autonomy: "attended" as const };
  const cleaned = sanitizeRestoredState(legacy);
  assert.equal(cleaned.phase, "plan");
  assert.equal(cleaned.autonomy, "read-only");
});
