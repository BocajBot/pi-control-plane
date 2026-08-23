# Phase 4.3 — Proposal Layer Architecture Review

**Status:** APPROVED — §9 resolved, Amendments 1 & 2 incorporated. Implementation
authorized (generation-only).
**Branch:** `phase4-decision-telemetry` (continues 4.1 `d42c9df`, 4.2 `3c606f9`).
**Authorization in force:** Phase 4.3 generation-only. No applier, no approval
automation, no memory writes, no policy changes, no automatic learning.

Discipline markers: **[OBS]** verified against current source this session,
**[INF]** inference, **[REC]** recommendation, **[OPEN]** decision needing your
approval (collected in §9).

The one-line frame the whole design must protect:

```
4.1 telemetry : "what did Pi decide?"        (records)
4.2 evaluator : "did the outcome match?"     (reads, judges)
4.3 proposals : "here is a change a HUMAN could make"   (drafts, never applies)
```

4.3 turns evaluated observations into *human-reviewable drafts*. It grants Pi
no new authority. The safe version of 4.3 is almost entirely a reuse of
primitives that already exist and already enforce the boundary.

---

## 1. Purpose boundary

**A proposal system drafts change; it never enacts change.** It converts an
evaluator finding (e.g. "delegate decisions mismatch their observed outcome N
times") into a written suggestion filed where a human reviews it. That is all.

The five stages must stay physically separate — different actors, different
records, different files:

| Stage | Who | Writes what | Runtime effect |
|-------|-----|-------------|----------------|
| **observation** | coordinator (model) | `decision_telemetry` audit event | none |
| **evaluation** | `/harness-eval` (read-only) | nothing | none |
| **proposal** | `/harness-propose` (4.3) | a `proposed` record in the write-only proposal channel | **none** |
| **approval** | user / reviewer | (human judgement) | none by itself |
| **application** | user (manual) | edits `AGENTS.md` / config | changes runtime |

**Must never:**
- write anything the runtime reads (`AGENTS.md`, policy, config, scope);
- promote memory, call `authorize()`, or transition any authority state;
- treat its own output as evidence, or let the evaluator consume it (§7 G);
- record a proposal under `user` provenance — a drafted change is a *model*
  assertion until a human approves it (§4, AU2).

The gap between **proposal** and **application** is the entire safety property,
and — critically — **it already physically exists in the codebase** (§2).

---

## 2. Existing reusable primitives

Verified this session. 4.3 should be a thin generator over these, not a new
subsystem.

### Reuse — the proposal→application airgap already exists **[OBS]**
- `store.appendGuidanceProposal(file, proposal)` (`store.ts:1108`) appends a
  record to `guidance-proposals.jsonl` (`config.ts:211`, per-model dir).
- The reviewer already uses exactly this for model guidance
  (`pi-harness.ts:2842`): `{ guidance, session, proposedAt, status: "proposed" }`
  — *"model guidance is stored as a proposal, never applied"*.
- **The runtime never reads that file.** `grep modelProposalsFile` → only the
  writer. The runtime reads `AGENTS.md` (`modelAgentsFile`, read at
  `pi-harness.ts:1050` via `readModelInstructions`). **A proposal becomes
  behavior only when a human copies it from `guidance-proposals.jsonl` into
  `AGENTS.md`.** That manual bridge *is* the approval/application step, and it
  already has no applier. 4.3 rides this channel.

### Reuse — provenance & evidence
- `audit()` (`pi-harness.ts:521`) — sole append-only writer; AU2 keeps
  `actorModel` present for model events, null for `user`/`core`. Every proposal
  generation must emit an audit line so the draft is traceable.
- Evaluator output — `EvaluationReport` / `EvaluatedDecision`
  (`decision-evaluation.ts`): `verdict`, `telemetryClaim`, `observedEvidence`,
  `verdictReason`. This is the input to proposal generation.
- `ReviewProposals` categories (`agents.ts:285`) — findings / patterns /
  mistakes / userPreferences / modelSpecificGuidance / projectLessons /
  unresolvedIssues / memoryCandidates. 4.3's proposal classes should be a
  *subset* of these names, not a new taxonomy (§5).

### Reuse, do NOT bypass — the authority chokepoints
- `promote()` (`memory.ts:135`) — `PROMOTION_ACTORS = {user, reviewer}` (M1);
  reviewer promotion must cite sources (M5). 4.3 runs as a **model** actor and
  therefore *cannot* promote — which is correct. 4.3 emits memory *candidates as
  proposals*, never promotions.
- `authorize()` (`policy.ts:564`) — single monotonic verdict source. 4.3 issues
  no verdicts and consumes none; it is downstream of every decision.

### Avoid
- **A new parallel store** for proposal lifecycle. `guidance-proposals.jsonl`
  (append-only, statused) already models "proposed". [OPEN §9-2: where non-model
  proposals live.]
- **A second authority system.** Approval stays the human bridge.
- **Duplicate lifecycle tracking.** Do not track approved/applied state in 4.3
  if 4.3 has no applier (§3, §9-1).

---

## 3. State model changes

**[REC] Minimum: one durable record type, reusing the existing channel.** No new
store, no schema bump (a proposal is an opaque JSONL payload, like today's
guidance proposal — it is not an `AuditEvent` and needs no `AUDIT_EVENT_TYPES`
entry; the *audit line announcing generation* reuses an existing type, §9-4).

```
interface ImprovementProposal {
  id: string;                     // stable; also the dedup identity input
  proposalClass: ProposalClass;   // §5 — a fixed enum, subset of ReviewProposals
  text: string;                   // the human-readable suggestion (bounded length)
  evidence: {                     // provenance from observation, survives forward
    decisionIds: string[];        // the evaluated decisions this rests on
    verdict: "mismatch" | "unmeasured";
    evaluationDigest: string;     // hash of the evidence set it was drawn from
  };
  source: {                       // WHO drafted it — model, never user (AU2)
    actor: "coordinator";
    model: ModelConfiguration | null;
  };
  status: "proposed";             // the ONLY status 4.3 writes
  proposedAt: string;
  dedupKey: string;               // AMENDMENT 1: hash(proposalClass + normalized
                                  // text) ONLY — see below.
}
```

**AMENDMENT 1 (approved) — dedup identity excludes evidence.** The original
`hash(class + text + evidenceDigest)` defeats itself: `evidenceDigest` changes
every time the telemetry log grows, so the *same suggestion* regenerated later
over a bigger log gets a *new* key and appends again. Criterion E as first
written only tested idempotence over one fixed report, so it passed while the
real duplication path — identical text, fresh evidence — piled up unbounded. The
fix: `dedupKey = hash(proposalClass + normalizeText(text))` **only**. The
`evidence` block still lives in the record for provenance; it just is not part of
identity. Regeneration with fresh evidence for identical text appends nothing.
Criterion E is re-specified in §8 to test the grown-log case, not just re-runs of
one report.

**AMENDMENT 2 (approved) — staleness is a read-time render rule, not stored
state.** Pull-only + dedup limits the *rate* of new drafts but nothing marks a
draft dead, and an ever-growing unreviewed queue is where approval fatigue and
rubber-stamping begin. So wherever a human reads proposals, a proposal renders as
**stale** when either: (a) it is older than `N` days (`proposedAt` vs a
caller-supplied `now`), or (b) its evidence is superseded — a decision it cites
no longer carries the verdict it was drawn from in the *current* evaluation. This
is computed at display time by a pure `classifyStaleness(proposal, {now,
maxAgeDays, currentDecisions})` → `fresh | stale-age | stale-superseded`. It adds
**no** stored lifecycle field (no `stale`/`expired` status a model could write);
staleness is derived, never persisted.

Durable vs transient:
- **Durable:** the `proposed` record (append-only in the proposal channel) and
  the audit line announcing it. That is the whole persistent footprint.
- **Transient / not-owned-by-4.3:** approval state and application state.
  Because application = a human editing `AGENTS.md`, 4.3 stores no `approved` or
  `applied` flag — inventing one would be *duplicate lifecycle tracking* (§2
  Avoid) and, worse, a place a model could later write "approved". Whether 4.3
  ever writes an `approved` record is **[OPEN §9-1]** and, if approved, is a
  *user*-actor action, not a model one.

Evidence reference: `decisionIds` + `evaluationDigest` are the join back to the
audit chain, so a reviewer can re-derive the evaluator finding the proposal came
from. Provenance is copied forward, never re-authored.

---

## 4. Authority model

The safe default, unchanged from your statement:

| Action | coordinator (model) | reviewer | user |
|--------|:---:|:---:|:---:|
| **create** proposal | ✅ | ✅ | ✅ |
| **approve** proposal | ❌ | ⚠️ [OPEN §9-1] | ✅ |
| **reject** proposal | ❌ | ✅ | ✅ |
| **apply** proposal (edit `AGENTS.md`/config) | ❌ | ❌ | ✅ (manual) |

**[OBS]** This falls straight out of existing enforcement: a model actor is not
in `PROMOTION_ACTORS`, holds no `policy-change-*` capability in `authorize()`,
and the proposal channel has no applier. 4.3 adds no capability, so the model
*cannot* cross any of the ❌ cells even by calling every function it can reach.

**[REC]** 4.3 = **generation only**. Approval and application remain the existing
manual human bridge. The reviewer's ⚠️ is deliberately *not* extended: today the
reviewer may auto-promote **memory candidates** (cited, via `promote()`), but it
may **not** auto-apply **guidance** — guidance is stored as a proposal. 4.3 must
preserve that asymmetry: memory candidates keep their existing gated path;
everything else 4.3 emits is proposal-only. Reviewer auto-approval of 4.3
proposals would turn "reviewer approval" into "automatic authorization" — the
exact accidental violation to avoid — so it is **[OPEN §9-1]**, defaulting to
NO.

---

## 5. Proposal classes

**[REC]** A fixed enum, each a subset of `ReviewProposals` names so nothing new
is invented, and each targeting a record the runtime consumes only *after a
human edit*:

All four land as `proposed` records in the single `improvement-proposals.jsonl`
(§9-2 resolved). `model_guidance` carries a `targetModel` so a human can bridge
it into that model's `AGENTS.md`.

| Class | Suggests a change to | Applied by (human) |
|-------|----------------------|--------------------|
| `model_guidance` | a model's `AGENTS.md` (behavioral note) | edit `AGENTS.md` |
| `workflow_preference` | how work is sequenced/delegated | edit config/guidance |
| `tool_routing` | which tool/model a task class prefers | edit config/guidance |
| `memory_candidate` | a durable memory | `promote()` (user/reviewer) |

**Explicitly excluded** (a proposal in any of these classes must be *impossible
to construct*, not merely discouraged — enforced by the enum, mirroring 4.1's
`IMPORTANT_DECISION_ACTIONS` allowlist):
- capability expansion / grant
- permission or approval-policy changes
- autonomy or scope changes
- any safety/constitutional boundary (`authorize()` §1 rules, audit
  append-only, `PROMOTION_ACTORS`)

A generator that receives a finding it cannot express as one of the four allowed
classes emits **nothing** for it (the 4.1 "return null, record nothing"
pattern), rather than widening the taxonomy.

---

## 6. Lifecycle design

```
  decision telemetry (4.1, coordinator)     ← audit event, model provenance
            |                                  authority: model may record
            v
  evaluation (4.2, /harness-eval)            ← read-only, no writes
            |                                  authority: none
            v
  candidate generation (4.3, /harness-propose)  ← reads report, writes "proposed"
            |                                  authority: model may DRAFT only
            v   ─────────────  proposal→application AIRGAP  ─────────────
  human/reviewer validation                  ← human reads guidance-proposals.jsonl
            |                                  authority: USER approves (reviewer
            |                                  may reject; may promote only cited
            v                                  memory candidates via promote())
  promotion / application (manual)           ← human edits AGENTS.md / config,
            |                                  or user runs promote()
            v                                  authority: USER (M1 / authorize())
  runtime use                                ← runtime reads AGENTS.md, memory
```

Authority is required at exactly two transitions, and both already enforce it:
- **generation → validation**: nothing crosses automatically. The write-only
  channel is the barrier; no code reads a proposal into runtime.
- **validation → application**: `promote()` (M1) for memory; a human editing
  `AGENTS.md` for guidance. 4.3 touches neither.

Everything above the airgap is a model drafting; everything below is a human
acting. 4.3 lives entirely above it.

---

## 7. Migration risks

- **[OBS] Old memory system interaction.** The reviewer already auto-promotes
  cited memory candidates. If 4.3 *also* emits `memory_candidate` proposals,
  the same insight could be both auto-promoted (reviewer path) and re-proposed
  (4.3 path). Mitigation: 4.3 `memory_candidate` is proposal-only and dedups
  against existing memory content (`dedupKey`), so it never double-promotes and
  never competes with the reviewer's gated path.
- **[INF] Reviewer flow interaction.** 4.3 and the reviewer both write to
  `guidance-proposals.jsonl`. That is fine (append-only, statused), but a
  proposal must record `source.actor`/tooling so a reviewer-authored guidance
  proposal and a 4.3-authored one are distinguishable. Mitigation: the `source`
  block + a class tag.
- **[OBS] Proposal duplication.** Re-running `/harness-propose` over an
  unchanged log must not pile up identical proposals. Mitigation: `dedupKey =
  hash(class + normalized text + evidenceDigest)`; the generator is
  deterministic (same report → same proposals), and generation skips a `dedupKey`
  already present in the channel.
- **[INF] Stale evidence.** A proposal cites `decisionIds` + `evaluationDigest`.
  If later telemetry changes the picture, the old proposal is not silently
  wrong-but-active — it is a dated draft a human reads in context. Mitigation:
  `proposedAt` + evidence digest make staleness visible; 4.3 never revives or
  edits a past proposal.
- **[OBS] Feedback loops / self-confirmation (the core risk, → §8 G).** The
  danger: proposals influence runtime, runtime produces telemetry, evaluator
  scores it favorably, which generates more proposals — Pi optimizing toward its
  own suggestions. Mitigations, layered:
  1. proposals never reach runtime automatically (airgap);
  2. the evaluator does **not** read the proposal channel or `AGENTS.md` as
     evidence (verified today: evaluator reads only telemetry/delegation/review);
  3. a proposal may cite *decisions*, never another *proposal* — no proposal-to-
     proposal references, so there is no chain for 4.3 to climb;
  4. generation is a pure, idempotent function of the evaluator report — it has
     no accumulator that could ratchet.

---

## 8. Acceptance criteria

Each is a concrete test, in the discipline of 4.1/4.2 (pure-module tests +
source-scan proofs + one command byte-identical-except-proposal check).

- **A — generation ≠ application.** After `/harness-propose`, the runtime inputs
  are byte-identical: `AGENTS.md`, policy, config, session state, memory
  unchanged. The *only* new bytes are appended `proposed` records + one audit
  line. (Command-level test + `grep`: the 4.3 code path calls no writer other
  than `appendGuidanceProposal` and `audit()`.)
- **B — no proposal alters runtime without approval.** A generated proposal is
  in `guidance-proposals.jsonl`; asserting the runtime reader (`AGENTS.md` path)
  returns the same content before and after proves nothing crossed the airgap.
- **C — provenance survives observation → proposal.** A proposal's
  `evidence.decisionIds` + `evaluationDigest` resolve back to real
  `decision_telemetry` events; `source` is the model, never `user`.
- **D — rejected proposals leave no active effect.** Because 4.3 writes no
  applied state and nothing reads proposals, a rejected proposal is inert by
  construction. Test: presence of any-status proposal never changes evaluator
  output or runtime instruction bytes.
- **E — duplicates are detectable, including across a grown log (Amendment 1).**
  Not just: `generate(report)` idempotent on re-run. Also: `generate(reportₙ)` and
  `generate(reportₙ₊ₖ)` — the second drawn from a *larger* telemetry log with the
  same mismatch — produce the same `dedupKey` for identical suggestion text, so
  the second append adds nothing. Test constructs two reports differing in
  evidence size but sharing a mismatch, and asserts one net proposal.
- **F — generation cannot bypass `authorize()`.** The generator constructs only
  the four allowed classes; an excluded class is unconstructable. Source-scan:
  4.3 modules import no `authorize`/`promote`/policy/scope writer; the class enum
  contains no capability/permission/policy value.
- **G — the system cannot optimize against its own recommendations.** Two
  proofs: (1) source-scan — the evaluator imports neither the proposal module
  nor the proposal channel/`AGENTS.md`; (2) structural — a proposal's evidence
  references only `decisionId`s, and the type has no field able to reference
  another proposal, so no self-referential loop can form.

---

## 9. Decisions (RESOLVED — approved)

1. **[RESOLVED §9-1] Generation-only.** No approval/apply command in 4.3.
   Approval/application stay the manual human bridge (edit `AGENTS.md`;
   `promote()` for memory). Reviewer auto-approval of 4.3 proposals stays **OFF**.
2. **[RESOLVED §9-2] Option (a): one harness-level `improvement-proposals.jsonl`
   sibling log.** One clearly-named append-only file, no applier. **Resolution
   refinement (surfaced for review, not silent):** *all* 4.3-generated proposals
   — including `model_guidance` — land in this single log, and 4.3 never writes
   the reviewer's per-model `guidance-proposals.jsonl`. This refines §5's landing
   column and is a scope *tightening*: (i) it makes criteria A and E greppable
   and dedup a single scan (the same greppability logic that decided §9-4);
   (ii) it keeps 4.3 provenance cleanly separate from reviewer provenance (§7).
   `model_guidance` proposals carry a `targetModel` field so a human still bridges
   them into that model's `AGENTS.md` exactly as before. The file lives in the
   project state dir (`projectDir`), alongside `audit.jsonl`/`decisions`/
   `delegations`, because it is derived from this project's telemetry.
3. **[RESOLVED §9-3] Pull-only `/harness-propose`.** No auto-enqueue, no
   `agent_end` hook, no automatic learning.
4. **[RESOLVED §9-4] ADD the new audit value `proposal_created`.** Do not reuse:
   no existing type is faithful, reuse makes criterion A ungreppable, and a new
   string value needs no schema bump (eventType validated as string; established
   in 4.1). Added to `AUDIT_EVENT_TYPES`.
5. **[RESOLVED §9-5] `memory_candidate` stays proposal-only.** 4.3 performs no
   promotion, so "model-generated text becoming trusted memory" cannot occur
   through 4.3.

### Phase 4.2 follow-up (logged, OUT OF 4.3 SCOPE)
The evaluator's evidence is still entirely **Pi-authored**: telemetry,
delegation logs, and review records all originate inside the same agent process.
The §7 guards stop *proposal* loops but not *mislabeled outcomes* — a delegation
that reports "completed" while its real effect failed would be graded a match. A
future Phase 4.2 item should add **at least one evidence source outside the agent
write path** — exit codes, file diffs, or test output read directly — so the
evaluator can be contradicted by something Pi did not author. Not built in 4.3.

---

## Recommendation summary

Implement 4.3 as a **pure, deterministic proposal generator** over the
`EvaluationReport`, emitting only the four allowed non-authority classes as
`proposed` records into a single write-only harness-level
`improvement-proposals.jsonl`, announced by one `proposal_created` audit line
with model provenance — and **stop there**. `dedupKey = hash(class + normalized
text)` (Amendment 1); staleness rendered at read time (Amendment 2). No applier,
no approval automation, no promotion, no `authorize()` interaction, no evaluator
coupling. Approval and application remain the human bridge that already exists.
