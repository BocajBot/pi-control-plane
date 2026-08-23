/**
 * Phase 4.1 - decision telemetry contract.
 *
 * The evidence layer must produce verifiable evidence of important decisions
 * without becoming a second control plane. These tests hold the contract to
 * exactly that: it records only important decisions, it records a bounded shape
 * (never a reasoning trace), the record is tamper-evident inside the existing
 * hash chain, and it needs no schema bump. Evaluation and proposals are Phase
 * 4.2/4.3 and are deliberately absent here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";

import {
  buildDecisionTelemetry,
  buildDecisionOutcome,
  IMPORTANT_DECISION_ACTIONS,
  MAX_LABEL_LEN,
  type DecisionTelemetry,
} from "../src/harness/decision-telemetry.ts";
import {
  type AuditContext,
  chainEvent,
  chainTip,
  makeAuditEvent,
  validateAuditEvent,
  verifyAuditChain,
} from "../src/harness/audit.ts";
import { createScope } from "../src/harness/scope.ts";
import { HARNESS_SCHEMA_VERSION, type AuditEvent } from "../src/harness/types.ts";

/* ---- contract: only important decisions are recorded (risk 1) ---- */

test("telemetry: a non-important action is refused (returns null, records nothing)", () => {
  for (const action of ["execute", "ask", "defer", "read", "grep", "", "anything"]) {
    assert.equal(
      buildDecisionTelemetry({ decisionId: "d1", action }),
      null,
      `${action || "(empty)"} must not be recorded`,
    );
  }
});

test("telemetry: every important action IS recorded", () => {
  for (const action of IMPORTANT_DECISION_ACTIONS) {
    const rec = buildDecisionTelemetry({ decisionId: "d1", action });
    assert.notEqual(rec, null, `${action} must be recordable`);
    assert.equal(rec?.action, action);
  }
});

test("telemetry: an empty decisionId is refused (no join key, no record)", () => {
  assert.equal(buildDecisionTelemetry({ decisionId: "", action: "delegate" }), null);
  assert.equal(buildDecisionTelemetry({ decisionId: "   ", action: "delegate" }), null);
});

/* ---- contract: bounded shape, never a reasoning trace ---- */

test("telemetry: extra keys (reasoning, chain-of-thought, model internals) are dropped, not stored", () => {
  const rec = buildDecisionTelemetry({
    decisionId: "d1",
    action: "delegate",
    category: "implementation_task",
    rule: "parallelizable_work",
    // none of these belong in the durable record:
    reasoning: "first I considered X then Y then decided Z because ...",
    chainOfThought: ["step 1", "step 2"],
    modelInternals: { logits: [0.1, 0.2] },
    rawPrompt: "the entire system prompt",
  } as unknown as Parameters<typeof buildDecisionTelemetry>[0]);
  assert.notEqual(rec, null);
  const serialized = JSON.stringify(rec);
  for (const banned of ["reasoning", "chainOfThought", "modelInternals", "rawPrompt", "step 1", "logits"]) {
    assert.equal(serialized.includes(banned), false, `"${banned}" must not survive into the record`);
  }
  // The record carries exactly the contract keys, nothing more.
  assert.deepEqual(
    Object.keys(rec as DecisionTelemetry).sort(),
    ["action", "category", "confidence", "context", "decisionId", "outcome", "rule"],
  );
});

test("telemetry: label fields are capped to label size, so prose cannot be smuggled in", () => {
  const prose =
    "I chose to delegate because the task decomposes into three independent subtasks and the reviewer previously flagged that inline edits to this module tend to regress the audit tests, so a bounded subagent is safer here";
  const rec = buildDecisionTelemetry({
    decisionId: "d",
    action: "delegate",
    category: prose,
    rule: prose,
    outcome: { status: prose },
    context: { taskClass: prose },
  }) as DecisionTelemetry;
  assert.ok(rec.category.length <= MAX_LABEL_LEN, "category is a label, not a sentence");
  assert.ok(rec.rule.length <= MAX_LABEL_LEN);
  assert.ok(rec.outcome.status.length <= MAX_LABEL_LEN);
  assert.ok((rec.context.taskClass ?? "").length <= MAX_LABEL_LEN);
  // The full reasoning sentence cannot appear anywhere in the record.
  assert.equal(JSON.stringify(rec).includes("bounded subagent is safer"), false);
});

test("telemetry: confidence is kept only when it is a real 0..1 number, else null", () => {
  const at = (c: unknown) =>
    buildDecisionTelemetry({ decisionId: "d", action: "delegate", confidence: c as number })?.confidence;
  assert.equal(at(0), 0);
  assert.equal(at(0.72), 0.72);
  assert.equal(at(1), 1);
  assert.equal(at(1.5), null, "out of range -> null, never a silent clamp to 1");
  assert.equal(at(-0.1), null);
  assert.equal(at(NaN), null);
  assert.equal(at("0.9"), null, "a string is not a confidence");
  assert.equal(at(undefined), null);
});

test("telemetry: context is bounded - complexity enumerated, capabilities deduped strings", () => {
  const rec = buildDecisionTelemetry({
    decisionId: "d",
    action: "delegate",
    context: {
      taskClass: "coding",
      estimatedComplexity: "medium",
      availableCapabilities: ["delegate", "review", "delegate", "", 7 as unknown as string],
    },
  });
  assert.equal(rec?.context.taskClass, "coding");
  assert.equal(rec?.context.estimatedComplexity, "medium");
  assert.deepEqual(rec?.context.availableCapabilities, ["delegate", "review"]);

  const bad = buildDecisionTelemetry({
    decisionId: "d",
    action: "delegate",
    context: { estimatedComplexity: "gigantic" },
  });
  assert.equal(bad?.context.estimatedComplexity, null, "an unknown complexity is null, not passed through");
  assert.equal(bad?.context.taskClass, null);
  assert.deepEqual(bad?.context.availableCapabilities, []);
});

test("telemetry: outcome defaults are safe (pending, 0 retries, no override)", () => {
  const rec = buildDecisionTelemetry({ decisionId: "d", action: "delegate" });
  assert.deepEqual(rec?.outcome, { status: "pending", retries: 0, userOverride: false });
  const neg = buildDecisionTelemetry({ decisionId: "d", action: "delegate", outcome: { retries: -3 } });
  assert.equal(neg?.outcome.retries, 0, "a negative retry count is not a retry count");
});

test("telemetry: building is deterministic - same input, deep-equal output, no hidden state", () => {
  const input = {
    decisionId: "d1",
    action: "delegate",
    category: "implementation_task",
    rule: "parallelizable_work",
    confidence: 0.72,
    context: { taskClass: "coding", estimatedComplexity: "medium", availableCapabilities: ["delegate", "review"] },
    outcome: { status: "accepted", retries: 0, userOverride: false },
  };
  assert.deepEqual(buildDecisionTelemetry(input), buildDecisionTelemetry(input));
});

test("telemetry: an outcome record links back by decisionId and is sticky on override", () => {
  const decision = buildDecisionTelemetry({
    decisionId: "d1",
    action: "delegate",
    category: "implementation_task",
    rule: "parallelizable_work",
    outcome: { userOverride: false },
  }) as DecisionTelemetry;
  const outcome = buildDecisionOutcome(decision, { status: "rejected", retries: 1, userOverride: true });
  assert.equal(outcome.decisionId, "d1", "the join key is preserved");
  assert.equal(outcome.action, "delegate", "an outcome event is self-describing");
  assert.equal(outcome.outcome.status, "rejected");
  assert.equal(outcome.outcome.retries, 1);
  assert.equal(outcome.outcome.userOverride, true);
  // Override, once seen, cannot be un-seen by a later record that omits it.
  const later = buildDecisionOutcome(outcome, { status: "closed" });
  assert.equal(later.outcome.userOverride, true, "a recorded override stays recorded");
});

/* ---- contract: pure module, no I/O, no parallel store ---- */

test("telemetry: the contract module writes nothing itself (no fs / store import)", () => {
  const src = fs.readFileSync(new URL("../src/harness/decision-telemetry.ts", import.meta.url), "utf8");
  assert.equal(/from\s+["']node:fs["']/.test(src), false, "telemetry must not do its own I/O");
  assert.equal(/from\s+["'].*store["']/.test(src), false, "telemetry must not open a parallel store");
});

/* ---- audit integration: tamper-evident, no schema bump ---- */

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

function telemetryEvent(rec: DecisionTelemetry, iso: string): AuditEvent {
  return makeAuditEvent(
    ctx,
    { eventType: "decision_telemetry", request: rec.action, result: rec.outcome.status, metadata: { decision: rec } },
    at(iso),
    ids,
  );
}

test("telemetry: a decision_telemetry event enters the hash chain and verifies", () => {
  const rec = buildDecisionTelemetry({
    decisionId: "d1",
    action: "delegate",
    category: "implementation_task",
    rule: "parallelizable_work",
    confidence: 0.72,
  }) as DecisionTelemetry;
  const e1 = chainEvent(telemetryEvent(rec, "2026-02-01T00:00:00.000Z"), chainTip([]).prevHash);
  const file = [e1];
  // survives JSON round-trip + validation (the read path), with the digest intact
  const reloaded = file.map((e) => validateAuditEvent(JSON.parse(JSON.stringify(e))) as AuditEvent);
  assert.equal(reloaded.every((e) => e !== null), true);
  assert.equal(verifyAuditChain(reloaded).ok, true);
  // the bounded payload round-trips
  const back = reloaded[0].metadata.decision as DecisionTelemetry;
  assert.deepEqual(back, rec);
});

test("telemetry: tampering with the recorded decision breaks chain verification", () => {
  const rec = buildDecisionTelemetry({ decisionId: "d1", action: "delegate", confidence: 0.72 }) as DecisionTelemetry;
  const e1 = chainEvent(telemetryEvent(rec, "2026-02-01T00:00:00.000Z"), chainTip([]).prevHash);
  assert.equal(verifyAuditChain([e1]).ok, true);
  // an attacker rewrites the recorded confidence after the fact
  const tampered = JSON.parse(JSON.stringify(e1)) as AuditEvent;
  (tampered.metadata.decision as DecisionTelemetry).confidence = 0.99;
  const outcome = verifyAuditChain([validateAuditEvent(tampered) as AuditEvent]);
  assert.equal(outcome.ok, false, "a rewritten decision must fail verification");
});

test("telemetry: recording needs no schema bump and validates as a normal audit line", () => {
  const rec = buildDecisionTelemetry({ decisionId: "d1", action: "model_select", rule: "user_switch" }) as DecisionTelemetry;
  const e1 = chainEvent(telemetryEvent(rec, "2026-02-01T00:00:00.000Z"), chainTip([]).prevHash);
  assert.equal(e1.schemaVersion, HARNESS_SCHEMA_VERSION);
  assert.equal(HARNESS_SCHEMA_VERSION, 2, "Phase 4.1 must not bump the schema version");
  const loaded = validateAuditEvent(JSON.parse(JSON.stringify(e1)));
  assert.notEqual(loaded, null, "a decision_telemetry line is a valid audit line");
  assert.equal(loaded?.eventType, "decision_telemetry");
});
