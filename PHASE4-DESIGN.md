# Phase 4 — Architecture Review + Design Delta (v0.3.2 foundation)

**Status: design only. No code changed.** Per the Phase 4 First Task. Nothing
here is implemented; this document is for acceptance before any slice is built.

Compatibility anchor: **`HARNESS_SCHEMA_VERSION = 2`** (not the package string,
which lags). The MVP must not bump it.

Evidence base: a 6-area read-only architecture review of v0.3.2 (decision
points, audit/records/store, memory-proposal flow, review queue, immutable
boundaries, state/lifecycle) plus a cross-area consistency check. Citations
below are `file:line` seen in the frozen tree.

---

## Executive finding

The decision→consequence spine Phase 4 needs **already exists**. The coordinator
already chooses execute / delegate / consult / ask / defer; the harness already
records state changes in a tamper-evident hash chain; a proposal channel that is
*written but never auto-applied* already exists; the retrospective closeout
pipeline is ~90% built. Phase 4 is therefore a **thin, mostly read-only layer**:
record the decision that is already being made, evaluate it against outcomes
that are already measured, and emit a preference **proposal** through the
existing no-applier channel. The dominant risk is not missing capability — it is
**building parallel systems** beside the ones that already enforce the
boundaries.

---

## The five First-Task questions

### Q1 — Where should decision telemetry live?

**Observation.** Every state-changing decision already flows through one
append-only, hash-chained sink: `audit()` (`extensions/pi-harness.ts:520`) →
`appendAudit` → chain + endpoint tip written under a global lock
(`src/harness/store.ts:619`). `AuditEvent.metadata` is `CANONICAL_FIELDS #11`
(`src/harness/audit.ts:200`) and is copied verbatim into the hashed payload
(`audit.ts:85`). The `tool_call` handler already emits an event carrying
`{rule}` at the allow branch (`pi-harness.ts:1187`). Reads are deliberately
**not** audited (`pi-harness.ts:1186`).

**Inference.** Telemetry belongs *inside the metadata of the existing event*,
not in a new file and not as a new top-level `AuditEvent` field. A new top-level
field forces a `CANONICAL_FIELDS` edit + a `HARNESS_SCHEMA_VERSION` bump and
breaks cross-version `verifyAuditChain` (`audit.ts:184-202`). A separate
`decision-telemetry.jsonl` rides no hash chain — it would be *less*
tamper-evident than the events it describes. (The cross-check flagged a direct
conflict here between three proposed substrates; metadata-on-existing-event is
the only one that is both tamper-evident and readable back for cross-session
evaluation.)

**Recommendation.** Enrich the metadata of the existing non-read `tool_call`
audit events with a `decision` sub-object. Free tamper-evidence, correct
provenance, zero new files, zero new event types, **no schema bump**.

### Q2 — What existing contracts can support learning?

**Observation / Recommendation — reuse, do not duplicate:**
- `authorize()` (`src/harness/policy.ts:564`) — the single verdict source
  (allow / needs-approval / deny), ordered strictly-stricter. Phase 4 is a
  **downstream consumer** only.
- `audit()` + hash chain + `metadata` slot — the telemetry substrate (Q1).
- `appendGuidanceProposal` + the `{content, session, proposedAt,
  status:"proposed"}` shape (`store.ts:1108`, used at `pi-harness.ts:2797`) —
  the existing "written as a proposal, **no applier**" channel. This is the home
  for Phase 4 preference proposals.
- `checkReviewEvidence()` + the `ReviewProposals` envelope
  (`src/harness/agents.ts:694`) — the citation / complete-read / shape gate.
- `DelegateRuntimeLog` (`src/harness/delegate-runtime.ts:209`) — the **measured**
  (not self-reported) record of what a delegate actually did; the outcome signal.
- `before_agent_start` additive `systemPrompt` append (`pi-harness.ts:1060`,
  no-op when empty) — the one advisory prompt-injection seam (for the later
  Milestone 4.3, not the MVP).
- `classifyPostureChange` / `postureAction` (`policy.ts:729/760`) — the
  mechanical tighten/loosen classifier, if Phase 4 ever self-adjusts posture
  (tighten-only for the coordinator).
- `promote()` + `PROMOTION_ACTORS{user,reviewer}` (`src/harness/memory.ts:135/39`)
  — the sole durable-memory chokepoint.
- Persistence primitives: `appendJsonl` / `writeAtomic` / `withFileLock` /
  `versionedRecord<T>` (`store.ts`) — never hand-roll I/O.

### Q3 — Which boundaries must remain immutable?

Consolidated register (each is a testable invariant; all verified in-source):

1. **Authorize monotonicity + deny-by-default.** No Phase 4 path yields `allow`
   where `authorize()` says needs-approval/deny; unknown actor/action/policy →
   deny (`policy.ts:564/579-581/674`, enforced `pi-harness.ts:1182/1194/1227`).
   Telemetry is emitted **after** the verdict, never instead of it.
2. **No trust flag** (A2). Capabilities key on actor only; no
   `confidence`/`trusted`/`adaptive` flag that `authorize()` reads to widen a
   verdict (`policy.ts:134`).
3. **Posture-loosen always needs the user**, even under `approvalPolicy:"none"`
   (`policy.ts:650`). Coordinator may self-**tighten** only. A model switch
   changes only `coordinator`; scope/autonomy/approvalPolicy stay byte-identical
   (`state.ts:193-199`).
4. **Durable memory = {user, reviewer} only** (M1), no override param
   (`memory.ts:39/100`). Session notes never become durable (`state.ts:104-111`).
5. **M4 non-deletion / M5 citation / §32 scope integrity** for memory
   (`memory.ts:154/262/166`).
6. **AU1 append-only hash chain** — corrections are new events, never amends
   (`audit.ts:98`); `verifyAuditChain().ok` stays true; audit-rewrite denied for
   all actors (`policy.ts:570`).
7. **AU2 provenance** — a Pi self-optimization event is recorded under a **model
   actor** (coordinator/subagent), never `user` (`audit.ts:73-80`).
8. **Telemetry lives in the hashed `metadata` slot**, never a new top-level
   field (Q1).
9. **No-UI ⇒ fail closed** on needs-approval (`pi-harness.ts:1195/1134`);
   corrupt soft-policy ⇒ force approval (`policy.ts:618`).
10. **Delegate isolation** — strict scope subset, capability exception refused
    (SA5), attestation before/after/per-call, unparseable marker → read-only
    floor (`agents.ts:107`; `delegate-runtime.ts:233`; `pi-harness.ts:1122/1707`).
11. **Model guidance is stored as a proposal and never auto-applied** — session
    load reads only `AGENTS.md` (`pi-harness.ts:1023`); guidance-proposals have
    **no applier**. Phase 4 proposals inherit this.
12. **Recovery integrity (R3/R4)** — `lastVerifiedState` is harness-observed
    only; `canContinue` true only when no conflicts (`state.ts:167-178`). Phase 4
    hints/decisions must never feed `resumeFrom` or flip `canContinue`.
13. **Config is a closed set** — unknown keys → default; a new path field needs
    explicit `knownKeys` + schema discipline (`config.ts:275`).

### Q4 — What is the smallest Phase 4 MVP?

A single vertical slice proving **record → evaluate → propose (never
auto-apply)**, reusing only existing chokepoints, touching no authority boundary:

- **RECORD** — at the `tool_call` allow branch (`pi-harness.ts:1182`), right
  after `authorize()` (`:1166`), add a `decision` sub-object
  `{chosen, verdict, rule, lightweightContext}` to the metadata of the event
  already emitted at `:1187`, via the existing `audit()` helper. Non-read only
  (respect `:1186`). Tamper-evident and provenance-correct for free; no new
  file, no new event type, no schema bump.
- **EVALUATE** — a **new pure, read-only aggregator** that reads those
  decision-bearing audit events back for the session (mirroring
  `readDecisions().filter(d=>d.session===id)` at `pi-harness.ts:567`), optionally
  joined with the measured `DelegateRuntimeLog` outcome surfaced at the
  `harness_delegate` post-run handoff (`pi-harness.ts:1863`). Writes nothing
  durable; mutates no `SessionState`.
- **PROPOSE** — write the candidate preference via `appendGuidanceProposal`
  (`store.ts:1108`) with `status:"proposed"`. **Not** routed to `promote()`/M1,
  **not** `memory.jsonl`, **not** `AGENTS.md`, **not** any policy file. The
  channel has no applier, so it is *structurally* never auto-applied.

### Q5 — What acceptance tests prove the MVP works?

1. **Recorded & tamper-evident, no schema break.** After a non-read tool call,
   the `tool_call` event's `metadata.decision` carries `{chosen, verdict, rule}`;
   `verifyAuditChain().ok === true`; `HARNESS_SCHEMA_VERSION` still 2 and a v2
   reader verifies the line; a **read** call produces no decision metadata.
2. **Verdict unchanged under A/B ablation (monotonicity).** For a scripted mix
   of allow/needs-approval/deny calls, the `authorize()` verdict and block/allow
   outcome are byte-identical layer-on vs layer-off. *Establish the layer-off
   baseline first and report it before asserting layer-on.*
3. **Proposal never auto-applied.** After evaluate, exactly one
   `status:"proposed"` record lands in guidance-proposals; `memory.jsonl` has no
   new entry; `AGENTS.md` byte-unchanged; no policy file written; session load
   still reads only `AGENTS.md`. Static check: no code path reads-and-applies
   the proposal.
4. **No durable memory without approval (M1).** Aggregator runs as a
   coordinator/advisor actor; `promote('coordinator', validDraft).ok === false`
   still holds; static check that the Phase 4 path never calls `appendMemory`
   directly nor `promote()` with an actor outside {user, reviewer}.
5. **Single tamper-evident write path.** MVP creates no new decision/telemetry
   `*.jsonl` and opens no second writer to `auditFile`; grep confirms no bespoke
   chain/tip was added.
6. **Provenance correct (AU2).** Every decision-metadata event has a model actor
   with `actorModel` populated; none recorded under `user`.
7. **Evaluation read-only & reproducible.** Aggregator calls no
   `persistSession`/`checkpoint`, never writes `lastVerifiedState`/`resumeFrom`,
   never flips `canContinue`; re-running it over the same append-only logs yields
   the identical proposal.

---

## Proposed architecture delta

```
 tool_call handler (pi-harness.ts:1099)
    authorize() ── verdict ─────────────► [UNCHANGED authority path]
        │ (allow branch :1182)
        ▼
    audit(...] event :1187  ──enrich──►  metadata.decision {chosen,verdict,rule,ctx}   ◄── RECORD (only new write)
                                                    │  (hash-chained, no schema bump)
 ── session end / on demand ────────────────────────┼──────────────────────────────────
    NEW pure aggregator  ◄── reads audit events (decision metadata) + DelegateRuntimeLog
        │  (read-only, no SessionState mutation)
        ▼
    appendGuidanceProposal(status:"proposed")  ──►  guidance-proposals.jsonl   ◄── PROPOSE (no applier)
        │
        ▼
    [human or reviewer flow commits later]  ── deferred to Milestone 4.3/4.4, OUT of MVP
```

Net-new code is small and confined: (1) the metadata enrichment at one seam;
(2) one pure read-only aggregator function; (3) a proposal-shaping call. No new
tool, no new store surface beyond an optional typed reader, no `authorize()`
change, no new authority object.

## State model changes

- **None to `SessionState`.** The MVP does not add session state, does not
  checkpoint, does not touch `lastVerifiedState`/`resumeFrom`/`canContinue`.
- **No new persistent file.** Telemetry rides the existing `metadata` slot; the
  proposal rides the existing guidance-proposals file.
- **New type shape only (data, not plumbing):** a `DecisionContext` sub-object
  embedded in `metadata` (free-form today, so additive) and reuse of the
  existing guidance-proposal record shape. No `HARNESS_SCHEMA_VERSION` bump.

## Migration risks

- **Low, by construction** — nothing changes on-disk formats; a v2 reader reads
  new lines unchanged (new keys live inside the already-free-form `metadata`).
- **The real risk is duplication, not migration.** Elevated hotspots:
  1. A parallel decision log outside the hash chain (the tempting `decisionLogFile`) — forbidden; use `metadata`.
  2. A shadow scoring path that decides execute/delegate *before* `authorize()` — becomes a second, looser policy. Phase 4 sits **downstream** only.
  3. A private "learned preferences" store bypassing `promote()`/the proposal channel — durable memory without approval.
  4. A second prompt-injection hook or a second posture classifier competing with the existing single writers.
  5. **Overlap with `control-plane.ts`** — it already owns `/mode` + `/verify` + an `agent_end` phase machine (`registerCommand` ~1683/1738, `agent_end` ~1222), loads first, and short-circuits on block. A Phase 4 "operating-posture/verification" layer must be checked against it before adding any phase state.
- **One nuance to respect:** reviewer memory *auto-commits* the moment
  `checkReviewEvidence` passes (`pi-harness.ts:2758-2788`) — the "approval" is a
  human invoking `/harness-review run`, not a per-item decision. Phase 4 learned
  preferences must therefore stay on the **propose** side (no-applier channel)
  and must **not** be routed through the reviewer auto-commit path to claim M1
  compliance.

## Scope: what the MVP is NOT

Deferred to later milestones (and explicitly out of the MVP): the
`before_agent_start` advisory block that surfaces committed guidance (4.3);
adaptive model/tool routing (4.3); the additional retrospective extraction
categories — repeated friction, missing capabilities, automation candidates
(4.4, the pipeline itself is already built). None of §13's prohibitions are
approached: no self-modification of capabilities, no bypass of approval, no new
durable memory without approval.

## Open decisions for acceptance

1. **MVP boundary:** ship RECORD alone first (safest, one seam), or the full
   RECORD→EVALUATE→PROPOSE slice? Recommendation: full slice — it is what proves
   the Phase 4 concept end-to-end, and each step is independently boundary-safe.
2. **`decision` metadata shape:** minimal `{chosen, verdict, rule}` vs. adding a
   small `context` (task-type tag, whether a delegate/consult was offered).
   Recommendation: include a bounded `context` so EVALUATE has signal, capped to
   avoid bloating the hashed payload.
3. **Aggregator trigger:** on `session_shutdown` (beside the existing review
   queue) vs. an explicit `/harness-*` command. Recommendation: explicit command
   for the MVP (keeps close-path latency untouched, §25).

**Awaiting acceptance before implementing any slice.**
