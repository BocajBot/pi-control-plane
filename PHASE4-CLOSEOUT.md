# Phase 4 Closeout — Adaptive Decision Layer (evidence layer)

**Date:** 2026-08-22 (overnight). **Branch:** `master` (Phase 4 work merged;
`phase4-decision-telemetry` stale at `3a66dd0`). **State:** all authorized Phase 4
work complete and committed locally. **Not pushed** — origin push is a morning
decision for the user.

Phase 4's guiding invariant held throughout: *Pi may optimize decisions inside
granted capabilities; it may not expand capabilities, bypass approval, modify
policy boundaries, or create permanent memory without approval.* Everything below
is **observation of already-authorized behavior**. No new capability, actor, or
policy was added in any commit.

The maturity statement is unchanged from the design acceptance: **the system can
now record its important decisions, evaluate whether observed outcomes matched
them (including against evidence it did not author), and draft human-reviewable
proposals — and it still has no authority to alter itself.**

---

## What shipped (commits, in order)

| Commit | Item | One line |
|--------|------|----------|
| `d42c9df` | 4.1 | Decision telemetry contract — bounded, allowlisted, tamper-evident; no reasoning traces |
| `3c606f9` | 4.2 | Read-only outcome evaluator — claim vs evidence, coverage, no recommendations |
| `3a66dd0` | 4.3 | Proposal layer (generation-only) — 4 non-authority classes, write-only channel, no applier |
| `57fe2cd` | 4.2-fu | file_diff external-evidence seam — anchor + asymmetric (refute-only) |
| `53854dc` | 4.2-fu §A | Harness-assigned run id + exit_code source (bidirectional) |
| `f6ef756` | 4.2-fu live | `command_run` decision class — makes the exit_code seam LIVE |
| `de74155` | 4.2-fu | test_output — **documented no-build** (adds nothing over exit_code) |
| `8ce0b46` | closeout | Executable pre-fix audit-fork reproduction (shown, not prose) |
| `7079cb3` | closeout | Multi-model live reviewer panel (last unshown claim) |

Build order was gated by explicit user/peer approval at each step (4.1 → 4.2 →
4.3 → external evidence → live seam). Full suite grew 579 → **667**, green at
every commit. `HARNESS_SCHEMA_VERSION` never bumped (2 throughout): every new
audit value (`decision_telemetry`, `proposal_created`, `command_run`) is a string
value, and `metadata` was already canonical.

---

## Shown vs asserted

**Shown (executable evidence, not prose):**
- Telemetry is bounded and tamper-evident: extra keys dropped, label caps,
  round-trips the hash chain, tamper breaks `verifyAuditChain` (14 tests).
- The evaluator grades against ground truth, not self-report: a telemetry
  "completed" contradicted by an aborted job / nonzero exit → mismatch, at real
  record shapes.
- **The seam is LIVE on reality**: `tests/smoke/harness-live-eval-demo.mjs` — real
  `HarnessStore`, real hash-chained audit, real child-process exit codes — yields
  the project's first externally-corroborated verdicts: a claimed success that
  really exits 0 → MATCH (`origin: externally_observed`), a deliberate false
  success that exits 1 → MISMATCH. `externallyCorroborated=2`, chain 4/4.
- Proposals never reach runtime: the channel is write-only, no applier, evaluator
  imports neither the proposal module nor the channel (no self-confirmation loop).
- Forgery barrier: every field on the exit-code join path lives on harness-written
  `shell_exec` audit events; a fabricated run id resolves to nothing (tested).
- Pre-fix audit fork now executable (`harness-audit-fork-repro.test.ts`).
- Multi-model reviewer panel: four local families exercise the evidence contract
  uniformly (VALIDATION §12).

**Asserted-not-shown remaining:** none open. (The panel closed the last one; its
own result — 0/4 accepted on citation grounding this run — is itself shown.)

**Honest dormancy (built, tested, waiting on a producer):**
- `file_diff` refutation: its edit-expectation predicate is conservatively
  `false`, because the only telemetry seam that could feed it (read-only
  delegation) is not expected to change files. Correct, not a gap.
- The exit_code seam went from dormant to **live** via `command_run`. It fires
  when the coordinator opts a `pi_harness_bash` run into recording
  (`record: true`).

---

## Documented no-builds (and when to revisit)

- **test_output source** (`de74155`, design §): for current decision classes the
  process exit code already *is* the test outcome; a results file is a weaker
  downstream artifact that cannot change the verdict. **Revisit** only when an
  attesting artifact is produced by a process the harness did **not** run (e.g.
  external CI's `junit.xml`), tagged with a harness-verifiable anchor — then it is
  a witness exit_code cannot provide.

---

## The authority expansion we deliberately did NOT make

To make the exit_code seam live, the obvious move was a command-executing delegate
class. That would grant delegates exec capability — an **authority-surface
change**, outside the standing overnight boundary. It was refused. Instead the
seam was made live by *recording an already-authorized action*: the coordinator's
own `pi_harness_bash`, under identical scope/sandbox authority, now optionally
records a `command_run` decision and stamps its `decisionId`. `policy.ts`,
`capability.ts`, `memory.ts`, and `scope.ts` were untouched across all of Phase 4.

---

## Morning decisions for the user (not made overnight)

1. **Push origin.** `master` is ahead of `origin/master` by the full Phase 4 range
   (16 commits at this closeout). Nothing was pushed. Review and push at your
   discretion.
2. **Phase 4.4 retrospective.** Deferred by standing boundary; not started.
3. **Exec-capable delegate class.** The authority expansion above. If wanted, it
   is a deliberate capability grant that only you should authorize — the seam and
   its evidence path are already built to receive it.
4. **Branch cleanup.** `phase4-decision-telemetry` is stale at `3a66dd0` (master
   is ahead); delete or keep as you prefer.
5. **Citation-gate acceptance design.** Measured N=5×4 models (VALIDATION §12
   addendum): 9/20 = 45% accepted, and the dominant rejection is a *systematic*
   artifact — models writing a "none"-class placeholder into an empty section,
   which the gate counts as an uncited item. Evidence points to a fix **upstream**
   of the gate (reviewer prompt or parser: an empty-section placeholder is not a
   citable item), not to loosening M5. No change was made — this is a design
   decision for you, with the measured table as its evidence.

---

## Closeout status

All authorized Phase 4 milestones (4.1 telemetry, 4.2 evaluator, 4.3 proposals)
and the 4.2 external-evidence follow-up (file_diff, run id + exit_code, live
`command_run`) are complete, tested (667/667), and committed locally. The last two
provisional documentation claims (executable audit-fork repro; multi-model
reviewer panel) are closed. The adaptive layer is observational and remains so by
construction.
