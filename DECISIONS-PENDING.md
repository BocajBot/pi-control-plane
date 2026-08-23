# Decisions pending — daily-usage evidence phase

Two authority-adjacent findings surfaced by the live coordinator tests
(`LIVE-COORDINATOR-TEST.md`). **Nothing here is implemented** — both are the
user's call. Recommendations only. `project.ts` and the audit path are unchanged.

---

## Decision A — scope-resolution default for projects under `$HOME`

**Observed.** `project.ts inferProjectRoot` takes the **nearest `.pi/` ancestor**
before any VCS marker. `~/.pi/agent/…` puts a `.pi` on the ancestor chain of every
project below `$HOME`, so such a project resolves its scope to `/home/bocaj`
unless it has its own `.pi/`.

**Evidence.**
- Run 2 (no project-local `.pi`): `session_start | project=/home/bocaj (pi-directory)`
- Forcing run (project-local `.pi/`): `session_start | project=…/proj (pi-directory) | marker ".pi"`

**Options.**
- **A1 — make a project-local `.git`/`.pi` outrank an ancestor `.pi` home.**
  Tight-by-default for any real project. Cost: a precedence change with blast
  radius — anyone relying on a home-level `.pi` to scope a whole tree would see
  scope narrow; needs a careful look at existing setups.
- **A2 — status quo + per-project `.pi/` discipline (doc only).** No code risk.
  Cost: the default stays loose for exactly the throwaway projects daily users
  create; safety depends on remembering to add `.pi/`.

**My recommendation:** A1. Loose-by-default under `$HOME` is the wrong default for
the daily-use population this phase targets; tight-by-default with an explicit
opt-out is the safer shape. Gate it behind a check of existing workflows first.

**Peer's view (llama-swap-44):** A should change — loose-by-default under `$HOME`
is the wrong default for daily use.

---

## Decision B — attended out-of-scope **read** denials are not audited

**Observed.** An out-of-scope read is refused (no leak) via the control-plane
`attended:read-out-of-scope` confirmation, but leaves **no event in the harness
audit chain**. Shell/tool authorization denials *are* recorded; read denials are
not — so a refused out-of-scope read is invisible to `/harness-eval` and the
retrospective reviewer.

**Evidence.** Forcing-run chain (4 events): `session_start`, `capability_block`,
`authorization | pi_harness_bash | "denied by user"`, `session_close`. The read
attempt and its refusal appear nowhere; the read was still refused and the bait
content never returned.

**Options.**
- **B1 — emit an audit event for attended read-denials.** Additive: one
  `authorization … denied` line, no authority change, so `/harness-eval` and the
  reviewer can see refused reads. Cost: small — one write on the read-confirmation
  decline path; verify it does not double-count when a read is *approved*.
- **B2 — doc-only status quo.** No change. Cost: an evidence gap persists in a
  system whose whole thesis is observable outcomes.

**My recommendation:** B1. It is additive and authority-neutral, and it closes a
real gap — an invisible denial is exactly the blind spot the evidence layer exists
to remove.

**Peer's view (llama-swap-44):** B should change — an invisible denial is an
evidence gap in a system built on observable outcomes; it is additive, one audit
line, no authority change.

---

## Recorded operational facts (for future runs)

- **The harness `audit.jsonl` flushes at session close, not incrementally.**
  Mid-session reads showed only `session_start` + `capability_block`; the full
  chain appeared after a clean `pi` exit. Grade live runs from the audit **after**
  the session closes.
- **Interactive `pi` (TUI) does not exit on `SIGTERM`** the way `--mode rpc` does;
  a clean close needed `pkill -f "pi --model …"`. Plan teardown accordingly.

---

*Recommendations only. Both A and B, whether to push, and what to drive next are
the user's decisions.*
