# Exec-capable delegate class — design

**Status:** design-first, authorized. **Date:** 2026-08-23.
**Authorization of record:** the user, directly and in-session ("I authorize the
exec-capable delegate class. Design-first, then implement per the peer's
constraints."). A peer relay of the same was refused as permission-laundering and
is *not* the authorization; the user's own message is.

**Governing invariant (unchanged, must survive this class):** *Pi may optimize
decisions inside granted capabilities; it may not expand capabilities beyond a
subset of the coordinator's, bypass approval, modify policy boundaries, or create
permanent memory without approval.* A delegate's authority is strictly a **subset**
of the coordinator's (A3/SA1): it cannot exec outside its granted scope even if the
coordinator could; an out-of-scope command is refused and the refusal is audited;
sandbox/scope enforcement is unchanged; **no change to hard policy or
constitutional rules.**

The peer's constraints are adopted verbatim: exec is a scope-bounded capability
class carried on the delegation contract; every delegated execution goes through
the harness execution layer so its `shell_exec` audit line carries a
harness-minted run id + `decisionId` and the `exit_code` external-evidence seam
joins automatically; the end-to-end proof is one delegated job that runs a real
scope-bounded command and produces a live externally-corroborated verdict through
`/harness-eval`.

---

## RESOLUTION (implemented)

§1 below found that a *dedicated actor* for exec would force a `policy.ts`
change, while a correct design existed that avoided it (exec as a
coordinator-gated capability on the existing `subagent` kind). That is a
STOP-and-report point, so it was surfaced to the user, who chose the **dedicated
`operator` actor** for authority legibility and **explicitly authorized the one
minimal `policy.ts` edit** it needs: `ACTORS += "operator"` and a single
`CAPABILITIES.operator = {read, delegate, shell}` entry, which is a strict subset
of the coordinator's set (A3/SA1 holds at the matrix axis too). No
`CONSTITUTIONAL_RULES` are touched; no other actor gains anything. Everything
else in this design is implemented as written, with two corrections noted inline:
`operator` is both a `DelegateKind` and an `Actor`; and `scoped_exec` is a
child-only inline `customTool` (like `scoped_read`), so it is **not** added to
`HARNESS_TOOLS` — putting it there would wrongly hand the coordinator exec.

---

## 1. The load-bearing architecture fact (why no policy.ts change is forced)

The peer's stop-condition is: *if the design forces a hard-policy/constitutional
change, STOP and report instead of making it.* Whether it does turns on one fact,
which was **verified by direct read**, not assumed:

**The in-process isolated delegate child — the only mechanism `harness_delegate`
uses — bypasses the coordinator's `pi.on("tool_call")` / `authorize()` path
entirely.** In a nested `createAgentSession`, `session_start` is never dispatched,
so the harness's own registered handlers (which all begin `if (session === null)
return`) sit inert (comment, `extensions/pi-harness.ts:1770-1781`). The child is
built with `noTools:"all"` + an exact `tools:` allowlist + `customTools` from
`buildDelegateTools` + an isolated `ResourceLoader` (no extensions/skills/AGENTS).
As the module's own doc says: *"the enforcement boundary is the tool
implementations themselves … a child that holds only inline tools this module
wrote cannot reach the filesystem except through code that checks the scope,
because there is no other tool in its runtime to reach it with."*

Consequence: `authorize()` and the `policy.ts` `CAPABILITIES` actor-action matrix
are **not in the delegate exec code path.** The existing read-only delegate tools
(`scoped_read`, `scoped_list`, `request_read_scope`) already enforce entirely
in-closure and have **no** `CAPABILITIES` entry; an exec tool built the same way
needs none either.

Therefore **the design does not force a change to `policy.ts` or
`CONSTITUTIONAL_RULES`, and it must not make one.** Adding `"shell"` to a delegate
actor in `CAPABILITIES` would be worse than unnecessary: it would advertise a gate
that is not actually in the delegate path (a false sense of enforcement), and it
would be a discretionary hard-policy edit of exactly the kind the invariant
forbids. `policy.ts`, `capability.ts` (the actor matrix), `scope.ts`, and
`memory.ts` stay **untouched**, consistent with all of Phase 4.

The constitutional rule *"subagent authority is a subset of its parent's"*
(`policy.ts` CONSTITUTIONAL_RULES) is **honored, not edited**: enforcement is the
four in-code mechanisms below.

If implementation surfaces any pressure to edit `policy.ts`/`CONSTITUTIONAL_RULES`
after all, that is the STOP condition — halt and report rather than edit.

---

## 2. Where authority actually lives for a delegate (the four mechanisms)

1. **Contract-time capability cap** — `buildContract` intersects the requested
   capabilities with `KIND_CAPABILITIES[kind]` (`agents.ts:119-121`), and derives
   the child scope only via `narrowScope(parent.scope, …)` (`agents.ts:107-117`),
   returning `null` (refusal, rule SA3) if the requested scope escapes the parent.
   Autonomy/approvalPolicy are intersected via `inheritAutonomy` /
   `inheritApprovalPolicy`. A delegate can never be granted more than the parent
   on any axis.
2. **Exact tool surface** — the child is constructed with an exact `tools:`
   allowlist; `attestChild` / `attestCalls` (`delegate-runtime.ts:423/492`) verify
   the live active **and** registered tool set equals `contract.allowedTools` by
   **set equality** (a missing contracted tool *and* an unexpected extra tool are
   both violations) before the child runs and after every call, aborting the
   handoff and raising a "major" incident on any drift.
3. **In-closure scope check** — each tool closes over the delegate's own roots and
   checks the object actually opened (`openInScope`, fd-level, symlink/hardlink
   safe). The exec tool's analogue is `plan()` (the bubblewrap planner) invoked
   with the **delegate's** narrowed `ScopeState`.
4. **OS-level sandbox** — bubblewrap makes the delegate's scope root the only
   writable mount; network is unshared unless the scope grants it; if bwrap is
   unavailable the command is refused, never run unconfined.

The exec class adds nothing to this list; it rides all four.

---

## 3. Design decisions

- **D1 — a new, distinct `DelegateKind`, not a capability bolted onto
  `subagent`.** Add `"operator"` to `DELEGATE_KINDS`. Rationale: the shared
  `DELEGATE_TOOL_NAMES` constant is threaded into *every* delegate kind's
  allowlist; adding an exec tool to it would silently grant exec to `advisor` and
  `reviewer` (consult-only by spec). A distinct kind gets its own
  `KIND_CAPABILITIES` entry and its own tool allowlist, so exec is strictly
  additive and impossible to acquire by any existing kind. (Name: `operator` —
  a delegate that acts, vs `advisor`/`reviewer` that only report. Open to a
  different name; mechanics are identical.)

- **D2 — exec is one new inline tool, `scoped_exec`, present only for
  `operator`.** Added to `buildDelegateTools`, wrapped in the same `guarded()`
  attestation wrapper as the read tools, so `attestChild`/`attestCalls` police it
  unchanged. For non-`operator` kinds the tool is not built and not in the
  allowlist, so attestation would reject it if it ever appeared.

- **D3 — the command executes through a harness-provided, scope-bound execution
  function injected into `buildDelegateTools`; the child never touches
  `pi.exec`, `audit()`, or the store.** The isolated child has no `pi`, no
  `session`, no `store`. The extension builds an `execInScope` function **closed
  over the delegate's own `ScopeState`** (root + networkGrant), `config`, the
  bwrap probe, `pi.exec`, and the parent's `audit`/`recordDecision`, then passes
  it to `buildDelegateTools`. `scoped_exec` is a thin wrapper that calls it —
  exactly as `scoped_read` wraps `openInScope`. The scope is baked in at build
  time; the child can pass only a command string and cannot widen scope. This
  keeps the **parent as the sole writer to the hash-chained store** (invariant
  AU1) while the *decision to run* is the delegate's.

- **D4 — run id and decisionId are minted harness-side, never from model input.**
  Inside `execInScope`: `runId = makeId("run")`, `decisionId = makeId("decision")`.
  The delegate's model supplies only the command string and an `expect_success`
  flag; it cannot forge either id, so the `exit_code` join stays trustworthy for a
  delegate's `shell_exec` lines exactly as it is for the coordinator's.

- **D5 — the claim is recorded before the exit code is known (non-tautological).**
  `execInScope` records the `command_run` decision (`claimedOutcome` =
  `expect_success ? "completed" : "failed"`, default completed) **before**
  `pi.exec` returns, then writes the `shell_exec` execution record with the
  measured `{runId, exitCode, decisionId}`. The claim is the delegate's asserted
  intent; the exit code is the independent OS witness. Both are attributed to the
  **delegate actor** (`operator`), never relabeled `coordinator`, so provenance in
  the evidence adapter stays honest.

- **D6 — the `exit_code` seam joins with zero reader-side change.**
  `external-evidence.ts`, `decision-evaluation-adapter.ts`, and
  `decision-evaluation.ts` read audit *events*, not actor identity; a delegate's
  `command_run` claim + `shell_exec` record with a matching `decisionId` produce a
  live `externally_observed` verdict through the existing pipeline. No evaluator or
  adapter edit.

---

## 4. Contract / type changes (additive, no schema bump)

- `types.ts`: `DELEGATE_KINDS` gains `"operator"` (the exhaustive
  `Record<DelegateKind, …>` `KIND_CAPABILITIES` then forces its entry — a
  compile-time guarantee no kind is missed).
- `delegate-runtime.ts` `DelegateRuntimeContract`: add an **exec scope** the
  closure can plan against. Today it carries only `readRoots` + `maxBytes`; add
  the delegate's `ScopeState` (or the minimal `{ root, networkGrant }`) so
  `plan()` runs against the delegate's own root, **never** the parent's. Built
  strictly from `built.contract.scope` (already a parent-subset via `narrowScope`).
- No new audit event type; `shell_exec` and `decision_telemetry` (value
  `command_run`, already in `IMPORTANT_DECISION_ACTIONS`) are reused verbatim.
  `HARNESS_SCHEMA_VERSION` stays **2**.

---

## 5. Enforcement & invariants (each with its test)

| # | Invariant | Enforced at | Test |
|---|-----------|-------------|------|
| E1 | A delegate's exec scope ⊆ parent's; contract refused if wider | `buildContract`/`narrowScope`; `execInScope` plans against the delegate scope | adversarial: coordinator holds a wide scope, `operator` granted a narrow sub-root; a command touching a sibling path is refused |
| E2 | An out-of-scope / bwrap-unavailable command is **refused and the refusal is audited** | `execInScope` mirrors `pi_harness_bash:1406-1408` (`audit(operator, …, "shell_exec", cmd, "refused: …")`) | a command with cwd/target outside the delegate root → refused + a `shell_exec` "refused" audit line attributed to `operator` |
| E3 | `scoped_exec` exists **only** for `operator`; any drift aborts the handoff | kind-conditional allowlist + `attestChild`/`attestCalls` set-equality | `advisor`/`reviewer`/`subagent` delegation never carries `scoped_exec`; an injected extra/missing exec tool trips attestation |
| E4 | run id / decisionId are harness-minted, not model-supplied | `makeId` inside `execInScope` | a delegate that puts a `runId`/`decisionId` in its params cannot influence the joined record |
| E5 | The OS sandbox binds the **delegate's** root as sole writable mount | `plan(cmd, delegateScope, config, delegateScope.root, probe)` | the planned mounts' `readWrite` equals the delegate root, not the parent's |
| E6 | Single writer: the child never writes to the store | `execInScope` is parent-side; child has no store handle | boundary grep: no store/audit import reaches the child tool closures |
| E7 | End-to-end: a delegated scope-bounded command yields a live `externally_observed` verdict | full pipeline | see §6 |

Plus the **unchanged** delegate invariants that must keep passing: A3/SA5
(`harness-adversarial.test.ts:75` — a delegate cannot boot looser than its
parent), SA1 (`:123`), scope symlink safety (`harness-scope.test.ts`), append-only
job lifecycle (`harness-delegation-jobs.test.ts`), and the read-tool attestation
suite.

---

## 6. End-to-end proof (the deliverable)

A smoke/integration test (`tests/smoke/harness-exec-delegate-smoke.mjs`, plus a
unit-level `tests/harness-exec-delegate.test.ts`) that, against a real
`HarnessStore` and real hash-chained audit:

1. Coordinator delegates an `operator` job scoped to a temp project root, objective
   "run the build check", granting `scoped_exec`.
2. The `operator` child calls `scoped_exec("<a real command that exits 0>",
   expect_success=true)`. `execInScope` plans the sandbox against the delegate
   root, mints `runId`+`decisionId`, records the `command_run` claim
   (`completed`), runs it, writes the `shell_exec` record `{runId, exitCode:0,
   decisionId}` as actor `operator`.
3. `/harness-eval` (`evaluateCurrent`) reads the audit, `toEvidence` builds the
   claim, `extractExecutionRecords`+`readExitCodeEvidence` join by `decisionId`,
   `prefersObs` picks the external witness → **verdict `match`,
   `origin: externally_observed`, `coverage.externallyCorroborated` incremented.**
4. The negative twin: a command that exits non-zero with `expect_success=true` →
   **`mismatch`** (the delegate's false success caught by the OS exit code).
5. An out-of-scope command → **refused + audited**, no execution record, no verdict
   (E2).

This is the first *delegated* externally-corroborated verdict; the coordinator
already produced the non-delegated version (`harness-live-eval-demo.mjs`).

---

## 7. Files touched (exhaustive, from the subsystem map)

- `src/harness/types.ts` — `DELEGATE_KINDS += "operator"`; `DelegateRuntimeContract`
  gains exec scope (in `delegate-runtime.ts`).
- `src/harness/agents.ts` — `KIND_CAPABILITIES` gains the `operator` entry (with a
  `scoped_exec` capability string); `renderContractPrompt` boundary line
  ("You may not modify files…") made **conditional on kind** so an `operator` is
  not told it cannot act while granted exec.
- `src/harness/delegate-runtime.ts` — `scoped_exec` added to `buildDelegateTools`
  (guarded); `DelegateRuntimeContract` exec-scope field; the injected exec
  dependency parameter.
- `extensions/pi-harness.ts` — `execInScope` builder (closed over delegate scope,
  config, probe, `pi.exec`, `audit`, `recordDecision`); kind-conditional tool
  allowlist (do **not** append to shared `DELEGATE_TOOL_NAMES`); allow `operator`
  at the two `kind` gates (`:905` marker adoption, `:1642` `harness_delegate`
  request); telemetry action/category for `operator` (`:1972`).
- `src/harness/capability.ts` — **untouched.** Correction to the map: `scoped_exec`
  is a child-only inline `customTool` (like `scoped_read`), never registered via
  `pi.registerTool` and never routed through `classifyTool` (the isolated child
  bypasses that gate). It is therefore **not** in `HARNESS_TOOLS`; adding it there
  would classify it `harness` for the *coordinator* too and hand the coordinator
  an exec tool it should not have. `harness-capability.test.ts:120` only covers
  `pi.registerTool` tools, so it neither requires nor forbids `scoped_exec`.
- `src/harness/policy.ts` — the user-authorized minimal edit (see RESOLUTION):
  `CAPABILITIES.operator = {read, delegate, shell}` (⊆ coordinator). No
  `CONSTITUTIONAL_RULES`, no `authorize()` ordering, no other actor changed.
- **Untouched: `scope.ts`, `memory.ts` (operator is absent from
  `PROMOTION_ACTORS`, so it cannot promote memory), and `CONSTITUTIONAL_RULES`.**

The places a new tool name must appear together (or `attestChild` trips):
`KIND_CAPABILITIES[operator]`, the `operator` tool allowlist (`delegateToolNames`),
and the `buildDelegateTools` returned array (gated on the injected exec runtime).

---

## 8. Explicit STOP conditions (halt and report, do not edit)

- Any need to add an action to `policy.ts` `CAPABILITIES` or to write
  `CONSTITUTIONAL_RULES` — the §1 finding says this is not required; if it becomes
  required, the premise changed and this must be re-authorized.
- Any need to give the delegate a writable/exec mount **wider** than its own
  narrowed scope root (E5) — that is an authority leak, not a subset.
- Any need for the child to hold a store/audit handle directly (breaks AU1 single
  writer / the "nothing else to reach with" isolation).

Nothing in the design above requires any of these; they are tripwires for
implementation.
