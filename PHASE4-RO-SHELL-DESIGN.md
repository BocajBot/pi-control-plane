# Read-only-shell default + tool classification + dialog unification — design note

Status: DESIGN (implement after this note). Authorization: the user directly
(mid-turn message) chose "Option 1 (read-only sandbox default)" and amended the
mount table to close the silent-read tradeoff. Classification + dialog-appears
are the user's verbatim words ("anything unknown, known/named and for the dialog
options to actually appear"). Local commits, NO push.

## Problem (live user pain)
In attended mode the control plane gates `pi_harness_bash` as `Risk:
unknown-tool ... Inside project root: Unavailable`, a PLAIN Yes/No with no
rationale and no "Always". So every shell command (even `wc -l`, `git status`)
prompts, every time, un-rememberable.

Two facts that shape the fix:
1. `pi_harness_bash` is **already** bwrap-sandboxed by the harness
   (`src/harness/sandbox.ts` `plan()` → `pi-harness.ts` execute): scope root is
   the only read-write mount, network off unless the scope grants it, refused if
   bwrap is unavailable. The control plane is *double-gating* an
   already-sandboxed tool, and mislabelling it "unknown".
2. `pi_harness_bash` is classified `unknown` because `SHELL_TOOLS = {"bash"}`
   only. `classifyTool` returns `unknown` for every harness-own tool.

## Three parts

### Part 1 — Classification (control plane, `tool-policy.ts`). NON-LOOSENING.
Give the harness's own tools real, named classes so `unknown-tool /
Unavailable` is reserved for genuinely foreign tools.

- `pi_harness_bash` → `shell` class. Risk label `shell`; "Inside project root"
  resolves (target = the scope root the harness runs it in, i.e. cwd/scope),
  not "Unavailable".
- Harness meta-tools (`harness_delegate`, `harness_request_scope`,
  `harness_memory_search`, `harness_note`, `harness_set_posture`,
  `harness_find_capability`) → a new named `harness` category. Risk label
  `harness-tool` with the tool NAME shown. **Decision behaviour is unchanged
  from today's `unknown` path** (confirm in attended, block in restricted /
  non-Execute phase) — only the label and the dialog change. This keeps Part 1
  non-loosening.
- `scoped_read` / `scoped_list` / `request_read_scope` / `scoped_exec` are
  delegate-CHILD tools. The isolated child never dispatches `tool_call` to the
  parent (ARCHITECTURE.md), so the control plane never sees them; no
  classification needed (documented, not wired).
- Genuinely foreign tools → keep the `unknown` class, but the confirm surfaces
  the tool NAME and its description (from `getAllTools`) instead of a bare
  "unknown-tool / rationale Unavailable".

**Invariant (enforced in code + tested): classification never turns a `block`
into an `allow`/`confirm`.** Specifically, reclassifying `pi_harness_bash` to
`shell` must not make it *newly runnable* in Restricted mode where `unknown`
blocks today. The Restricted shell branch already returns `block` when
`allowBash:false` (the default) and `confirm` when `allowBash:true`; to avoid a
silent loosening for a harness shell that Restricted previously blocked outright,
the reclassification is paired with the ro-sandbox auto-allow logic in Part 3,
which is gated on Execute+attended only. Restricted/Unattended keep today's
outcome for `pi_harness_bash`.

### Part 2 — Dialog unification (control plane, `control-plane.ts` + `rules.ts`).
Every REMAINING confirm path routes through the same three-option dialog
(`ctx.ui.custom` + SelectList) that commit 0938094 built — Yes (once) / No /
Always — showing the rule that would be saved. No confirm is plain Yes/No.

Today the 3-option dialog fires only for a resolvable-path, non-sensitive
confirm; path-less confirms (shell, harness, unknown) fall to plain
`ctx.ui.confirm`. Extend it to path-less confirms:
- shell write-mode (`pi_harness_bash mode:"write"`): "Always" rule keyed by
  tool + exact command (conservative — only the identical command is
  suppressed).
- harness meta-tool / foreign tool: "Always" rule keyed by tool + `""` target
  (tool-level: "always allow `harness_delegate`" in this scope).
- `rules.ts` `matchRule`/`addRule` already do exact tool+target+scopeRoot
  matching; an empty-string target is a valid tool-level key (matches the
  save). Sensitive reads still never rememberable (unchanged hard boundary).

### Part 3 — Read-only sandbox as the default shell mode. USER-AUTHORIZED.
`pi_harness_bash` runs read-only by default; a write needs `mode:"write"`.

**Harness (`src/harness/sandbox.ts` + `control-plane/sandbox.ts` argv builder):**
- New `mode: "read" | "write"` param on `pi_harness_bash` (default `"read"`).
- `mode:"read"` (default): scope root is `--ro-bind` (read-only). A write →
  EROFS. `buildSandboxedCommand` gains a `projectRootReadOnly` option; when set
  it emits `--ro-bind root root` instead of `--bind root root`.
- `mode:"write"`: scope root `--bind` (read-write), exactly today's behaviour.
- **Mount table excludes the sensitive-path denylist** (user amendment): the
  sensitive set (`~/.ssh`, `~/.aws`, `~/.gnupg`, `*.env`, `*.pem`, `*_rsa`,
  `credentials`, `auth.json`, secret/password …, from the sensitive-paths
  list) is always shadowed — dirs via `--tmpfs`, files via `--ro-bind
  /dev/null` — so even a broadly-configured `sandboxReadOnlyPaths` (e.g. a
  ro-bound `$HOME`) cannot expose them. Unreadable → effectively ENOENT/empty.
- **Network unshared by default** (already the case: `--unshare-all`, and
  `--share-net` only when `scope.networkGrant`). Restated as an explicit
  guarantee of read-mode.
- The mount table is the classifier — no command parsing anywhere.

**Control plane (`control-plane.ts`):**
- `pi_harness_bash` with `mode !== "write"`: **auto-allow silently** in
  Execute+attended (the ro sandbox makes mutation and sensitive-read/network
  impossible by construction), still recorded (the harness already writes the
  `shell_exec` audit with runId + exit code). Fires only when
  `bwrapAvailableCache === true`.
- `pi_harness_bash` with `mode === "write"`: route to the Part-2 three-option
  gate, scope root shown.
- **No-bwrap fallback**: when bwrap is unavailable the control plane does NOT
  auto-allow — it routes to the gate (and the harness then refuses, as today).
  Never silently allows.

**EROFS hint (harness `pi_harness_bash` execute):** when a read-mode command
exits non-zero with an EROFS / "Read-only file system" signature in stderr, the
tool result appends: "the shell ran read-only; to modify files re-run with
mode:\"write\" (that call will ask for confirmation)." No parsing decides the
mode — the OS reports the failure and the hint just explains the retry.

## Tests
- classification: `pi_harness_bash` → shell, inside-root resolves; harness meta
  tools → named `harness-tool`, not `unknown`; foreign tool still `unknown` but
  name surfaced; **non-loosening: Restricted still blocks `pi_harness_bash`**.
- dialog unification: shell write-mode confirm shows Always + saves a
  command-keyed rule that suppresses the next identical call; harness/foreign
  confirm shows Always + tool-level rule; no confirm path is plain Yes/No.
- ro-sandbox: read-mode `wc`/`grep`/`git status` auto-allow silently + audited
  (no dialog); `mode:"write"` → gate; Always on a write works; a read-mode
  write attempt → EROFS + hint, no prompt; sensitive path shadowed
  (buildSandboxedCommand emits the tmpfs/`/dev/null` shadow); net off in read
  mode; **no-bwrap → gate/refuse, never silent allow**; hard rules
  (read-before-edit, scope, sensitive) unaffected.
- full suite green.

## Boundary summary
- Classification = correctness/labelling, non-loosening (tested).
- Dialog unification = reuse of an existing user-blessed dialog on more paths;
  a confirm stays a confirm, now rememberable.
- RO-sandbox default = user-authorized (Option 1 + the two mount exclusions);
  the sandbox/mount-table is the classifier, zero command parsing; write still
  gates; the named silent-read tradeoff is closed by the sensitive-mount
  exclusion + net-off.
- Nothing here expands a capability: read-only work flows freely because it is
  provably read-only, and every mutation still passes an attended gate.
