# Pi Control Plane

A control-plane extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono). It makes visible — and actually enforces — things that are normally invisible while an agent works:

1. **What the model can see** (context files, skills, tools, system prompt, token usage) — `/context`
2. **What the model is allowed to do right now** (one merged setting: Plan / Manual / Accept / Auto) — `/mode`

The central rule: **you can inspect and correct Pi's context before Pi is permitted to modify anything.** Enforcement is real — a mode that would only change a label is treated as a bug.

## Installation

```bash
pi install ~/Documents/pi-control-plane
```

This adds the package to `~/.pi/agent/settings.json` (`packages` list). Nothing else is changed. To uninstall:

```bash
pi remove ../../Documents/pi-control-plane   # the path as shown by: pi list
```

A backup of `settings.json` from before the first install exists at `~/.pi/agent/settings.json.bak.pre-control-plane-<timestamp>`.

## Default behavior

A genuinely fresh session (no prior control-plane state) opens **edit-ready**:

| Setting | Default | Meaning |
|---|---|---|
| Mode | **Accept** | Edits inside the project root apply without a confirm from turn one; out-of-root writes, shell, and unknown tools still confirm |

The fail-closed path is separate: if a saved session's state exists but cannot be trusted (malformed, unknown schema), restoration falls back to **Plan** (read-only) — a corrupted session never silently gains edit power. If the policy file fails to load, Auto mode enforces read-only rather than permitting more.

The default footer keeps directory, permissions and usage visible:

```text
cwd /work/pi-control-plane
Accept                                  model-name
Context ~12.0% · OpenRouter $20.00 · Δ −$0.0021
```

Full directory and permission mode stay visible. Model appears when space permits.
Invalid policy and context pressure appear only when relevant. Attention text
wraps on narrow terminals. Model aligns right when space permits. Enabled
sandbox, edited context and active extension statuses remain visible;
`LSP Inactive` moves to details. Native Pi tool progress and approval dialogs
are unchanged.

Use `/control-ui details` for full path, branch, session name, model/effort,
sent/received tokens, cache usage, cost, context counts, live draft counters,
and the workload timer (`time 4m 12s · 9 turns`).
Use `/control-ui minimal` to return; `/control-ui timing` shows the workload ledger: the last turn (time to first text +
total), cumulative model time across turns (count, total, average, slowest), and recent turn durations — the time the
model spends working between prompts. The ledger is persisted as its own
session entry, so a resumed session keeps its totals. This display preference lasts for this
extension instance; it changes no permissions or model settings.

Context warnings begin at 75%, urgent at 90%. Exact counts describe the last
request; estimates retain `~` and an explicit label. Detailed draft counts are
estimates (about four characters per token); added context uses the prospective
count when available, then the last request, then Pi's estimate. Unknown counts
remain unknown. `/context`, `/mode` and `/effort` retain their controls.

See [TUI design](docs/TUI.md) for hierarchy, disclosure and state examples.

## Commands

### `/context` — what does the model actually see?

- `/context` — redacted summary: provider, model, token usage, message counts, context files, skills, prompt templates, active tools, system-prompt hash, provider-payload hash. Values the extension cannot observe print as `Unavailable`, never guessed.
- `/context diff` — what changed since the last `/context` or `/context full` (sources, tools, skills, model, tokens, hashes). The first run establishes the baseline.
- `/context full` — detailed view including the redacted system prompt (size-limited, truncation marked). Prints a warning first: redaction is pattern-based and cannot guarantee every secret is caught.
- `/context sources` — every prompt source with its toggle status: `enabled`, `disabled`, or `not toggleable`.
- `/context restore` — remove the `alt+e` context override (see the context editor section below).
- `/context recount` — re-count the last provider request with the model's own tokenizer (via llama-swap) and compare against pi's estimate. The same count feeds the footer's context segment automatically after every request.

The exact count also drives context-fullness warnings: a warning notification at 75% of the window and an error-level one at 90%, each fired once until usage drops back below 75% (e.g. after `/compact`). This matters because pi's built-in auto-compaction watches its own estimate, which can be off by a large margin (46% observed) — the control plane warns from the accurate number so you can `/compact` before the window actually overflows.
- `/context profile [name]` — tool profiles: named loadouts that enable exactly the listed tools and toggle everything else off (big context savings when many extensions are installed — e.g. `minimal` cut 19 of 26 tools in testing). No argument lists profiles and marks the active one; `all` re-enables everything *except* `policy/profiles.json`'s `alwaysDisabledTools` (see below) — `all` has never meant "literally every tool, no matter what" since that field was added. Ships with `minimal` (core coding + web search and URL fetch) and `reading` (read tools, including web search and URL fetch). Define your own in `policy/profiles.json` — or just ask pi to "create a context profile for X": the bundled `create-context-profile` skill walks it through the schema, validation, and `/reload`. Applied profiles persist with the session like any toggle.
- **`alwaysDisabledTools`** (`policy/profiles.json`, top-level, alongside `profiles`/`defaultProfile`): tools forced off every time *any* profile is applied — including `all` — regardless of which one. This is not another profile; it is a hard denylist layered on top of whichever allowlist a profile computes, specifically for when two installed extensions do the same job and you want exactly one of them reachable no matter which profile gets picked later. Ships with `["web_search"]`: `pi-web-access`, if installed, registers a tool of that exact name, and this package's own `local_web_search` (see below) is the local/free alternative — both being active at once means the model has to guess between two tools for one job, and Pi's tool registry has no picker to help it the way command-name collisions get one (see the `local_web_search` section for why that matters). A tool individually re-enabled afterward with `/context toggle tool:<name>` stays that way for the session — this only guards *bulk* profile application, never a deliberate single-tool override. Restored sessions are never touched by it; only fresh ones.
- `/context toggle <name>` — turn a source on or off for subsequent turns:
  - `tool:<name>` — genuinely removed from the model's tool list.
  - `file:<path>` — the file's content is excised from the system prompt each turn, **with verification**. If the excision cannot be verified, the toggle is reverted and you are warned — a source is never shown as disabled while it still reaches the provider.
  - `skill:<name>` — same verified-excision approach for the skills section.
  - `template:<name>` — not toggleable (Pi provides no honest way to exclude these); shown for visibility only.

When context usage passes 75%, `/context` reminds you that Pi's built-in `/compact` summarizes old context and `/new` starts a fresh session. The control plane does not reimplement compaction.

### `/scratchpad` — structured working notes that survive `/compact`

- `/scratchpad` — list current notes (id, timestamp, text).
- `/scratchpad add <text>` — add a note.
- `/scratchpad remove <id>` — remove one note.
- `/scratchpad clear` — remove all notes (asks to confirm; `force` skips the dialog).

Persisted as its own session entry, the same way control-plane state is: excluded from LLM context, untouched by `/compact` (which only summarizes messages), and injected into the system prompt every turn so the model can actually see and use its own notes across a compaction that would otherwise have wiped that context. The control plane never writes, edits, or summarizes a note's text itself — it only stores what it is told and shows back what is there.

### `/mode` — what is the model allowed to do right now?

One merged setting (workflow stage and permissions used to be two separate settings — `/phase` and `/autonomy` — which allowed contradictory combos like Execute + Read-only; they are now one). Four modes, and `alt+p` / `shift+tab` cycle them in this order:

- `plan` — read-only. Every mutating tool blocked; reads (`read`, `grep`, `find`, `ls`, …) allowed under the sensitive-path denylist. Shell is blocked entirely — commands are never parsed to guess whether they are "safe" (pattern-level command filtering proved unreliable in practice; whole-tool denial is reliable). Plan doubles as the verification stage: read-only, framed for checking the work.
- `manual` — changes allowed, **attended**: reads inside the project run freely; anything risky (writes, edits, shell, unknown tools, reads outside the project root) pops a confirmation dialog showing the tool, risk category, target/command, and whether it is inside the project root. Denying blocks the call. If no confirmation UI exists (e.g. print mode), risky calls are blocked — never silently allowed.
- `accept` — execute + accept-edits: edits inside the project root apply without a confirm; everything else (out-of-root writes, shell, unknown tools) still confirms.
- `auto` — full autonomy, no confirmations: only protected credential-pattern paths (`.env`, `.ssh`, `.aws`, etc. — `policy/default-policy.json`) are blocked; shell, unknown tools, and out-of-root targets run. If the policy file is missing or invalid, enforcement falls back to read-only. Every *allowed* mutating/shell call is logged as a diagnostic entry for later review (`alt+i`). See `docs/SECURITY.md` for the full reasoning.

Old names keep working as aliases, never escalating permissions: `discuss`/`verify` → `plan`; `execute`/`execute-attended`/`attended`/`restricted`/`execute-restricted` → `manual`; `execute-auto`/`accept-edits`/`auto-accept` → `accept`; `unattended`/`execute-unattended` → `auto`. `sandboxed` degrades to the safest mode (`plan`) and prints: *"This mode provides Pi-level policy restrictions, not operating-system isolation. It is not a security sandbox."* The status bar never displays "Sandboxed". See `docs/SECURITY.md` for why this distinction matters.

Sessions saved before the vocabulary collapsed restore safely: a legacy combination that has no direct mode (execute + restricted, execute + read-only) coerces to the safe read-only **Plan** — never to an edit mode (Execute + restricted restores as Plan, not Manual).

### `/bwrap` — real OS-level isolation for `bash`, independent of `/mode`

`/mode auto` is Pi-level policy only — no OS isolation, by its own admission. `/bwrap` is the actual OS-level isolation: when on, every `bash` call that `/mode`'s policy layer already allowed (or a human already confirmed) is additionally wrapped in [bubblewrap](https://github.com/containers/bubblewrap) — unprivileged Linux user namespaces — before it runs. The two are independent and stack: `/mode manual` (per-command confirmation) + `/bwrap on` (kernel-enforced containment of whatever gets confirmed) is a reasonable combination, not a redundant one.

- `/bwrap` / `/bwrap status` — show whether the sandbox is on, whether networking is shared, and whether the `bwrap` binary is actually on `PATH`.
- `/bwrap on` — enable. Refuses (with an error, not a silent no-op) if `bwrap` is not installed.
- `/bwrap off` — disable (default).
- `/bwrap network on` / `/bwrap network off` — allow or unshare networking for sandboxed commands (default off, same "safe by default" posture as everything else in this package).

What the sandbox binds, every time, freshly resolved per call (see `sandboxOptionsFor` in `extensions/control-plane.ts`):

- The project root — read-write. This is the entire point: code the agent may still modify.
- Standard system directories (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, `/opt`) and `$HOME` — read-only, so interpreters, package managers, and toolchains under `$HOME` (nvm, cargo, a user pip install, …) resolve normally.
- Credential paths from `policy/default-policy.json` (`denyPathSubstrings`, `denyPathBasenames`) — blanked inside `$HOME` (empty `tmpfs` over directories, `/dev/null` over files) so `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.pi/agent`, `~/.docker/config.json`, and friends are unreadable from inside the sandbox even though the rest of `$HOME` is bound in. This deliberately reuses the *same* deny list the `read`/`edit`/`write` tools already enforce rather than maintaining a second one that could drift — see `docs/SECURITY.md` for what this reuse does and does not cover (basename patterns like a stray `.env` are only shadowed at `$HOME`'s top level, not everywhere on disk).

Fails closed: if the sandbox is on and `bwrap` disappears from `PATH` mid-session, the `bash` call is blocked with an explicit reason rather than silently running unsandboxed.

## Hotkeys

| Key | Action |
|---|---|
| `alt+c` | Toggle a context-preview widget above the editor |
| `alt+e` | Open the session context in **nvim** to view and edit it |
| `alt+s` | **Send preview**: everything the next message will send — system prompt (with the auto-appended control-plane block shown read-only), full history, and your unsent draft — in nvim, editable |
| `alt+t` | Tool-profile picker: modal with profile names in a left column (1/5 width) and, on the right, the selected profile's description over its tool list. ↑/↓ or j/k select, **enter** applies for this session only, **space** also saves it as the default for new sessions (written to `policy/profiles.json` as `defaultProfile`), esc closes; `*` marks the active profile, `(default)` the default one |
| `alt+p` | Cycle mode: Plan → Manual → Accept → Auto |
| `shift+tab` | Same cycle as `alt+p` (Claude-Code-style) |
| `alt+m` | Model picker: typeahead with ↑↓ move, **PgUp/PgDn page**, enter select, esc close (also `/models`; `/models <query>` switches directly) |
| `alt+i` | Diagnostics panel: a centered modal listing this session's diagnostic entries (declined reads, unattended action logs, verification events) |
| `alt+h` | Hotkey cheat sheet as a centered modal (any key closes; `/hotkeys` lists everything) |

`alt+s` is `alt+e` plus two things: lines prefixed `#> ` show the control-plane state block exactly as it will be appended to the system prompt (read-only — edits to them are ignored), and a `DRAFT` section holds your unsent message — editing it rewrites the input box on save. Context edits behave identically to `alt+e` (override, `Context edited`, `/context restore`).

### The context editor (`alt+e`)

`alt+e` suspends the TUI and opens the current session context — the system prompt plus every message the model would receive — in nvim (falls back to vim). Each message sits under a marker line; edit the text, delete whole message sections to remove them, `:wq` to apply, `:q!` to cancel.

- Edits become an **override for future turns in this session**: the model sees your edited history instead of the original. The session file is never rewritten — the chat scrollback still shows what really happened.
- Tool calls, tool results, thinking, and images appear as `[non-text: …]` placeholders and are preserved exactly; only text is editable. (Deleting one half of a tool call/result pair can make the provider reject the request — if that happens, `alt+e` again or restore.)
- `/context restore` removes the override. The footer shows `Context edited` while one is active.
- The override lives in memory only: it does not survive quitting, `/reload`, or compaction (compaction invalidates it with a notification, since the conversation no longer lines up).
- Malformed edits (broken markers, missing system-prompt section) are rejected whole — nothing half-applies.

**shift+tab:** Pi's default binding for `shift+tab` is cycling the thinking level; that default is unbound in `~/.pi/agent/keybindings.json` (`"app.thinking.cycle": []`) so this extension can claim the key for the mode cycle. Thinking level is set with `/effort` instead.

## Model picker (`alt+m` / `/models`)

A typeahead model picker built entirely on public extension APIs — the isolated replacement for the retired `bin/patch-pi-model-page-nav.mjs`, which patched minified anchors inside pi's bundle and broke on every `pi update`. Paged navigation (PageUp/PageDown jump 15 models — the exact feature the patch existed for) is implemented via `SelectList.setSelectedIndex`, so it survives updates by construction.

- `alt+m` or `/models` — the picker, on demand. Type to filter (substring), ↑↓ move, PgUp/PgDn page, enter selects, esc closes.
- At interactive startup the picker also appears (frecency-ordered: most-used-recently first, local models leading while history is cold, usage tracked in `~/.pi/agent/model-usage.json`); esc at launch quits pi — no model chosen, no session. Disable the startup dialog with `"modelPicker": false` in `~/.pi/agent/settings.json` (usage tracking continues either way).
- `/models <query>` (any mode, incl. RPC/print) — switch directly; exact `provider/model` wins, then unique substring match; ambiguous queries list their matches instead of guessing.
- `pi.setModel` switches; pi itself persists the switched-to model as the default for new sessions.

The native `/model` selector remains untouched and unpatched.

## Web search (`local_web_search` tool)

Registered directly by this package (no separate extension needed): searches the user's local searxng instance rather than a paid API. Classified as a read tool — available in every mode, never gated behind an execute stage, since it never mutates anything. Targets `http://127.0.0.1:8888` by default; override with the `PI_CONTROL_PLANE_SEARXNG_URL` environment variable if searxng runs elsewhere. If `typebox` (the parameter-schema library) is not resolvable in the current environment, the tool is silently not registered rather than failing extension load — same fallback pattern already used for the Pi SDK imports themselves.

**Named `local_web_search`, not the more obvious `web_search`:** if you also have `pi-web-access` (or any other extension shipping a tool literally named `web_search`) installed, Pi's tool registry is a flat last-registered-wins map — there is no collision error and no picker the way colliding *command* names get one. A same-named tool from an extension that loads later in `packages` (`~/.pi/agent/settings.json`) would silently and completely replace this one; the model would never see it again, with no warning anywhere. Check `pi list` and grep for `registerTool` in anything else you install before assuming a new tool this package adds is actually reaching the model.

## Web access (`fetch_content` / `get_search_content` / `source_check`)

pi-web-access's non-search tools provide what `local_web_search` deliberately does not: URL reading. `fetch_content` turns URLs (web pages, GitHub repos/PRs/issues, YouTube, PDFs) into readable markdown or text; `get_search_content` retrieves cached search results; `source_check` verifies sourcing. All three are classified as **read tools** in `tool-policy.ts` — available in every mode, never confirmation-gated, because they write nothing. `minimal` and `reading` ship with `local_web_search` + `fetch_content` enabled; the other two stay off by default (enable with `/context toggle tool:source_check` or a custom profile).

One nuance the classification covers: `fetch_content` also accepts **local files** (a video or image path to analyze). A scheme-less `url` (or a `file://` one) is treated as a filesystem path target, so those reads go through the same canonicalization and credential-deny checks as the `read` tool — `fetch_content` with `url: ~/.env` is blocked in Auto exactly like `read` would be. Scheme-qualified remote URLs are not filesystem paths and get no path checks — fetching a remote page is the whole point.

## Example workflow

```text
/context
/mode plan
/mode manual
...
/mode plan
```

Note: the mode controls what *tools* may do. It does not change the model or its thinking level. `plan` is both the planning and the verification stage.

## What each file does

| File | What it is |
|---|---|
| `extensions/control-plane.ts` | The extension entry point Pi loads. Pure wiring: registers commands, hotkeys, event hooks. The logic lives in `src/`. |
| `src/control-plane/types.ts` | Shared type definitions and constants (modes, state shape). |
| `src/control-plane/state.ts` | Safe defaults, validation, and restoration of saved state. A corrupted restore falls back to Plan + Read-only; a genuinely fresh session opens edit-ready as Accept. |
| `src/control-plane/tool-policy.ts` | The authorization engine: tool classification, path canonicalization, and the allow/confirm/block decision. |
| `src/control-plane/redaction.ts` | Pattern-based secret redaction applied before any context is displayed or hashed. |
| `src/control-plane/context-snapshot.ts` | Builds the content-free context snapshot (names, counts, hashes — never raw content). |
| `src/control-plane/context-diff.ts` | Compares two snapshots for `/context diff`. |
| `src/control-plane/toggles.ts` | Verified excision of toggled-off sources from the system prompt. |
| `src/control-plane/scratchpad.ts` | Structured working notes: validation, persistence/restoration, and rendering. Same patterns as `state.ts`, applied to its own entry type. |
| `src/control-plane/sandbox.ts` | Bwrap command-line assembly and its own persisted on/off + network toggle. Pure: builds a command string, never spawns anything itself. Same patterns as `state.ts`/`scratchpad.ts`. |
| `src/control-plane/model-picker.ts` | Pure model-picker logic: frecency ordering, usage IO, substring filtering, page-jump math, key classification. Wiring (SelectList modal, startup handler, `/models`, `alt+m`) lives in `extensions/model-picker.ts`. |
| `src/control-plane/turn-timing.ts` | Workload timing ledger: per-turn records (TTFT + total), cumulative totals, strict validation, compaction-safe restoration, footer and summary rendering. |
| `src/control-plane/websearch.ts` | Pure searxng client (injected fetch): URL building, response parsing, result formatting. No Pi imports. |
| `src/control-plane/commands.ts` | Argument parsing for every command (so bad input handling is testable). |
| `src/control-plane/ui.ts` | All text formatting: status line, summaries, denial messages, the injected state block. |
| `policy/default-policy.json` | Auto (unattended) policy rules: denied path names/substrings, whether bash is allowed (default: no), out-of-root allowlist prefixes (default: none). Also the credential-path source of truth `/bwrap`'s `$HOME` shadowing reuses. Edit carefully — an invalid or old-schema file makes Auto enforce read-only. |
| `tests/` | 301 unit and harness tests. Run with `npm test`. |
| `docs/` | Architecture, security model, and testing guides. |
| `IMPLEMENTATION-PROMPT.md` | The specification the first milestone was built from. Milestone 2 (unattended autonomy, web search, scratchpad, out-of-root allowlists) is documented in `docs/ARCHITECTURE.md`. |

## Pi built-ins worth knowing alongside this

- `/compact` — summarize older context to free the window (the control plane points at this, it does not replace it)
- `/new` or `/clear` — fresh session (`/clear` is this extension's alias)
- `/hotkeys` — list active keybindings
- `/model` — pi's native model selector (unpatched); this package's `/models` + `alt+m` are the typeahead alternative with paging
- `/reload` — reload extensions after editing this repo

## Current limitations

- Chat-visible command output renders in interactive (TUI) mode only; in RPC/print modes command results surface as notifications where possible.
- "Reason Pi says the tool is needed" in Attended confirmations shows `Unavailable` — Pi does not expose the model's rationale for a tool call.
- Provider-payload length/hash appear only after the first LLM call of a session (the payload must be observed to be measured).
- Secret redaction is pattern-based: it reduces risk, it does not guarantee detection of every secret.
- Auto mode is policy enforcement inside Pi's process — **not** an operating-system sandbox (see `docs/SECURITY.md`).
- `local_web_search` depends on a local searxng instance being reachable; if it is not, the tool returns a clear error string to the model rather than throwing, but there is no fallback search source (deliberately not a paid API — see `docs/ARCHITECTURE.md`).
- Tool-name collisions across extensions are silent (last-registered-wins, no error) — unlike command-name collisions, which Pi disambiguates automatically. Verify with `pi list` + a grep for `registerTool` before assuming a newly added tool is actually reaching the model, especially after installing another extension.
- Live behavior is validated headlessly by `node tests/smoke/rpc-smoke.mjs` (13 checks over pi's RPC mode against llama-swap); only TUI rendering of dialogs/widget and terminal hotkey delivery still need a human check. See `docs/TESTING.md`.

## Development

```bash
npm test        # 301 tests, no dependencies, uses Node's built-in test runner
/reload         # inside pi, after editing extension code
```

## Additions restored 2026-09-14 (control plane only, no harness)

Cherry-picked from branch `harness-refactor-2026-09-14` without `pi-harness`:

- `transcribe_audio` tool (local whisper; `bin/transcribe-voicemail.ts`; "voicemail" profile)
- read-before-edit hard rule, backup-before-edit (pre-mutation snapshot, fails closed)
- reads free by default with a sensitive-path denylist; declined out-of-scope reads recorded
- read-only shell default; Yes / No / Always on every confirm; "Always (remember)" rules that suppress repeat prompts
- attended phase-switch dialog on phase-blocked mutating tools
- auto mode (accept-edits), headless rules opt-in, shift+tab mode cycle, `/effort`
- denial hints name `/mode`

Code paths that key on harness tool names (`harness_delegate`, `harness_request_scope`, `pi_harness_bash`) are
still present as string matches; without the harness extension they never fire.
