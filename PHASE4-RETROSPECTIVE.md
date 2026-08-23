# Phase 4.4 — Retrospective of the Adaptive Decision Layer

**Date:** 2026-08-23. **Branch:** `master` (local; not pushed). Written and run as
the retrospective *of Phase 4, through Phase 4's own machinery* — dogfood, not
ceremony. Where the harness has a mechanism that genuinely applies (decision
telemetry, `/harness-eval`, `/harness-propose`, the reviewer evidence contract,
the exit_code external witness), this retrospective **runs it and reports what it
says**, rather than asserting a verdict by hand.

The layer's guiding invariant held from 4.1 through the exec-capable delegate:
*Pi may optimize decisions inside granted capabilities; it may not expand
capabilities beyond a subset of the coordinator's, bypass approval, modify policy
boundaries, or create permanent memory without approval.* Everything Phase 4 added
is observation of authorized behavior — with one deliberate, user-authorized
capability grant (the `operator` class) whose authority is a strict subset of the
coordinator's and whose every execution is externally witnessed.

---

## 1. The harness over its own decisions (dogfood)

`tests/smoke/harness-retro-dogfood.mjs` records Phase 4's real decision classes
(a read-only delegation, a coordinator `command_run`, an operator `command_run`)
into a real hash-chained store with **real child-process exit codes**, then runs
the exact `/harness-eval` and `/harness-propose` pipelines. Verbatim output:

```
audit chain: ok=true verified=5/5
coverage: observed=3 measured=3 unmeasured=0 unsupported=0 externallyCorroborated=2 agentAuthoredOnly=1
decisions:
  dec_… [command_run] verdict=MATCH    claim=completed evidence=exit_code/externally_observed exit 0
  dec_… [command_run] verdict=MISMATCH claim=completed evidence=exit_code/externally_observed exit 1
  dlg_… [delegate]    verdict=MATCH    claim=completed evidence=delegate_runtime/agent_authored completed
proposals generated (self-improvement, generation-only): 1
  [model_guidance] Review the "command_run" decision rule: recorded outcomes have
                   disagreed with observed evidence.  (evidence: dec_…)
```

What this demonstrates about the layer, on reality rather than by assertion:

- **It grades against ground truth, not self-report.** The operator decision
  *claimed* success; its command really exited 1; the exit_code external witness
  produced a **MISMATCH**. A layer that trusted the agent's own telemetry would
  have called it a success.
- **External evidence outranks agent-authored** (§B): both `command_run`
  decisions are `externally_observed`; the delegation, whose only witness is the
  runtime log, is `agent_authored` and counted separately
  (`externallyCorroborated=2, agentAuthoredOnly=1`).
- **It proposes improvements for itself, and only proposes.** The one mismatch
  generated one `model_guidance` proposal citing the offending decision id. The
  proposal channel is write-only; nothing was applied. That is the whole design:
  observe, evaluate, draft — never self-apply.

---

## 2. What shipped, and what the machinery says held

| Item | Commit | What the harness's own evidence says |
|------|--------|--------------------------------------|
| 4.1 decision telemetry | `d42c9df` | Bounded, allowlisted, tamper-evident; the dogfood above rides it end to end |
| 4.2 read-only evaluator | `3c606f9` | Claim-vs-evidence, coverage, no recommendations; produced every verdict above |
| 4.2-fu external evidence | `57fe2cd`…`f6ef756` | file_diff (refute-only) + exit_code (bidirectional) + `command_run` live seam |
| 4.3 proposal layer | `3a66dd0` | Generation-only; drafted the self-improvement proposal above, applied nothing |
| exec-capable `operator` | `663c5fa`,`8d83d00`,`84df956` | Sandboxed, scope-bounded exec; live externally-corroborated verdict; A3/SA1 held under adversarial test |

Standing evidence the retrospective rests on (all runnable):

- **`tests/smoke/harness-live-eval-demo.mjs`** — the coordinator's first
  externally-corroborated verdicts on real exit codes (MATCH / deliberate
  MISMATCH).
- **`tests/smoke/harness-exec-delegate-smoke.mjs`** — a delegated `operator`
  command under **real bwrap**: wrote inside its scope, was **confined** from
  writing outside it (the escaped file never appeared on the host), and yielded a
  live externally-corroborated verdict via `/harness-eval`.
- **Citation-gate acceptance, measured N=5×4 three times** (VALIDATION §12): the
  harness reviewing sessions across four local model families. The parser fix
  moved acceptance 9/20 → **17/20**, with the dominant placeholder-rejection class
  driven to **0** (the low-variance engagement signal). The residual rejections
  are the gate correctly refusing ungrounded citations — the gate keeping its
  teeth, which is the point.
- **Adversarial verification of `operator`** (6 independent skeptics): 5 invariants
  held (forgery barrier, no-exec-leak, child isolation + policy scope, refusal
  audited, A3/SA1 subset). The sixth surfaced a least-privilege *default* gap —
  not an escalation — which was fixed (an operator now requires an explicit scope;
  see `PHASE4-EXEC-DELEGATE-DESIGN.md` §9).

Full suite grew 579 → **687**, green at every commit. `HARNESS_SCHEMA_VERSION`
never bumped (2 throughout): every new audit value is a string, and the one
authorized hard-policy edit (a single `CAPABILITIES.operator` entry) added no new
schema and no new authority to any other actor.

---

## 3. Honest gaps, dormancy, and caveats (what a retrospective is for)

- **The citation gate accepts ~85%, not 100%, and that is correct.** The residual
  rejections are genuinely ungrounded citations (an id of `20`, a timestamp used
  as an entry id). Raising acceptance further would mean weakening the gate; the
  measured evidence says the parser was the honest lever and it has been pulled.
  M5 all-or-nothing was left intact by decision, not oversight.
- **file_diff refutation is dormant by construction.** Its edit-expectation
  predicate is conservatively `false` because the only telemetry seam that could
  feed it (read-only delegation) is not expected to change files. Correct, not a
  gap — and now that an `operator` *does* change files, a future edit-class that
  records a file-changing claim is the trigger to make it live (its infra and
  reader already exist).
- **`operator` inherits the parent's `networkGrant` unchanged** (equal ≤ parent,
  never wider; user-gated, default false). Consistent across all delegate kinds;
  recorded as accepted, not narrowed.
- **Recursive delegation is blocked by the child's exact tool allowlist** (D6),
  not by the SDK's nested-`session_start` behavior. The allowlist is the
  load-bearing defense; the SDK observation is only a second belt and is recorded
  as an assumption, not relied upon.
- **The proposal channel has no applier, by design.** Turning a drafted proposal
  into behavior is still a human bridge (copy into `AGENTS.md`, or a
  user/reviewer memory promotion). The retrospective's own generated proposal
  above sits in that channel unapplied — as it should.

---

## 4. The layer's own proposals for itself

The dogfood produced exactly one, citing real evidence:

> `[model_guidance]` *Review the "command_run" decision rule: recorded outcomes
> have disagreed with observed evidence.*

That is the correct shape of self-improvement here: a human-reviewable pointer at
a real disagreement (an agent's claim vs. the OS exit code), not an automatic
change. The maturity statement from the design acceptance stands, now with the
exec class inside it: **the system records its important decisions, evaluates
whether observed outcomes matched them — including against evidence it did not
author and, for an operator, against the real exit code of a sandboxed command —
and drafts human-reviewable proposals, while still having no authority to alter
itself.**

---

## 5. Closeout

All authorized Phase 4 work — 4.1 telemetry, 4.2 evaluator + external evidence,
4.3 proposals, and the user-authorized exec-capable `operator` class — is
complete, tested (687/687), adversarially verified, and committed locally. It is
observational by construction, with one strict-subset capability grant that is
externally witnessed on every use. Nothing is pushed; origin push and any branch
operations remain the user's call.
