/**
 * Pi Harness - Phase 4.3 proposal layer (generation only).
 *
 * Phase 4.2 answers "did the outcome match the decision?". Phase 4.3 turns a
 * mismatch into a *human-reviewable draft*:
 *
 *     4.3 proposals : "here is a change a HUMAN could make"
 *
 * and enacts nothing. This module is the pure generator. It reads an
 * `EvaluationReport` and emits `ImprovementProposal` records; a separate command
 * (4.3's `/harness-propose`) appends them to a single write-only
 * `improvement-proposals.jsonl` and announces each with one `proposal_created`
 * audit line. The runtime never reads that file - a proposal becomes behavior
 * only when a human copies it into `AGENTS.md`, edits config, or runs
 * `promote()`. See PHASE4.3-DESIGN.md.
 *
 * Enforced by construction, so no call site can forget it:
 *
 *  1. Generation only. This module writes nothing, grants nothing, and imports
 *     no authority primitive (no `authorize`, no `promote`, no store, no fs). A
 *     proposal is drafted by a model actor and is a *model assertion* until a
 *     human approves it - `source.actor` is the coordinator, never `user`.
 *
 *  2. A fixed, non-authority class enum. A proposal can only ever be one of four
 *     classes (model guidance, workflow preference, tool routing, memory
 *     candidate). Capability/permission/policy/scope/safety changes are not in
 *     the enum, so a proposal that would expand authority is unconstructable -
 *     the same allowlist discipline as 4.1's important-decision actions.
 *
 *  3. Dedup identity is the *suggestion*, not the evidence (Amendment 1).
 *     `dedupKey = hash(class + normalized text)`. The evidence block is kept for
 *     provenance but is NOT part of identity, so the same suggestion regenerated
 *     later over a larger telemetry log produces the same key and appends
 *     nothing. Text is a stable template per pattern (no counts, no ids), so it
 *     does not drift as the log grows.
 *
 * Pure: no I/O, no clock, no randomness. `sha256` is pure computation. The
 * caller supplies the model provenance and the timestamp.
 */

import { sha256 } from "./util.ts";
import { HARNESS_SCHEMA_VERSION, type ModelConfiguration } from "./types.ts";
import type { EvaluationReport } from "./decision-evaluation.ts";

/**
 * The allowed proposal classes. This enum IS the authority boundary: it holds
 * only suggestions a human applies by editing guidance/config/memory, never
 * anything that changes a capability, permission, policy, scope, or safety
 * boundary. A finding that cannot be expressed as one of these produces no
 * proposal (the 4.1 "return nothing" pattern) rather than widening the set.
 */
export const PROPOSAL_CLASSES = [
  "model_guidance",
  "workflow_preference",
  "tool_routing",
  "memory_candidate",
] as const;
export type ProposalClass = (typeof PROPOSAL_CLASSES)[number];

/** Caps a suggestion to a suggestion - not a paragraph of reasoning. */
export const MAX_PROPOSAL_TEXT_LEN = 200;

export interface ImprovementProposal {
  schemaVersion: number;
  /** Stable identity; equals `dedupKey` so the same suggestion is one id. */
  id: string;
  proposalClass: ProposalClass;
  /** The human-readable suggestion. A stable template per pattern - carries no
   * counts or ids (those live in `evidence`), so it does not drift as the log
   * grows. */
  text: string;
  /** For `model_guidance`, which model the note concerns (so a human bridges it
   * into the right `AGENTS.md`); null for classes that are not model-specific. */
  targetModel: string | null;
  evidence: {
    decisionIds: string[];
    verdict: "mismatch" | "unmeasured";
    /** Coarse hash of the evaluation this was drawn from - provenance, not
     * identity (Amendment 1). */
    evaluationDigest: string;
  };
  source: {
    /** A draft is a MODEL assertion until a human approves it (AU2). Never
     * "user". */
    actor: "coordinator";
    model: ModelConfiguration | null;
  };
  status: "proposed";
  proposedAt: string;
  /** hash(proposalClass + normalized text) ONLY - see module header + Amendment 1. */
  dedupKey: string;
}

export interface ProposalContext {
  /** The coordinator model drafting the proposals (provenance). */
  model: ModelConfiguration | null;
  /** Timestamp supplied by the caller so the module stays pure. */
  proposedAt: string;
}

/** Which class a mismatched action maps to. A fixed table; an action with no
 * mapping falls back to the most conservative class (a behavioral note). */
function classForAction(action: string): ProposalClass {
  switch (action) {
    case "delegate":
    case "consult":
      return "workflow_preference";
    case "model_select":
    case "route":
      return "tool_routing";
    case "memory_write":
      return "memory_candidate";
    default:
      return "model_guidance";
  }
}

/** A stable suggestion per action pattern. Deliberately free of counts/ids so
 * the dedup key does not change as evidence accumulates (Amendment 1). */
function textForAction(action: string): string {
  const base = `Review the "${action}" decision rule: recorded outcomes have disagreed with observed evidence.`;
  return base.length > MAX_PROPOSAL_TEXT_LEN ? base.slice(0, MAX_PROPOSAL_TEXT_LEN) : base;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Dedup identity: class + normalized text ONLY (Amendment 1). Exported so the
 * command and tests compute it the one way. */
export function proposalDedupKey(proposalClass: ProposalClass, text: string): string {
  return sha256(`${proposalClass}\n${normalizeText(text)}`);
}

function evaluationDigest(report: EvaluationReport): string {
  const pairs = report.decisions
    .map((d) => `${d.decisionId}=${d.verdict}`)
    .sort()
    .join(";");
  return sha256(pairs);
}

/**
 * Generate proposals from an evaluation report.
 *
 * One proposal per action class that has at least one mismatch. Evidence is the
 * set of mismatched decisions for that action; the text is a stable per-action
 * template. Unmeasured/unsupported decisions produce nothing - only an observed
 * disagreement is actionable. Pure and deterministic: same report + context ->
 * deep-equal proposals.
 */
export function generateProposals(report: EvaluationReport, ctx: ProposalContext): ImprovementProposal[] {
  const digest = evaluationDigest(report);
  // Group mismatched decision ids by action, in a deterministic order.
  const byAction = new Map<string, string[]>();
  for (const d of report.decisions) {
    if (d.verdict !== "mismatch") continue;
    const ids = byAction.get(d.action) ?? [];
    ids.push(d.decisionId);
    byAction.set(d.action, ids);
  }

  const proposals: ImprovementProposal[] = [];
  for (const action of [...byAction.keys()].sort()) {
    const decisionIds = [...(byAction.get(action) as string[])].sort();
    const proposalClass = classForAction(action);
    const text = textForAction(action);
    const dedupKey = proposalDedupKey(proposalClass, text);
    proposals.push({
      schemaVersion: HARNESS_SCHEMA_VERSION,
      id: dedupKey,
      proposalClass,
      text,
      // Model-specific guidance would name a model; today's report has no such
      // seam wired, so this stays null. The field exists so a human can route a
      // model_guidance draft, not so the model can name a target.
      targetModel: null,
      evidence: { decisionIds, verdict: "mismatch", evaluationDigest: digest },
      source: { actor: "coordinator", model: ctx.model },
      status: "proposed",
      proposedAt: ctx.proposedAt,
      dedupKey,
    });
  }
  return proposals;
}

/**
 * From a freshly generated batch, keep only proposals whose `dedupKey` is not
 * already present in the channel (and collapse duplicates within the batch).
 * This is the cross-run / grown-log dedup (criterion E, Amendment 1): identical
 * suggestion text yields an identical key regardless of how much evidence has
 * since accumulated, so nothing re-appends.
 */
export function selectNewProposals(
  existing: readonly ImprovementProposal[],
  generated: readonly ImprovementProposal[],
): ImprovementProposal[] {
  const seen = new Set(existing.map((p) => p.dedupKey));
  const out: ImprovementProposal[] = [];
  for (const p of generated) {
    if (seen.has(p.dedupKey)) continue;
    seen.add(p.dedupKey);
    out.push(p);
  }
  return out;
}

export type Staleness = "fresh" | "stale-age" | "stale-superseded";

export interface StalenessContext {
  /** Caller-supplied "now" (ISO) so the rule is pure. */
  now: string;
  maxAgeDays: number;
  /** The current evaluation's verdict per decision id. A proposal is superseded
   * when a decision it cited no longer carries the verdict it was drawn from. */
  currentByDecision: ReadonlyMap<string, string>;
}

/**
 * Render-time staleness (Amendment 2). Adds NO stored status - it is derived
 * whenever a human reads proposals. Supersession takes precedence over age: an
 * out-of-date draft is more useful to flag as "the evidence moved" than merely
 * "old".
 */
export function classifyStaleness(proposal: ImprovementProposal, ctx: StalenessContext): Staleness {
  const superseded = proposal.evidence.decisionIds.some(
    (id) => ctx.currentByDecision.get(id) !== proposal.evidence.verdict,
  );
  if (superseded) return "stale-superseded";
  const ageMs = Date.parse(ctx.now) - Date.parse(proposal.proposedAt);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (Number.isFinite(ageDays) && ageDays > ctx.maxAgeDays) return "stale-age";
  return "fresh";
}

/** Defensive read-back validator for the store (a hand-edited or legacy line
 * could carry anything). Returns null for anything that is not a well-formed
 * proposal of a known class. */
export function validateImprovementProposal(value: unknown): ImprovementProposal | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.text !== "string" || typeof v.dedupKey !== "string") return null;
  if (!(PROPOSAL_CLASSES as readonly string[]).includes(v.proposalClass as string)) return null;
  const evidence = v.evidence as Record<string, unknown> | undefined;
  if (evidence === undefined || !Array.isArray(evidence.decisionIds)) return null;
  return value as ImprovementProposal;
}
