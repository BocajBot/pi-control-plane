# Phase 4.2 Follow-up — External-Evidence Seam (Design Note)

**Status:** APPROVED (§A/§B/§C + amendment). file_diff reader in implementation.
**Branch:** `master` (Phase 4 merged at `3a66dd0`).
**Scope:** add at least one evidence source **outside the agent write path** so
the evaluator can be contradicted by something Pi did not author. Read-only,
same discipline as 4.2/4.3.

Markers: **[OBS]** verified against source, **[INF]** inference, **[REC]**
recommendation, **[OPEN]** needs approval.

---

## Problem

**[OBS]** Every evidence source the evaluator reads today is agent-authored:
`decision_telemetry` (the coordinator wrote it), `delegate_runtime` (the harness
wrote it while running the child), `review` (a reviewer model wrote it). All three
originate inside the same process that made the decision. The §7 guards stop
*proposal* loops, but nothing stops a *mislabeled outcome*: a delegation that
reports `completed` while its real effect failed is graded a `match`, because the
only witness is the thing being judged.

The fix is one witness the agent cannot author: an **externally-observed**
signal — a process **exit code**, a **file diff**, or **test output** read
directly from where the tool/OS produced it, not from the agent's account of it.

---

## 1. Where it plugs into `EvaluationReport`

**[REC] Reuse the existing observation vocabulary; add an origin, not a parallel
pipeline.** The evaluator already joins any `DecisionObservation` to a claim by
`decisionId` and grades `claim` vs `observation.success`. An external signal is
just another observation — with a different origin and a stronger vote.

Two additive type changes (no restructure):

```
// decision-evaluation.ts
type ObservationSource =
  | "delegate_runtime" | "review"          // agent-authored (today)
  | "exit_code" | "file_diff" | "test_output";   // externally observed (new)

interface DecisionObservation {
  ...
  origin: "agent_authored" | "externally_observed";   // NEW, required
}
interface EvaluatedDecision {
  ...
  observedEvidence: { source; outcome; refId; origin } | null;   // origin surfaced
}
```

**[REC] Verdict precedence:** when a decision has both kinds, the
externally-observed observation is the authoritative one for the verdict and the
agent-authored one becomes corroboration. That precedence *is* the value: an
external witness can now flip an agent's self-reported `match` to `mismatch`. The
selection stays deterministic — latest by intrinsic `(at, id)` *within* the
authoritative origin tier — so order-independence (4.2 constraint 4) holds.

**[REC] Report additions (coverage, not new authority):**
```
coverage: { ..., externallyCorroborated: number, agentAuthoredOnly: number }
```
so a reader sees at a glance how many verdicts still rest only on Pi's own word —
the exact blind spot this seam exists to shrink. A verdict resting on
`agent_authored` only is not wrong, but it is *unconfirmed*, and the report should
say so rather than let it read as confirmed.

---

## 2. Provenance: externally-observed vs agent-authored

**[REC] Provenance is a required field on every observation, set by the reader
that produced it, and it must be unforgeable in practice — not a label the agent
picks.**

- `agent_authored`: emitted by the existing adapter from telemetry / delegation /
  review records. The agent (or harness running as the agent) wrote these.
- `externally_observed`: emitted only by a **new external-evidence reader** that
  obtains the signal from a channel the agent does not write:
  - `exit_code` — the actual process exit status captured by the harness's own
    execution wrapper (not the child's narration of "it worked");
  - `file_diff` — `git diff --stat` / status over the decision's target paths,
    read at evaluation time;
  - `test_output` — an existing test-results artifact (e.g. a JSON/TAP report on
    disk) read directly.

**[OBS/INF] The join is the hard part, and it gates which source ships first.** An
exit code or a diff has no `decisionId` on it. The seam is only trustworthy if the
link from an external signal to the decision it judges is itself not agent-forged.
Options, cheapest-first:
- **file_diff** joins most naturally: a delegation's contract already names its
  roots [OBS `DelegateRuntimeLog`/job records]. **[REC] ship this first, WITH the
  amendment below.**
- **exit_code / test_output** need a decision to carry a stable command/run id the
  external capture also records. That id must be assigned by the harness
  execution layer, not the model, or the join re-enters the agent write path.
  **[OPEN §A].**

### AMENDMENT (approved) — file_diff needs a baseline anchor + asymmetric reading

A bare "`git diff` over the roots at evaluation time" is **not** attributable to a
decision: evaluation can run long after the decision, and another session or the
user may touch the same roots in between. So (a) a nonzero diff does not prove
*this* decision produced it, and (b) there is no baseline to diff against. Two
fixes, both required:

1. **Baseline anchor, recorded by the harness — not the model.** At delegation
   start the *execution layer* records a repo-state anchor (HEAD sha) on the
   delegation job: `DelegationJobRecord.repoAnchor`. The reader diffs
   `repoAnchor .. eval-time` over the contract roots. The model never writes this
   field, so the join is not agent-forged. **If a decision predates the anchor
   field (`repoAnchor` null/absent), the reader DROPS the signal** — no diff
   against a guessed baseline (the no-faith-join rule from §3).

2. **Asymmetric interpretation.** file_diff can *refute* but not *confirm*:
   - an **empty** diff after a claimed-completed **edit-expecting** decision is a
     **strong refutation** → an authoritative `externally_observed` observation
     with `success:false`, which flips the verdict to `mismatch`;
   - a **nonzero** diff is only **weak corroboration** — it could be anyone's
     change — so the reader **emits nothing** for it. In particular file_diff must
     **never flip an agent-reported failure to `match`**; the reader only ever
     emits refutations (`success:false`), never a file_diff `success:true`.

   "Edit-expecting" is decided by a predicate the reader is given, defaulting to
   conservative **false**: today's only telemetry seam is *read-only* delegation,
   which is expected to produce no diff, so an empty diff there is correct and must
   not be refuted. The seam lights up when an edit-class decision is recorded; no
   current decision is refutable, which is the honest state, not a gap.

Provenance must survive into any downstream proposal (4.3): a proposal drawn from
an externally-corroborated mismatch is worth more than one drawn from agent-only
evidence, and the origin already travels on `observedEvidence`.

---

## 3. What it must NOT do

- **No new authority.** External evidence is read and compared; it grants nothing,
  changes no capability, policy, scope, routing, or model selection. It is
  observation, full stop.
- **Evaluator stays pure and read-only.** The `evaluate()` module keeps taking a
  normalized `Evidence[]` and importing no fs/store. All I/O lives in the new
  **external-evidence reader** (the adapter tier), exactly as 4.2 split
  storage-reading from evaluation. The reader itself only *reads*: `git diff`
  read-only, a results file read, an exit-code log read.
- **No writes anywhere.** Reading external signals must mutate nothing. In
  particular the reader **must not execute tests or commands to manufacture the
  signal** — it observes artifacts that already exist. Triggering a run would be
  the evaluator taking an action with effects, and attributing that action to an
  evaluation; out of scope and forbidden here.
- **No provenance laundering.** `externally_observed` may be set only by the
  external reader from a genuinely external channel; the agent-authored adapter
  may never stamp it, and nothing may relabel one origin as the other. If the
  join to a `decisionId` cannot be established without an agent-written key, the
  signal is dropped, not attached on faith.
- **No schema bump / no new event type required.** Adding `ObservationSource`
  values and an `origin` field is additive to in-memory evidence; it writes no new
  audit line by itself (`HARNESS_SCHEMA_VERSION` stays 2). If a future step wants
  to *record* that an external check ran, that is a separate, separately-approved
  decision.

---

## Open decisions

- **[RESOLVED §A] `file_diff` first**, with the anchor + asymmetry amendment
  above. `exit_code`/`test_output` follow once a harness-assigned run id exists.
- **[RESOLVED §B] External wins the verdict; disagreement surfaced.** The
  authoritative observation is the `externally_observed` one; `observedEvidence`
  carries `origin` and the verdict reason names the contradiction, rather than
  silently dropping the agent's claim.
- **[RESOLVED §C] Reader runs inside `/harness-eval`** (and thus feeds
  `/harness-propose`), folded in before `evaluate()` — one read-only entry point.

**APPROVED — §A/§B/§C resolved, amendment folded. Implementing file_diff reader.**
