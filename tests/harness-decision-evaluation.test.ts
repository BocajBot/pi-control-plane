/**
 * Phase 4.2 - read-only outcome evaluator (4.2.1, the pure module).
 *
 * The evaluator answers "did what happened match what was expected?" and
 * nothing more. These tests hold it to exactly that: it grades a telemetry
 * *claim* against observed *evidence* (never against itself), it is pure and
 * order-independent, it keeps the four operational meanings of "empty" apart
 * via coverage, and it carries no recommendation field (the 4.2/4.3 boundary).
 * Evidence adaptation (4.2.2) and the command (4.2.3) are deliberately absent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";

import {
  evaluate,
  type DecisionClaim,
  type DecisionObservation,
  type Evidence,
} from "../src/harness/decision-evaluation.ts";

const cleanChain = (total: number) => ({ ok: true, verifiedPrefix: total, total });

function claim(over: Partial<DecisionClaim> & { decisionId: string }): DecisionClaim {
  return {
    kind: "claim",
    eventId: `ev-${over.decisionId}`,
    at: "2026-02-01T00:00:00.000Z",
    action: "delegate",
    category: "subagent_delegation",
    rule: "bounded_read_only_delegation",
    claimedOutcome: "completed",
    ...over,
  };
}
function obs(over: Partial<DecisionObservation> & { decisionId: string }): DecisionObservation {
  return {
    kind: "observation",
    source: "delegate_runtime",
    refId: `job-${over.decisionId}`,
    at: "2026-02-01T00:01:00.000Z",
    observedOutcome: "completed",
    success: true,
    ...over,
  };
}
const run = (evidence: Evidence[], total = evidence.length) =>
  evaluate({ evidence, chain: cleanChain(total) });

/* ---- C (discriminating): grades against evidence, not the self-report ---- */

test("eval: a claim of success contradicted by the runtime log is a MISMATCH", () => {
  // This is the test the evaluator exists to pass. If it ever trusts the
  // telemetry outcome instead of the observed evidence, this flips to "match".
  const r = run([
    claim({ decisionId: "d1", claimedOutcome: "completed" }),
    obs({ decisionId: "d1", observedOutcome: "runtime_violation", success: false }),
  ]);
  assert.equal(r.decisions.length, 1);
  const d = r.decisions[0];
  assert.equal(d.verdict, "mismatch");
  assert.equal(d.telemetryClaim?.outcome, "completed");
  assert.equal(d.observedEvidence?.outcome, "runtime_violation");
  assert.equal(r.coverage.measured, 1);
});

test("eval: a claim of success confirmed by the runtime log is a MATCH", () => {
  const r = run([
    claim({ decisionId: "d1", claimedOutcome: "completed" }),
    obs({ decisionId: "d1", observedOutcome: "completed", success: true }),
  ]);
  assert.equal(r.decisions[0].verdict, "match");
  assert.equal(r.coverage.measured, 1);
});

test("eval: a claim of failure confirmed by the evidence is also a MATCH", () => {
  const r = run([
    claim({ decisionId: "d1", claimedOutcome: "blocked" }),
    obs({ decisionId: "d1", observedOutcome: "blocked", success: false }),
  ]);
  assert.equal(r.decisions[0].verdict, "match");
});

/* ---- coverage: the four operational meanings stay distinct ---- */

test("eval: a decision with no observation is UNMEASURED, never a match", () => {
  const r = run([claim({ decisionId: "d1" })]);
  assert.equal(r.decisions[0].verdict, "unmeasured");
  assert.equal(r.decisions[0].observedEvidence, null);
  assert.equal(r.coverage.unmeasured, 1);
  assert.equal(r.coverage.measured, 0);
});

test("eval: an unsupported action class is counted apart from unmeasured", () => {
  // "execute" is not an important decision class; telemetry never emits it, but
  // the evaluator must classify it as unsupported rather than silently grade it.
  const r = run([{ ...claim({ decisionId: "d1" }), action: "execute" }, obs({ decisionId: "d1" })]);
  assert.equal(r.coverage.unsupported, 1);
  assert.equal(r.coverage.unmeasured, 0);
  assert.equal(r.coverage.measured, 0);
  assert.deepEqual(r.byAction, {}, "an unsupported action is not aggregated as a known class");
});

test("eval: a non-terminal claim (pending) with evidence is UNMEASURED, not a verdict", () => {
  const r = run([
    claim({ decisionId: "d1", claimedOutcome: "pending" }),
    obs({ decisionId: "d1", success: true }),
  ]);
  assert.equal(r.decisions[0].verdict, "unmeasured");
  assert.equal(r.coverage.unmeasured, 1);
});

test("eval: coverage always partitions the decisions (observed = measured+unmeasured+unsupported)", () => {
  const r = run([
    claim({ decisionId: "m", claimedOutcome: "completed" }), obs({ decisionId: "m", success: true }),
    claim({ decisionId: "x", claimedOutcome: "completed" }), obs({ decisionId: "x", success: false }),
    claim({ decisionId: "u" }),
    { ...claim({ decisionId: "s" }), action: "nope" },
  ]);
  const c = r.coverage;
  assert.equal(c.decisionsObserved, c.measured + c.unmeasured + c.unsupported);
  assert.equal(c.measured, 2);
  assert.equal(c.unmeasured, 1);
  assert.equal(c.unsupported, 1);
});

test("eval: empty evidence yields an empty, non-throwing report (nothing evaluated != all correct)", () => {
  const r = evaluate({ evidence: [], chain: { ok: true, verifiedPrefix: 0, total: 0 } });
  assert.equal(r.coverage.decisionsObserved, 0);
  assert.equal(r.coverage.measured, 0);
  assert.deepEqual(r.decisions, []);
  assert.deepEqual(r.byAction, {});
});

/* ---- constraint 1: assertion vs evidence are distinct, tagged shapes ---- */

test("eval: claim and evidence are provenance-tagged, not two equal outcome fields", () => {
  const r = run([
    claim({ decisionId: "d1", claimedOutcome: "completed" }),
    obs({ decisionId: "d1", source: "review", observedOutcome: "accepted", success: true, refId: "rev-7" }),
  ]);
  const d = r.decisions[0];
  assert.deepEqual(d.telemetryClaim, { source: "decision_telemetry", outcome: "completed" });
  assert.deepEqual(d.observedEvidence, { source: "review", outcome: "accepted", refId: "rev-7" });
  assert.equal(d.verdict, "match", "a review-sourced observation joins by decisionId like any other");
});

/* ---- constraint 4: order-independence + determinism ---- */

test("eval: output is a function of the evidence SET (evaluate(A+B+C) == evaluate(C+A+B))", () => {
  const a = claim({ decisionId: "d1", claimedOutcome: "completed" });
  const b = obs({ decisionId: "d1", observedOutcome: "runtime_violation", success: false });
  const c = claim({ decisionId: "d2", claimedOutcome: "blocked" });
  const forward = evaluate({ evidence: [a, b, c], chain: cleanChain(3) });
  const shuffled = evaluate({ evidence: [c, a, b], chain: cleanChain(3) });
  assert.deepEqual(forward, shuffled);
});

test("eval: decisions are ordered by decisionId, independent of input order", () => {
  const r = run([claim({ decisionId: "zeta" }), claim({ decisionId: "alpha" }), claim({ decisionId: "mid" })]);
  assert.deepEqual(r.decisions.map((d) => d.decisionId), ["alpha", "mid", "zeta"]);
});

test("eval: the latest claim for a decision wins by intrinsic timestamp, not array position", () => {
  const early = claim({ decisionId: "d1", claimedOutcome: "pending", at: "2026-02-01T00:00:00.000Z", eventId: "e1" });
  const late = claim({ decisionId: "d1", claimedOutcome: "completed", at: "2026-02-01T09:00:00.000Z", eventId: "e2" });
  const withObs = obs({ decisionId: "d1", success: true });
  const one = evaluate({ evidence: [early, late, withObs], chain: cleanChain(3) });
  const two = evaluate({ evidence: [late, early, withObs], chain: cleanChain(3) });
  assert.deepEqual(one, two);
  assert.equal(one.decisions[0].telemetryClaim?.outcome, "completed", "the later claim is the current claim");
  assert.equal(one.decisions[0].verdict, "match");
});

test("eval: same input, deep-equal output (no hidden state)", () => {
  const evidence = [claim({ decisionId: "d1" }), obs({ decisionId: "d1", success: true })];
  assert.deepEqual(
    evaluate({ evidence, chain: cleanChain(2) }),
    evaluate({ evidence, chain: cleanChain(2) }),
  );
});

/* ---- provenance / chain trust passthrough ---- */

test("eval: an observation with no matching claim is latent evidence, counted but not invented", () => {
  const r = run([obs({ decisionId: "orphan", success: true })]);
  assert.deepEqual(r.decisions, [], "no claim -> no decision row");
  assert.equal(r.provenance.observations, 1);
  assert.equal(r.provenance.claims, 0);
});

test("eval: chain trust is reported, not recomputed (evaluator is storage-unaware)", () => {
  const r = evaluate({
    evidence: [claim({ decisionId: "d1" })],
    chain: { ok: false, verifiedPrefix: 3, total: 5 },
  });
  assert.equal(r.provenance.chainOk, false);
  assert.equal(r.provenance.verifiedPrefix, 3);
  assert.equal(r.provenance.totalRecords, 5);
});

/* ---- constraint E / 4.2-4.3 boundary: NO recommendations anywhere ---- */

test("eval: the report shape names no change - no recommendation/proposal/suggestion field", () => {
  const r = run([claim({ decisionId: "d1" }), obs({ decisionId: "d1", success: false })]);
  // Words that would imply the report tells Pi what to do - that is Phase 4.3.
  // Matched at word level (camelCase / snake_case split) so a legitimate key
  // like "verifiedPrefix" is not caught by a "fix"-as-substring accident.
  const banned = new Set([
    "recommend", "recommendation", "proposal", "propose", "suggest", "suggestion",
    "remediation", "fix", "weight", "score", "rank", "prefer", "preference",
    "should", "shouldchange", "advice", "advise",
  ]);
  const words = (key: string) =>
    key.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-z]+/i).filter(Boolean).map((w) => w.toLowerCase());
  const scan = (obj: unknown, path: string): void => {
    if (obj === null || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      for (const w of words(key)) {
        assert.equal(banned.has(w), false, `report key "${path}.${key}" implies a change - that is Phase 4.3`);
      }
      scan((obj as Record<string, unknown>)[key], `${path}.${key}`);
    }
  };
  scan(r, "report");
});

/* ---- constraint A / B: pure module - no I/O, no store, no clock/random ---- */

test("eval: the module does its own I/O nowhere (no fs / store / audit import)", () => {
  const src = fs.readFileSync(new URL("../src/harness/decision-evaluation.ts", import.meta.url), "utf8");
  assert.equal(/from\s+["']node:fs["']/.test(src), false, "evaluator must not touch the filesystem");
  assert.equal(/from\s+["'].*store["']/.test(src), false, "evaluator must be storage-unaware");
  assert.equal(/from\s+["'].*audit["']/.test(src), false, "evaluator must not write or verify the audit chain");
});

test("eval: the module uses no wall clock or randomness (determinism by construction)", () => {
  const src = fs.readFileSync(new URL("../src/harness/decision-evaluation.ts", import.meta.url), "utf8");
  assert.equal(/Date\.now|new Date\(|Math\.random/.test(src), false, "no nondeterministic source in a pure evaluator");
});
