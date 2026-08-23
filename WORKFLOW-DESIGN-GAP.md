# Dynamic workflows — gap specification

**Status:** spec only. Phase 6 territory — NOT for build until the base harness
is declared complete. Recorded so the design is not re-derived later.
**Origin:** user request 2026-08-23, spec drafted by the llama-swap-44 peer
session and committed on the user's instruction.

A dynamic workflow is deterministic orchestration: the *structure* (steps,
ordering, predicates, retries) is code; only the *work* inside each step is a
model call. Pi already has the hard parts as load-bearing primitives —
delegation contracts, A3/SA1 subset enforcement, the operator exec class,
external-evidence verdicts, blocked-surfacing, the hash-chained audit, and an
extension API for the runner to live in. What follows is only what is missing,
ordered by dependency.

---

## 1. `WorkflowRun` state contract (new record — the 12th core object)

```
WorkflowRun
- workflow_id
- script_ref + script_hash       // the run is reproducible evidence
- created_by
- parent_session
- steps[]: { id, contract_template, status, job_ref?, result_ref? }
- status
- resume_state
```

Created by explicit operation only — the task rule (T1) applied to workflows:
conversation does not spawn a workflow, a command does.

## 2. Script format + runner extension

Deterministic control flow in extension TS. A script declares steps; each step
is a delegation-contract *template* (kind: `subagent` | `operator`, scope,
capabilities, expected output shape). The runner fills templates, issues
`harness_delegate`, collects structured results, branches on step predicates.
The script is hashed and audited at workflow start.

v1 is **sequential + pipeline only**. llama-swap serializes cross-model work,
so parallel fan-out buys little on this hardware; a later `parallel` flag is
gated on steps sharing one loaded model.

## 3. Step-outcome predicate contract

Per step, how "passed" is decided — deterministic first:
- exit code via the existing external-evidence seam,
- file/artifact existence,
- output validates against the declared shape;
reviewer-graded only as fallback. Plus per-step retry policy (`n` or none) and
an on-fail action: `abort | continue | surface`.

**A step without a predicate is refused at script load.** This is the piece
that keeps workflows from being vibes-driven.

## 4. Journal + resume

Completed steps are keyed by `(step_id, filled_contract_hash)`; resume skips
matches and re-runs from the first changed step.

**Prerequisite fix:** `audit.jsonl` currently flushes at session close
(recorded operational fact, LIVE-COORDINATOR-TEST.md). The runner needs either
incremental audit flush or its own append-per-step journal file. Without this,
a crash mid-workflow loses exactly the state the feature exists to protect.

## 5. Per-step bounds (the unattended-work rule, mechanized)

Every step carries a timeout, a kill condition, and a **progress-signal
definition**; a step with no progress signal inside its window is killed as
hung, recorded as an incident, and treated by its predicate as failed. Blocked
steps use the existing blocked-surfacing path up to the main conversation.

## 6. Audit + telemetry wiring (cheap, additive)

Event values `workflow_start / step_start / step_result / workflow_end` —
string additions, no schema bump (the 4.1 precedent). Each step already lands
as a delegation / `command_run` decision, so **/harness-eval grades workflows
for free**: the workflow-level claim ("all steps passed") is judged against
externally corroborated per-step verdicts. No new machinery.

## 7. Authority placement (a decision, not code)

- Workflow envelope = the creating coordinator's envelope **at creation time,
  frozen** (T2: unattended work does not gain autonomy).
- Each step's contract ⊆ workflow envelope ⊆ coordinator — enforced by the
  existing A3 path, since steps are ordinary delegations.
- The runner cannot widen scope mid-run; a step needing more surfaces and
  waits.
- **No new actor type** — steps run as `subagent` / `operator`.
- Open question for the user at build time: may a step create another workflow
  (nesting)? Recommendation: **no in v1**.

---

## Sequencing prerequisites

1. Incremental audit flush (dependency of §4).
2. Pending decision A (scope-resolution default) — land first.
3. Pending decision B (read-denial audit) — directly improves step
   observability.

## Size estimate

§1–3 are the real work; §4–6 small; §7 is a design-doc paragraph. Comparable
to the exec-delegate effort, roughly 2×.
