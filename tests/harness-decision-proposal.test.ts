/**
 * Phase 4.3 - proposal layer (generation only).
 *
 * These tests hold the proposal generator to the approved contract: it drafts,
 * it never enacts. Only the four non-authority classes are constructable
 * (criterion F), dedup identity is the suggestion and not the evidence so the
 * same draft does not re-append as the log grows (criterion E / Amendment 1),
 * provenance is model-not-user (criterion C), staleness is a render-time rule
 * with no stored status (Amendment 2), and neither this module nor the
 * evaluator can form a self-referential loop (criterion G).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";

import {
  generateProposals,
  selectNewProposals,
  classifyStaleness,
  proposalDedupKey,
  validateImprovementProposal,
  PROPOSAL_CLASSES,
  MAX_PROPOSAL_TEXT_LEN,
  type ImprovementProposal,
} from "../src/harness/decision-proposal.ts";
import type { EvaluationReport, EvaluatedDecision, Verdict } from "../src/harness/decision-evaluation.ts";

function decision(over: Partial<EvaluatedDecision> & { decisionId: string; verdict: Verdict }): EvaluatedDecision {
  return {
    action: "delegate",
    category: "subagent_delegation",
    rule: "bounded_read_only_delegation",
    telemetryClaim: { source: "decision_telemetry", outcome: "completed" },
    observedEvidence: { source: "delegate_runtime", origin: "agent_authored", outcome: "aborted", refId: "job" },
    verdictReason: "reason",
    ...over,
  };
}
function report(decisions: EvaluatedDecision[]): EvaluationReport {
  return {
    provenance: { evidenceCount: 0, claims: 0, observations: 0, chainOk: true, verifiedPrefix: 0, totalRecords: 0 },
    coverage: { decisionsObserved: decisions.length, measured: 0, unmeasured: 0, unsupported: 0 },
    decisions,
    byAction: {},
  };
}
const ctx = { model: { provider: "llama-swap", model: "m" } as never, proposedAt: "2026-02-01T00:00:00.000Z" };

/* ---- generation: only mismatches, only allowed classes ---- */

test("proposal: only mismatched decisions produce proposals (match/unmeasured produce none)", () => {
  const ps = generateProposals(report([
    decision({ decisionId: "d1", verdict: "match" }),
    decision({ decisionId: "d2", verdict: "unmeasured" }),
  ]), ctx);
  assert.deepEqual(ps, []);
});

test("proposal: a mismatch produces exactly one proposal per action, in an allowed class", () => {
  const ps = generateProposals(report([
    decision({ decisionId: "d1", action: "delegate", verdict: "mismatch" }),
    decision({ decisionId: "d2", action: "delegate", verdict: "mismatch" }),
    decision({ decisionId: "d3", action: "model_select", verdict: "mismatch" }),
  ]), ctx);
  assert.equal(ps.length, 2, "one per action, not one per decision");
  for (const p of ps) assert.ok((PROPOSAL_CLASSES as readonly string[]).includes(p.proposalClass));
  const delegate = ps.find((p) => p.proposalClass === "workflow_preference");
  assert.deepEqual(delegate?.evidence.decisionIds, ["d1", "d2"], "evidence collects the mismatched decisions");
  assert.ok(ps.some((p) => p.proposalClass === "tool_routing"), "model_select maps to tool_routing");
});

test("proposal: the class enum contains no authority-expanding class (criterion F)", () => {
  const forbidden = /capab|permission|policy|scope|autonomy|grant|approv|safety/i;
  for (const c of PROPOSAL_CLASSES) assert.equal(forbidden.test(c), false, `${c} must not name authority`);
});

test("proposal: suggestion text is bounded to a suggestion, not a paragraph", () => {
  const ps = generateProposals(report([decision({ decisionId: "d1", verdict: "mismatch" })]), ctx);
  assert.ok(ps[0].text.length <= MAX_PROPOSAL_TEXT_LEN);
});

/* ---- criterion C: provenance is model, never user ---- */

test("proposal: source is the coordinator model, never the user (AU2)", () => {
  const ps = generateProposals(report([decision({ decisionId: "d1", verdict: "mismatch" })]), ctx);
  assert.equal(ps[0].source.actor, "coordinator");
  assert.deepEqual(ps[0].source.model, ctx.model);
  assert.equal(JSON.stringify(ps[0].source).includes("user"), false);
  assert.equal(ps[0].evidence.verdict, "mismatch");
  assert.equal(ps[0].id, ps[0].dedupKey, "id is the deterministic dedup identity");
});

/* ---- criterion E / Amendment 1: dedup identity excludes evidence ---- */

test("proposal: dedupKey is hash(class + text) only - independent of evidence", () => {
  const small = generateProposals(report([decision({ decisionId: "d1", action: "delegate", verdict: "mismatch" })]), ctx);
  // A LARGER log later: same action mismatched, but more (and different) evidence.
  const grown = generateProposals(report([
    decision({ decisionId: "d1", action: "delegate", verdict: "mismatch" }),
    decision({ decisionId: "d2", action: "delegate", verdict: "mismatch" }),
    decision({ decisionId: "d9", action: "delegate", verdict: "mismatch" }),
  ]), { ...ctx, proposedAt: "2026-03-01T00:00:00.000Z" });
  assert.equal(small[0].dedupKey, grown[0].dedupKey, "same suggestion => same key despite more evidence");
  assert.notDeepEqual(small[0].evidence.decisionIds, grown[0].evidence.decisionIds, "evidence did change");
  // The channel already holds the small one; regenerating over the grown log adds nothing.
  assert.deepEqual(selectNewProposals(small, grown), [], "grown-log regeneration re-appends nothing (criterion E)");
});

test("proposal: dedupKey matches the exported helper and normalizes whitespace", () => {
  const ps = generateProposals(report([decision({ decisionId: "d1", verdict: "mismatch" })]), ctx);
  assert.equal(ps[0].dedupKey, proposalDedupKey(ps[0].proposalClass, ps[0].text));
});

test("proposal: selectNewProposals also collapses duplicates within one batch", () => {
  const ps = generateProposals(report([decision({ decisionId: "d1", verdict: "mismatch" })]), ctx);
  assert.deepEqual(selectNewProposals([], [...ps, ...ps]), ps, "a repeated key in the batch is emitted once");
});

/* ---- determinism ---- */

test("proposal: generation is deterministic (same report + ctx -> deep-equal)", () => {
  const r = report([
    decision({ decisionId: "b", action: "delegate", verdict: "mismatch" }),
    decision({ decisionId: "a", action: "model_select", verdict: "mismatch" }),
  ]);
  assert.deepEqual(generateProposals(r, ctx), generateProposals(r, ctx));
});

/* ---- Amendment 2: staleness is derived at read time ---- */

test("proposal: staleness - fresh when recent and evidence still holds", () => {
  const p = generateProposals(report([decision({ decisionId: "d1", verdict: "mismatch" })]), ctx)[0];
  const s = classifyStaleness(p, {
    now: "2026-02-05T00:00:00.000Z", maxAgeDays: 14,
    currentByDecision: new Map([["d1", "mismatch"]]),
  });
  assert.equal(s, "fresh");
});

test("proposal: staleness - stale-age past the window", () => {
  const p = generateProposals(report([decision({ decisionId: "d1", verdict: "mismatch" })]), ctx)[0];
  const s = classifyStaleness(p, {
    now: "2026-03-01T00:00:00.000Z", maxAgeDays: 14,
    currentByDecision: new Map([["d1", "mismatch"]]),
  });
  assert.equal(s, "stale-age");
});

test("proposal: staleness - superseded when a cited decision no longer carries its verdict, and that wins over age", () => {
  const p = generateProposals(report([decision({ decisionId: "d1", verdict: "mismatch" })]), ctx)[0];
  // decision now evaluates to "match" - the evidence moved.
  const superseded = classifyStaleness(p, {
    now: "2026-03-01T00:00:00.000Z", maxAgeDays: 14,
    currentByDecision: new Map([["d1", "match"]]),
  });
  assert.equal(superseded, "stale-superseded", "supersession takes precedence over age");
  // also superseded if the decision has vanished from the current evaluation
  const gone = classifyStaleness(p, {
    now: "2026-02-02T00:00:00.000Z", maxAgeDays: 14, currentByDecision: new Map(),
  });
  assert.equal(gone, "stale-superseded");
});

/* ---- validation (store read-back) ---- */

test("proposal: validateImprovementProposal rejects junk and unknown classes, accepts a real one", () => {
  const good = generateProposals(report([decision({ decisionId: "d1", verdict: "mismatch" })]), ctx)[0];
  assert.notEqual(validateImprovementProposal(JSON.parse(JSON.stringify(good))), null);
  assert.equal(validateImprovementProposal(null), null);
  assert.equal(validateImprovementProposal({ id: "x" }), null);
  assert.equal(validateImprovementProposal({ ...good, proposalClass: "capability_grant" }), null, "unknown class refused");
  assert.equal(validateImprovementProposal({ ...good, evidence: undefined }), null);
});

/* ---- criterion G + purity: no authority imports; no self-referential loop ---- */

test("proposal: the module imports no authority primitive and does no I/O", () => {
  const src = fs.readFileSync(new URL("../src/harness/decision-proposal.ts", import.meta.url), "utf8");
  assert.equal(/from\s+["']node:fs["']/.test(src), false, "no filesystem");
  assert.equal(/from\s+["'].*\/store["']/.test(src), false, "no store");
  assert.equal(/from\s+["'].*\/policy["']/.test(src), false, "no authorize/policy");
  assert.equal(/from\s+["'].*\/memory["']/.test(src), false, "no promote/memory");
});

test("proposal: the evaluator does not import the proposal layer (criterion G - no loop)", () => {
  const evalSrc = fs.readFileSync(new URL("../src/harness/decision-evaluation.ts", import.meta.url), "utf8");
  assert.equal(/decision-proposal/.test(evalSrc), false, "evaluator must not read proposals as evidence");
  // and a proposal cannot reference another proposal - no such field exists.
  const p = generateProposals(report([decision({ decisionId: "d1", verdict: "mismatch" })]), ctx)[0];
  assert.equal(JSON.stringify(p).includes("proposalRef"), false);
});

/* ---- criterion A: the command writes only proposals + audit, applies nothing ---- */

test("proposal: /harness-propose writes no applier surface (AGENTS.md / policy / memory / session)", () => {
  const ext = fs.readFileSync(new URL("../extensions/pi-harness.ts", import.meta.url), "utf8");
  const start = ext.indexOf('registerCommand("harness-propose"');
  assert.ok(start > 0, "harness-propose command must exist");
  const block = ext.slice(start, start + 2000);
  // Applier CALL signatures - comments mentioning AGENTS.md/policy in prose are
  // fine; what must be absent is a call that enacts a change.
  for (const forbidden of ["writeModelInstructions", "promote(", "appendMemory", "writeReviewGeneration", "persistSession", "writeWorkstate", "writeAtomic", "appendGuidanceProposal"]) {
    assert.equal(block.includes(forbidden), false, `harness-propose must not call ${forbidden} (generation-only, criterion A)`);
  }
  assert.ok(block.includes("appendImprovementProposal"), "it does write proposals");
  assert.ok(block.includes('"proposal_created"'), "it does emit the proposal_created audit line");
});
