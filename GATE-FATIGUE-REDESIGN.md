# Gate fatigue: "doors in hallways" — design pass

Status: **SPEC ONLY. Nothing here is implemented.** Written for user review.
Item 3 (plan-scoped grants) is authority-adjacent and needs explicit user
authorization before any code; the rest is correctness/UX work inside existing
boundaries but is still held for review, as asked.

User's framing: *"the pi harness has too many acceptance gates… installing doors
in hallways and needs to be reevaluated."*

---

## 1. The observed trace, mapped to code

One intent — "run `node --test` on the new backup module" — cost five approvals
(window 4, live). Each maps to a verified code site:

| # | Prompt | Layer | Site |
|---|---|---|---|
| 1 | attended write gate for `tests/backup.test.ts` | control plane | `evaluateToolCall` → `attended:mutate` |
| 2 | §21 shell gate for `pi_harness_bash` (then **refused anyway**) | harness | `authorize()` → `needs-approval`, `pi-harness.ts:1271` |
| 3 | attended gate for `harness_find_capability` (read-only lookup) | control plane | `attended:harness` (my `harness` class) |
| 4 | attended gate for `harness_delegate` | control plane | `attended:harness` |
| 5 | §21 **mutate** gate for the same `harness_delegate` call | harness | `authorize()`, `pi-harness.ts:1271` |

### Why two dialogs fire on one call (verified, not inferred)
The control plane is registered first and short-circuits **only on block**
(`ARCHITECTURE.md:1393`). On allow — including an *approved* confirm — its
handler returns `undefined`, so the event continues to the harness handler,
which runs `authorize()` and prompts **again** (`pi-harness.ts:1263-1293`).
Rows 4 and 5 are that: one tool call, two independent dialogs, both titled
"Allow harness_delegate?".

> **CORRECTION (post-implementation, 2026-08-24).** The paragraph below is
> **wrong** and is kept only so the correction is legible. `pi-harness.ts`
> defines its own `READ_TOOLS` at line 222 which **already contains**
> `harness_memory_search`, `harness_find_capability`, `harness_note` and
> `harness_request_scope`. Those tools were therefore already classified `read`
> and were never gated by §21 — verified by probe: in one session `write`
> returned `needs-approval (section 21)` while `harness_note` was allowed with
> zero prompts. I read `toolAction()` but not the input set defined 940 lines
> above it, which is exactly the "check the instrument's inputs" failure mode.
>
> Consequences: (a) the harness-side half of **P1 is a no-op** and was reverted
> rather than shipped as dead code — only a corrective comment remains; (b)
> prompt **#3** in the trace came from the **control plane's** `attended:harness`
> confirm (added in c7c573e), not from §21, so P1's real fix is entirely
> control-plane-side and is pending window 4's release of that file; (c) the
> only harness meta-tool §21 actually gates is `harness_delegate` (absent from
> `READ_TOOLS`, maps to `mutate`) — which is the gate we want to keep, so
> prompt #5 was correct behaviour.
>
> Also newly visible and **not** changed here: `harness_note` **writes** a note
> yet sits in `READ_TOOLS`, so it is ungated. Correcting that would *add* a
> gate, the opposite of this task, so it is flagged for the user rather than
> done.

### Why a read-only lookup is gated as a mutation (verified)
`toolAction()` (`pi-harness.ts:1162-1166`) is a three-way fallthrough:

```ts
if (SHELL_TOOLS.has(toolName)) return "shell";
if (READ_TOOLS.has(toolName)) return "read";
return "mutate";               // <- everything else
```

`harness_find_capability`, `harness_memory_search`, `harness_note`,
`harness_delegate`, `harness_request_scope`, `harness_set_posture` are none of
the first two, so all are `mutate`. The gate is on **mechanism** ("not a known
read tool") rather than **effect** ("does it change anything?"). The control
plane has the mirror-image gap: my `harness` category (c7c573e) names these
tools but deliberately kept the unknown-path *behaviour*, i.e. confirm.

### Why misconfiguration escalated authority (verified)
`sandboxReadOnlyPaths` defaults to `[]` (`src/harness/config.ts:247`), and
`plan()` refuses when the filtered list is empty (`src/harness/sandbox.ts:87-94`):
*"no runtime mounts are configured…"*. So `pi_harness_bash` — the **sandboxed,
scope-bounded, least-authority** path — is dead on an unconfigured instance,
while `harness_delegate` (spawns a child agent; strictly heavier authority)
still works. Misconfiguration made the heavier tool the path of least
resistance, after already spending a prompt on the refusal.

---

## 2. Proposals

### P1 — Gate on effect, not mechanism
Give the harness an explicit effect classification instead of a fallthrough,
mirroring the control-plane categories added in c7c573e.

```
HARNESS_READ_TOOLS   = harness_find_capability, harness_memory_search,
                       harness_request_scope        (WRONG - see CORRECTION 2)
HARNESS_WRITE_TOOLS  = harness_note, harness_set_posture
HARNESS_ESCALATE     = harness_delegate             (spawns an actor)
pi_harness_bash      = shell (already)
```

- `toolAction()` returns `read` for `HARNESS_READ_TOOLS` → `authorize()` takes
  the read path → **no prompt**, consistent with the standing reads-free policy.
- Control plane: `attended:harness` for a read-effect harness tool is downgraded
  to a silent allow, same shape as the existing reads-free downgrade
  (`attended:read-outside-root`) and the read-mode `pi_harness_bash` allow.
- Write-effect harness tools keep today's confirm. `harness_delegate` keeps a
  gate **and** stays in the advisor-budget path.

Non-weakening: read-effect means *this tool cannot change state or authority*.
`harness_request_scope` only records a request — Core still decides, so gating
the request buys nothing. Every tool that can mutate, spawn, or escalate keeps
its gate. Kills prompt #3.

### P2 — One door per decision
When both layers would prompt on the same call, show **one** dialog whose answer
satisfies both. Both layers still evaluate and still enforce; only the UI
dedupes.

Mechanism (least-coupling option, no shared state between the extensions — the
no-shared-state property in `ARCHITECTURE.md` stays intact):

- Introduce a per-call **confirmation token**: when the control plane obtains a
  user decision for tool call `id`, it records `{callId, decision, at}` in a
  short-lived in-memory map keyed by the tool-call id, and exposes it to the
  harness through the existing event object (`event.__cpConfirmed`) — a field
  the harness reads if present and ignores if absent, so either extension still
  works standalone.
- The harness, on reaching `needs-approval` for a call that already carries a
  user *approval* for the same `callId`, consumes it in place of prompting and
  sets `userApproved: true` in the `authorize()` input **which already exists**
  (`pi-harness.ts:1248` passes `userApproved: false` today).
- A user *denial* is never consumed this way: the control plane blocks first, so
  the harness never sees the call.

Audit (must be at least as informative as today): **two decisions, one
confirmation.** The harness still writes its `authorization` line, with the
outcome `approved by user` and an added field
`confirmation: {source: "control-plane", callId}`; the control plane still
writes its own record. A reader can see both layers evaluated and that exactly
one human answer covered both. Nothing is silently skipped — the second line
says *where* the answer came from rather than implying a second prompt occurred.

Constraint: the token is per **callId**, single-use, in-memory, and never
persisted — it cannot be replayed onto a later call.

### P3 — Plan-scoped grants (needs explicit user authorization)
Accepting a plan mints a bounded, auditable grant covering that plan's
implementation steps.

```
PlanGrant {
  id, planId,
  targets:  string[]        // explicit globs, canonicalized, inside scope root
  actions:  ("mutate"|"shell")[]
  expiresAt: ISO             // wall-clock AND
  maxCalls:  number          // a call budget, whichever binds first
  createdBy: "user"          // ONLY the user; never a model actor
  provenance: "plan-acceptance"
}
```

Rules:
- Minted **only** on a human accepting a plan (`/task accept`-style), actor
  `user`. A model actor can never mint one — this mirrors `PROMOTION_ACTORS`
  (`src/harness/memory.ts:39`, `{user, reviewer}`), and deliberately goes
  *narrower*: **user only**, no reviewer, because a grant authorizes future
  action whereas promotion records a memory.
- **Out-of-envelope calls still prompt.** A path outside `targets`, an action
  outside `actions`, or an expired/exhausted grant → today's gate, unchanged.
- **Sensitive paths are never grantable.** `isSensitiveReadTarget` and the
  policy deny patterns are checked when the grant is minted (reject the glob)
  *and* at use time (reject the call). Two checks, because a glob can start
  benign and match a later-created file.
- Read-before-edit is unaffected: a grant does not create read credit, so a
  blind edit still blocks.
- Every mint, use, expiry and rejection is audited.

Relationship to existing **Always rules** (`src/control-plane/rules.ts`):
- Always rule = *unbounded in time, one exact target, saved by the user at a
  gate*. Plan grant = *bounded in time and count, a set of targets, minted at
  plan acceptance*. They are complementary; a grant is the "many targets, short
  life" case that Always cannot express without the user answering N dialogs.
- Same matching layer, same audit vocabulary; `/harness-rules list` should show
  both, with grants rendered with their expiry and remaining budget.
- Precedence: hard rules > sensitive denylist > read-before-edit > grant/rule
  match > gate. A grant can only convert a **confirm** into an allow — never a
  block, exactly like an Always rule today.

### P4 — Misconfiguration fails helpfully, never escalates
1. **Actionable refusal.** `plan()`'s empty-mounts refusal should name the file
   it wants (`<harness-home>/config.json`), the key, and a copyable default —
   not just the key name.
2. **Do not let the refusal cost a prompt.** The mount check is configuration,
   not authority: it should run **before** the approval gate, so an
   unrunnable-by-config command is refused immediately instead of after the
   user answers a dialog (prompt #2 in the trace was spent on a call that could
   never run).
3. **Delegation must not be the cheap path.** When `pi_harness_bash` is
   unavailable *for configuration reasons* and the objective is executable
   locally, `harness_delegate` should surface the same config hint rather than
   silently becoming the way through. Recommendation: mention the disabled
   shell in the delegate refusal/consult text — no new authority, just a hint.

**Recommended `sandboxReadOnlyPaths` default** (for this window-4 instance, and
as the shipped default):

```json
{ "sandboxReadOnlyPaths": ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"] }
```

Rationale: toolchain + loader + resolver config, all read-only. **`$HOME` is
deliberately excluded** — binding it would expose credential paths that the
sandbox only shadows as defense-in-depth (`SENSITIVE_SHADOW_*` in
`src/harness/sandbox.ts`). Verify per machine that the runtime actually lives
under these prefixes (`command -v node`); a Nix/asdf/nvm install lives elsewhere
and needs its prefix added, or `node --test` still fails inside the sandbox.

---

## 3. Expected effect on the observed trace

| Prompt | After |
|---|---|
| 1 — write `tests/backup.test.ts` | stays (a real mutation), or covered by a P3 plan grant |
| 2 — §21 shell, then refused | **gone**: config refusal precedes the gate (P4) |
| 3 — `harness_find_capability` | **gone**: read effect (P1) |
| 4 — attended `harness_delegate` | stays (escalation) |
| 5 — §21 `harness_delegate` | **merged into #4** (P2) |

Five prompts → one or two, with no invariant relaxed.

## 4. Invariants explicitly preserved
- **AU1** — the harness `audit()` remains the sole writer of the hash chain. P2
  adds a field to a line the harness already writes; the control plane still
  cannot write that chain.
- **A3/SA1** — delegate authority ⊆ parent. Untouched; P1 keeps
  `harness_delegate` gated and does not alter contract building.
- **Sensitive-path denylist** — untouchable, and explicitly re-checked at both
  mint and use time in P3.
- **Fail-closed with no UI** — unchanged everywhere. A consumed token requires a
  *prior* human answer; no UI still means no approval.
- **No shared state between the two extensions** — P2 passes a per-call token on
  the event, not a shared store; each extension still functions alone.

## 5. What needs the user's authorization
- **P3 (plan-scoped grants)** — new authority-bearing object. Do not implement
  without an explicit yes.
- **P2** — changes what a single human answer covers. Behaviourally it removes a
  duplicate question about the same call, but it is a trust-surface change and
  should be confirmed.
- **P1 and P4** — correctness and messaging inside existing boundaries. P1 does
  relax *when a prompt appears* for read-effect harness tools, so it is listed
  for review rather than treated as free.

## 6. Open questions for review
1. P2: is one answer covering both layers acceptable, or should the harness
   layer keep an independent question for `shell`/`escalate` effects only?
2. P3: should a grant survive a session restart (persisted) or die with the
   session (memory-only, like the advisor budget)? Memory-only is the safer
   default and is what I would ship first.
3. P3: does a grant cover `harness_delegate`, or is spawning an actor always
   worth its own answer? I lean: never grantable.
4. P4: ship the recommended mount defaults in `defaultConfig()`, or keep
   `[]`-means-refuse and only improve the message? Shipping defaults makes the
   sandbox work out of the box; keeping `[]` keeps "no implicit filesystem
   exposure" literal.


---

## CORRECTION 2 (self-review, 2026-08-24): harness_request_scope is NOT inert

P1 above listed `harness_request_scope` as read-effect on the grounds that it
only records a request and Core decides separately. **That is false.**
`requestExpansion` (src/harness/scope.ts:270) can return `auto-granted` carrying
a **new root**, and `extensions/pi-harness.ts` then assigns `session.scope` and
calls `persistSession()`. The only limit is a one-automatic-expansion-per-scope
budget - no human is asked. The tool can widen authority by itself.

Impact: commit 5a8d194 put it in the control plane's READ_EFFECT_HARNESS_TOOLS,
silently downgrading its attended confirm - a real loosening on a scope-widening
tool, introduced by this work and caught in self-review. Removed.

Still open for the user (PRE-EXISTING, not introduced here): the same tool also
sits in the harness's own READ_TOOLS (extensions/pi-harness.ts:222), so section
21 does not gate it either. Identical anomaly class to `harness_note`, which the
user chose to gate. The same decision is needed here.
