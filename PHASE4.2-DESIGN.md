# Phase 4.2 — Read-Only Outcome Evaluator (Architecture Review)

**Status:** design only — no code. Awaiting approval before implementation.
**Branch:** `phase4-decision-telemetry` (continues from 4.1 @ `d42c9df`).
**Authorization in force:** Phase 4.2 only. No proposals (4.3), no memory / policy /
routing / model / authority changes, no automatic learning, no new control plane.

Telemetry (4.1) answers *"what did Pi decide?"*. The evaluator answers *"did the
observed outcome match the decision?"* — and stops there. It never answers *"what
should Pi change?"* (that is 4.3).

Discipline markers below: **[OBS]** verified against current source this session,
**[INF]** consistent-with-evidence inference, **[REC]** design recommendation.

---

## 1. Existing evidence sources and immutable boundaries

The evaluator is a fold over records that **already exist**. It opens no new store
and introduces no new event type. Three verified read seams:

### 1a. Decision telemetry — *what Pi said it decided* (self-reported)
- **[OBS]** `decision_telemetry` audit events. Payload is the bounded
  `DecisionTelemetry` at `event.metadata.decision` (`decision-telemetry.ts:69`).
- **[OBS]** Read via `store.readAudit(): JsonlReadResult<AuditEvent>`
  (`store.ts:697`), filter `eventType === "decision_telemetry"`.
- **[OBS]** Integrity via `store.verifyAudit()` / `verifyAuditChain(records)`
  (`store.ts:672`). The chain is the trust anchor.
- **[OBS]** Today only **one seam** is wired: the delegation handoff
  (`pi-harness.ts:1893`), with `decisionId = built.contract.id`,
  `outcome.status = job.status`. Telemetry is therefore **sparse** — the evaluator
  must treat thin/empty streams as normal, not as error.

### 1b. Delegate runtime — *what actually happened* (measured, not self-reported)
- **[OBS]** `DelegateRuntimeLog` (`delegate-runtime.ts:209`): `calls[]` (each with
  `allowed`, `reason`), `pendingRequests[]`, `attestationChecks`,
  `runtimeViolations[]`. Built from the tool implementations, not the child's
  account of itself — this is the ground-truth counterpart to 1a.
- **[OBS]** Its durable projection is `DelegationJobRecord` (`types.ts:522`), read
  via `store.readDelegations()` (`store.ts:720`), joinable by
  `job.contractId === decision.decisionId`. Terminal `status` ∈ {completed,
  blocked, …} plus `pendingReadRoot`.
- **[OBS]** The richer per-call detail (denials, violations) is also captured in the
  `delegation` audit event metadata (`pi-harness.ts:1849`:
  `{toolCalls, denied, reads, pendingRequests, attestationChecks}`).

### 1c. Review outcomes — *what the retrospective reviewer concluded* (measured)
- **[OBS]** `ReviewGeneration` (`types.ts:834`) with `acceptance: ReviewAcceptance`
  (`types.ts:789`): `accepted`, `reviewProduced`, `readComplete`, `shapeValid`,
  `citationsValid`, `uniformCitation`, `rejectedItems[]`. Read via
  `store.readReviewGenerations(sessionId)` (`store.ts:804`), already sorted by
  generation number (`store.ts:783`) — deterministic order.
- **[OBS]** Also surfaced as `review_complete` / `review_rejected` audit events
  (`pi-harness.ts:2850`, `2777`), metadata `{generation}`.

### Immutable boundaries (evaluator must not cross)
- **[OBS]** Audit is append-only, no amend path (AU1, `audit()` `pi-harness.ts:521`
  is the sole writer). The evaluator **does not call `audit()` at all** — it is a
  read.
- **[OBS]** `authorize()` is the single verdict source; the evaluator consumes
  recorded verdicts, never re-derives or issues one.
- **[OBS]** `promote()` + `PROMOTION_ACTORS` is the only durable-memory chokepoint;
  the evaluator never touches it.
- **[OBS]** `HARNESS_SCHEMA_VERSION = 2` (`types.ts:21`) — **no bump**; no new audit
  event type; no new file.

---

## 2. Evaluation state model

**[REC] The evaluator is stateless.** It is a pure fold over immutable evidence,
not a service and not a stored projection. There is **no "evaluation state"** to
persist, migrate, or corrupt.

```
                 (immutable, already on disk)
  audit records ─┐
  delegation jobs├─▶  evaluate(evidence)  ─▶  EvaluationReport   (returned value,
  review gens   ─┘        pure fn                                  not written)
  chain status  ─┘
```

- Input is a snapshot; output is a value. Same snapshot in → identical report out.
- No accumulator lives between runs. Re-running over the same log is idempotent and
  yields the identical report (this is testable — §4).
- **[REC]** The report is **returned to the caller and printed to the user**, not
  persisted in 4.2. Persisting an evaluation would mean either a new file (a
  parallel system — forbidden) or a new audit write (a write — outside read-only
  scope). If durable evaluations are later wanted, that is a separate, explicitly
  approved step. In 4.2 the evaluator observes; it leaves no trace.

The join model (self-reported ↔ measured):

```
decision_telemetry (1a)          measured record (1b/1c)
  decisionId  ───────── join ───► DelegationJobRecord.contractId
  outcome.status (claimed)        job.status + runtimeLog (truth)
                                  ReviewGeneration.acceptance (truth)
```

The whole point: the telemetry `outcome` is **Pi's own account**; the measured
record is **ground truth**. The evaluator compares the two. It never trusts the
telemetry's self-reported outcome as the outcome.

---

## 3. Evaluation report schema (proposed)

**[REC]** A pure data shape, in a new pure module `src/harness/decision-evaluation.ts`
(no I/O, mirroring `decision-telemetry.ts`). Deliberately **no field that names a
change** — no `recommendation`, `proposal`, `shouldChange`, `suggestedRule`. That
absence is the 4.2/4.3 boundary, and it is asserted by a test (§6-E).

```
type MatchVerdict = "match" | "mismatch" | "unmeasured";

interface EvaluatedDecision {
  decisionId: string;
  action: ImportantDecisionAction;   // reused from 4.1, not redefined
  category: string;
  rule: string;
  claimedOutcome: string;            // from telemetry (self-reported)
  measuredOutcome: string | null;    // from job/review (ground truth); null = none found
  verdict: MatchVerdict;             // pure comparison, fixed table — NOT a heuristic
  evidence: {                        // provenance, so every verdict is traceable
    telemetryEventId: string;
    delegationJobId: string | null;
    reviewGeneration: number | null;
  };
}

interface EvaluationReport {
  provenance: {
    auditEventsScanned: number;
    telemetryDecisions: number;
    chainOk: boolean;                // from verifyAuditChain — evaluator states it
    verifiedPrefix: number;          // how many records are chain-verified
  };
  decisions: EvaluatedDecision[];    // deterministic order (append order, tiebreak id)
  byAction: Record<string, {         // aggregate counts only — no scoring verb
    total: number; match: number; mismatch: number; unmeasured: number;
  }>;
  unmeasured: number;                // decisions with no ground-truth record yet
}
```

**[REC]** The match table is a small fixed mapping, e.g. for `delegate`:
- job.status `completed` **and** `runtimeViolations` empty **and** claimed
  `completed` → `match`.
- claimed `completed` but measured shows `runtimeViolations`/denied-terminal or
  `blocked` → `mismatch` (this is the honest case the evaluator exists to catch).
- no joinable job → `unmeasured` (never guessed as match).

For `review`-class decisions (once that seam is wired), `match` keys off
`acceptance.accepted` / `reviewProduced` vs the claimed outcome. The table is data,
not model judgement — no semantic entailment (§13 prohibition).

---

## 4. Determinism requirements

Same discipline as 4.1's `buildDecisionTelemetry`:
- **Pure function.** No `Date.now()`, no `Math.random()`, no `new Date()` inside the
  module. Any timestamp the report needs is passed in by the caller. (Enforced by a
  grep-style test, as 4.1 does for `fs`/`store`.)
- **No I/O in the evaluator.** The extension gathers records (existing read seams)
  and passes them in; the evaluator only computes. No `fs`, no `store` import.
- **Stable ordering.** Iterate audit records in append order (the on-disk truth);
  tiebreak by event `id`. `readReviewGenerations` is already generation-sorted;
  `readDelegations` order is append order. No dependence on filesystem enumeration
  order for anything user-visible.
- **Byte-identical output.** `deepEqual(evaluate(e), evaluate(e))` — same test shape
  as 4.1's determinism test.
- **Fixed verdict table.** No heuristic, no threshold that could drift, no floating
  scoring. `match`/`mismatch`/`unmeasured` is a total function of the inputs.

---

## 5. Failure modes and migration risks

- **[INF] Sparse telemetry (risk 1).** Only the delegation seam emits telemetry
  today. Over most logs the evaluator will find few or zero decisions. Mitigation:
  empty evidence → empty report with zero counts, **never a throw**; the report’s
  `provenance` makes the sparseness visible rather than papering over it.
- **[OBS] Broken / partial chain.** `verifyAuditChain` can report `ok:false` or a
  legacy-unverified prefix (v0.1 `prevHash: null`). Mitigation: report
  `chainOk:false` + `verifiedPrefix`, evaluate the verifiable records, and mark the
  rest — never silently drop, never silently trust.
- **[INF] Self-report ≠ truth.** The delegation seam currently **fuses** decision +
  immediate outcome into one event, and `outcome.status` is the *handoff-time* job
  status, not the later accepted/overridden result. If the evaluator read the
  telemetry `outcome` as the outcome it would grade Pi against Pi's own claim — a
  tautology. Mitigation (core of the design): the evaluator derives
  `measuredOutcome` from the **measured** record (`DelegationJobRecord` /
  `runtimeLog` / `ReviewGeneration`), and only `claimedOutcome` from telemetry.
- **[INF] Join gaps.** `decisionId` is the contract id for delegation; other seams
  (when wired in the 4.1 follow-on) will use other id spaces. The evaluator must not
  assume every telemetry row joins to a delegation job → `unmeasured`, not error.
- **[OBS] No regressions to 4.1.** 4.2 adds a read module + a print command only. It
  must not modify `decision-telemetry.ts`, the audit writer, or any type already
  shipped; suite stays green (593 + new tests).
- **[REC] Trigger.** Explicit command only (e.g. `/harness-eval`), mirroring the
  4.1 stance that adaptive behaviour is command-triggered, never on shutdown and
  never automatic. No background timer, no `agent_end` hook.

---

## 6. Acceptance criteria (must all pass before 4.2 is accepted)

- **A — Read-only, proven.** `decision-evaluation.ts` contains no `fs` write, no
  `store` import, no `audit(` call. Asserted by a source-scan test (same technique
  as 4.1's purity test). The command handler performs reads only.
- **B — Deterministic.** `deepEqual(evaluate(e), evaluate(e))`; no clock/random in
  the module (source-scan test).
- **C — Grades against ground truth, not self-report.** A fixture where telemetry
  claims `completed` but the measured `DelegationJobRecord`/`runtimeLog` shows a
  violation/denial/blocked yields `verdict: "mismatch"`. This is the discriminating
  test: it fails if the evaluator trusts the telemetry outcome.
- **D — Degrades gracefully.** Empty evidence → empty report, counts 0, no throw.
  Broken chain → `chainOk:false` + verifiable subset still evaluated and flagged.
- **E — No recommendations (4.2/4.3 boundary).** The report shape has **no** key
  that names a change (`recommendation`/`proposal`/`shouldChange`/`suggested*`);
  asserted by a shape test. No new audit event type, no schema bump (`=== 2`), no
  memory/policy/routing/model write anywhere in the diff.
- **F — Boundary holds under adversary.** Re-run a 4.1-style refuter set adapted to
  4.2: (1) evaluator grants no authority and writes nothing; (2) it never re-derives
  a verdict via `authorize()`; (3) it produces no proposal/memory/policy effect;
  (4) it reads only existing records and adds no new store/event/schema. All must
  HOLD.

---

## Recommendation

Implement `src/harness/decision-evaluation.ts` as a **pure evaluator** over the
three verified read seams (audit telemetry, delegation jobs, review generations),
returning `EvaluationReport`; add a thin, read-only `/harness-eval` command that
gathers records via existing store readers and prints the report. No writes, no new
store, no new event type, no schema bump, no recommendations.

**STOP — awaiting approval before writing any 4.2 code.**
