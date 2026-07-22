# Pi Control Plane

A control-plane extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono). It makes visible — and actually enforces — four things that are normally invisible while an agent works:

1. **What the model can see** (context files, skills, tools, system prompt, token usage) — `/context`
2. **What the model thinks it is doing** (an explicit, reviewable task brief) — `/task`, `/interpret`
3. **What the model is allowed to do right now** (one merged setting: Discuss / Plan / Execute (attended) / Execute (restricted) / Execute (unattended) / Verify) — `/mode`

The central rule: **you can inspect and correct Pi's context and task interpretation before Pi is permitted to modify anything.** Enforcement is real — a mode that would only change a label is treated as a bug.

## Installation

```bash
pi install ~/Documents/pi-control-plane
```

This adds the package to `~/.pi/agent/settings.json` (`packages` list). Nothing else is changed. To uninstall:

```bash
pi remove ../../Documents/pi-control-plane   # the path as shown by: pi list
```

A backup of `settings.json` from before the first install exists at `~/.pi/agent/settings.json.bak.pre-control-plane-<timestamp>`.

## Default behavior (safe by default)

Every new session starts as:

| Setting | Default | Meaning |
|---|---|---|
| Mode | **Discuss** | No file writes, no shell, no mutation of any kind; only `read`, `grep`, `find`, `ls` run |
| Task | none | No task brief accepted |

If anything fails to load or validate (saved state, the Restricted policy), the extension falls back to these defaults — never to a more permissive mode.

The footer shows a live status segment:

```text
Mode: Discuss | No task | Context 12% full
```

The extension also replaces pi's cryptic stats line (`↑4.2k ↓30 R4.2k CH99.2% 8.6%/49k`) with plain words:

```text
sent 4.2k · received 30 · cache 4.2k reused (99.2% hits) · context 8.6% of 49k
```

- **sent / received** — cumulative tokens sent to and received from the model this session.
- **cache … reused / stored (…% hits)** — prompt-cache tokens read/written, and the latest turn's cache hit rate.
- **cost $…** — cumulative API cost (shown only when nonzero).
- **context … of … tokens at last request (model tokenizer)** — the exact size of the last provider request, counted by the model's own tokenizer through llama-swap (`/v1/messages/count_tokens` for Anthropic-shaped payloads, `/upstream/<model>/apply-template` + `/tokenize` for OpenAI-shaped ones). Yellow above 70%, red above 90% of the window.
- **context ~…% of … (estimated)** — fallback when no exact count is available yet (before the first request, or when the provider does not answer the counting endpoints): pi's internal estimate, labeled as such.

Pi's "(auto)" auto-compact indicator is not shown: extensions cannot observe that setting, and the control plane never guesses values it cannot verify.

A live `Token Counter: ~N` sits at the bottom right of the input box, estimating the token cost of what you are typing. It is an estimate (~4 characters per token — no tokenizer runs in-process), hence the `~`. Below it, `Added Context: ~N` shows the tokens that will accompany your draft when it is sent — system prompt, conversation history, and tool definitions — counted **before sending** by the model's own tokenizer while the agent is idle (refreshed after every turn, profile change, and at session start; never per keystroke). After the first request the count is built from the real last request plus what arrived since, and lands within a couple of tokens of the actual next request. Before the first request it is reconstructed from scratch and can undercount somewhat (pi adds serialization the extension cannot see); hence the `~`. `?` appears only when nothing could be counted at all.

## Commands

### `/context` — what does the model actually see?

- `/context` — redacted summary: provider, model, token usage, message counts, context files, skills, prompt templates, active tools, system-prompt hash, provider-payload hash. Values the extension cannot observe print as `Unavailable`, never guessed.
- `/context diff` — what changed since the last `/context` or `/context full` (sources, tools, skills, model, tokens, hashes). The first run establishes the baseline.
- `/context full` — detailed view including the redacted system prompt (size-limited, truncation marked). Prints a warning first: redaction is pattern-based and cannot guarantee every secret is caught.
- `/context sources` — every prompt source with its toggle status: `enabled`, `disabled`, or `not toggleable`.
- `/context restore` — remove the `alt+e` context override (see the context editor section below).
- `/context recount` — re-count the last provider request with the model's own tokenizer (via llama-swap) and compare against pi's estimate. The same count feeds the footer's context segment automatically after every request.

The exact count also drives context-fullness warnings: a warning notification at 75% of the window and an error-level one at 90%, each fired once until usage drops back below 75% (e.g. after `/compact`). This matters because pi's built-in auto-compaction watches its own estimate, which can be off by a large margin (46% observed) — the control plane warns from the accurate number so you can `/compact` before the window actually overflows.
- `/context profile [name]` — tool profiles: named loadouts that enable exactly the listed tools and toggle everything else off (big context savings when many extensions are installed — e.g. `minimal` cut 19 of 26 tools in testing). No argument lists profiles and marks the active one; `all` re-enables everything *except* `policy/profiles.json`'s `alwaysDisabledTools` (see below) — `all` has never meant "literally every tool, no matter what" since that field was added. Ships with `minimal` (core coding tools) and `reading` (read-only tools). Define your own in `policy/profiles.json` — or just ask pi to "create a context profile for X": the bundled `create-context-profile` skill walks it through the schema, validation, and `/reload`. Applied profiles persist with the session like any toggle.
- **`alwaysDisabledTools`** (`policy/profiles.json`, top-level, alongside `profiles`/`defaultProfile`): tools forced off every time *any* profile is applied — including `all` — regardless of which one. This is not another profile; it is a hard denylist layered on top of whichever allowlist a profile computes, specifically for when two installed extensions do the same job and you want exactly one of them reachable no matter which profile gets picked later. Ships with `["web_search"]`: `pi-web-access`, if installed, registers a tool of that exact name, and this package's own `local_web_search` (see below) is the local/free alternative — both being active at once means the model has to guess between two tools for one job, and Pi's tool registry has no picker to help it the way command-name collisions get one (see the `local_web_search` section for why that matters). A tool individually re-enabled afterward with `/context toggle tool:<name>` stays that way for the session — this only guards *bulk* profile application, never a deliberate single-tool override. Restored sessions are never touched by it; only fresh ones.
- `/context toggle <name>` — turn a source on or off for subsequent turns:
  - `tool:<name>` — genuinely removed from the model's tool list.
  - `file:<path>` — the file's content is excised from the system prompt each turn, **with verification**. If the excision cannot be verified, the toggle is reverted and you are warned — a source is never shown as disabled while it still reaches the provider.
  - `skill:<name>` — same verified-excision approach for the skills section.
  - `template:<name>` — not toggleable (Pi provides no honest way to exclude these); shown for visibility only.

When context usage passes 75%, `/context` reminds you that Pi's built-in `/compact` summarizes old context and `/new` starts a fresh session. The control plane does not reimplement compaction.

### `/task` — what does the agent believe it is doing?

- `/task` — show the accepted task brief and any pending interpretation.
- `/task set <text>` — set a task brief directly. Only your text is stored as the objective; structured fields are never fabricated.
- `/task accept` — adopt the pending `/interpret` result as the active brief. Refused if the interpretation was invalid.
- `/task reject` — discard the pending interpretation, leaving the accepted task unchanged.
- `/task clear` — clear both (asks for confirmation; `/task clear force` skips the dialog).
- `/brief` — collision-free alias for `/task`. Other extensions may also register `/task` (e.g. pi-task); when the name is ambiguous, pi's TUI shows a picker but non-interactive modes route unpredictably — `/brief` always reaches the control plane.

The accepted brief is injected into the system prompt each turn (objective, scope, constraints, unknowns, completion criteria, approval boundaries) together with behavioral requirements — including "do not claim completion without verification evidence".

### `/interpret <request>` — the interpretation gate

Runs one **no-tools turn** in which the model must restate the task as twelve required sections (Objective, Deliverables, Included/Excluded scope, Constraints, Assumptions, Unknowns, Proposed actions, Completion criteria, Approval boundaries, …). During this turn **every** tool call is blocked, and blocked attempts are recorded as diagnostic entries. Afterwards, the previous mode is restored and you decide: `/task accept` or `/task reject`. A response missing required sections is kept for display but cannot be accepted.

Your request text is wrapped in delimiters and treated as data — it cannot masquerade as control-plane instructions.

### `/scratchpad` — structured working notes that survive `/compact`

- `/scratchpad` — list current notes (id, timestamp, text).
- `/scratchpad add <text>` — add a note.
- `/scratchpad remove <id>` — remove one note.
- `/scratchpad clear` — remove all notes (asks to confirm; `force` skips the dialog).

Persisted as its own session entry, the same way control-plane state is: excluded from LLM context, untouched by `/compact` (which only summarizes messages), and injected into the system prompt every turn so the model can actually see and use its own notes across a compaction that would otherwise have wiped that context. The control plane never writes, edits, or summarizes a note's text itself — it only stores what it is told and shows back what is there.

### `/mode` — what is the model allowed to do right now?

One merged setting (workflow stage and permissions used to be two separate settings — `/phase` and `/autonomy` — which allowed contradictory combos like Execute + Read-only; they are now one):

- `discuss` — talk only. Every mutating tool blocked; reads (`read`, `grep`, `find`, `ls`) allowed. Shell is blocked entirely — commands are never parsed to guess whether they are "safe" (pattern-level command filtering proved unreliable in practice; whole-tool denial is reliable).
- `plan` — same permissions as discuss, framed for planning.
- `execute` — changes allowed, **attended**: reads inside the project run freely; anything risky (writes, edits, shell, unknown tools, reads outside the project root) pops a confirmation dialog showing the tool, risk category, target/command, and whether it is inside the project root. Denying blocks the call. If no confirmation UI exists (e.g. print mode), risky calls are blocked — never silently allowed.
- `execute-restricted` — changes allowed under policy, no confirmations: writes only inside the project root or an allowlisted prefix (`policy.allowPathPrefixes`, off by default — see `policy/default-policy.json`), paths canonicalized, symlinks resolved, `..` traversal caught, credential paths blocked (`.env`, `.ssh`, `.aws`, etc.), shell blocked by default, unknown tools always blocked. If the policy file is missing or invalid, enforcement falls back to read-only. (`restricted` is accepted as shorthand.)
- `execute-unattended` — identical policy enforcement to `execute-restricted` (same file, same rules, same allowlist), but requires an accepted task brief first — `/interpret` + `/task accept`, or `/task set <text>` — before any mutating or shell call is permitted; without one, every mutating call is blocked (reads are unaffected). Every *allowed* mutating/shell call is logged as a diagnostic entry, since this is the one mode meant to run with nobody confirming actions in real time. (`unattended` is accepted as shorthand.) See `docs/SECURITY.md` for the full reasoning.
- `verify` — read-only again, framed for checking the work. When verification reveals a needed change, switch back to `execute`.
- `sandboxed` is accepted only as an alias for `execute-restricted` and prints: *"This mode provides Pi-level policy restrictions, not operating-system isolation. It is not a security sandbox."* The status bar never displays "Sandboxed". See `docs/SECURITY.md` for why this distinction matters.

Sessions saved before the merge restore safely: a legacy combination that no longer exists is coerced to the nearest mode **without ever escalating permissions** (e.g. Plan + Attended restores as Plan; Execute + Read-only restores as Discuss).

### `/bwrap` — real OS-level isolation for `bash`, independent of `/mode`

`/mode`'s `sandboxed` alias (previous section) is Pi-level policy only — no OS isolation, by its own admission. `/bwrap` is the actual OS-level isolation: when on, every `bash` call that `/mode`'s policy layer already allowed (or a human already confirmed) is additionally wrapped in [bubblewrap](https://github.com/containers/bubblewrap) — unprivileged Linux user namespaces — before it runs. The two are independent and stack: `/mode execute` (per-command confirmation) + `/bwrap on` (kernel-enforced containment of whatever gets confirmed) is a reasonable combination, not a redundant one.

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
| `alt+p` | Cycle mode: Discuss → Plan → Execute (attended) → Execute (restricted) → Execute (unattended) → Verify |
| `alt+h` | Hotkey cheat sheet as a centered modal (any key closes; `/hotkeys` lists everything) |

`alt+s` is `alt+e` plus two things: lines prefixed `#> ` show the control-plane state block exactly as it will be appended to the system prompt (read-only — edits to them are ignored), and a `DRAFT` section holds your unsent message — editing it rewrites the input box on save. Context edits behave identically to `alt+e` (override, `Context edited`, `/context restore`).

### The context editor (`alt+e`)

`alt+e` suspends the TUI and opens the current session context — the system prompt plus every message the model would receive — in nvim (falls back to vim). Each message sits under a marker line; edit the text, delete whole message sections to remove them, `:wq` to apply, `:q!` to cancel.

- Edits become an **override for future turns in this session**: the model sees your edited history instead of the original. The session file is never rewritten — the chat scrollback still shows what really happened.
- Tool calls, tool results, thinking, and images appear as `[non-text: …]` placeholders and are preserved exactly; only text is editable. (Deleting one half of a tool call/result pair can make the provider reject the request — if that happens, `alt+e` again or restore.)
- `/context restore` removes the override. The footer shows `Context edited` while one is active.
- The override lives in memory only: it does not survive quitting, `/reload`, or compaction (compaction invalidates it with a notification, since the conversation no longer lines up).
- Malformed edits (broken markers, missing system-prompt section) are rejected whole — nothing half-applies.

**Why not shift+tab?** Pi already binds `shift+tab` to cycling the thinking level, so these default elsewhere. If you prefer Claude-Code-style `shift+tab` for the mode cycle, add this to `~/.pi/agent/keybindings.json` to move the *thinking* cycle somewhere else first, then the control plane's binding can take its place — see Pi's `docs/keybindings.md` for the file format:

```json
{
  "app.thinking.cycle": "ctrl+shift+t"
}
```

Then edit `extensions/control-plane.ts` in this repo and change `"alt+p"` to `"shift+tab"` in the `registerShortcut` call near the bottom, and run `/reload`. Trade-off: you lose one-key thinking-level cycling on its default key.

## Web search (`local_web_search` tool)

Registered directly by this package (no separate extension needed): searches the user's local searxng instance rather than a paid API. Classified as a read tool — available in every mode including Discuss/Plan/Verify, not gated behind Execute, since it never mutates anything. Targets `http://127.0.0.1:8888` by default; override with the `PI_CONTROL_PLANE_SEARXNG_URL` environment variable if searxng runs elsewhere. If `typebox` (the parameter-schema library) is not resolvable in the current environment, the tool is silently not registered rather than failing extension load — same fallback pattern already used for the Pi SDK imports themselves.

**Named `local_web_search`, not the more obvious `web_search`:** if you also have `pi-web-access` (or any other extension shipping a tool literally named `web_search`) installed, Pi's tool registry is a flat last-registered-wins map — there is no collision error and no picker the way colliding *command* names get one. A same-named tool from an extension that loads later in `packages` (`~/.pi/agent/settings.json`) would silently and completely replace this one; the model would never see it again, with no warning anywhere. Check `pi list` and grep for `registerTool` in anything else you install before assuming a new tool this package adds is actually reaching the model.

## Example workflow

```text
/context
/interpret Refactor the configuration loader and verify backward compatibility.
/task accept
/mode plan
/mode execute
...
/mode verify
```

Note: the mode controls what *tools* may do. It does not change the model or its thinking level.

## What each file does

| File | What it is |
|---|---|
| `extensions/control-plane.ts` | The extension entry point Pi loads. Pure wiring: registers commands, hotkeys, event hooks. The logic lives in `src/`. |
| `src/control-plane/types.ts` | Shared type definitions and constants (modes, state shape). |
| `src/control-plane/state.ts` | Safe defaults, validation, and restoration of saved state. Anything malformed falls back to Discuss + Read-only. |
| `src/control-plane/tool-policy.ts` | The authorization engine: tool classification, path canonicalization, and the allow/confirm/block decision. |
| `src/control-plane/redaction.ts` | Pattern-based secret redaction applied before any context is displayed or hashed. |
| `src/control-plane/context-snapshot.ts` | Builds the content-free context snapshot (names, counts, hashes — never raw content). |
| `src/control-plane/context-diff.ts` | Compares two snapshots for `/context diff`. |
| `src/control-plane/interpretation.ts` | Builds the `/interpret` prompt, parses the response, creates task briefs. |
| `src/control-plane/toggles.ts` | Verified excision of toggled-off sources from the system prompt. |
| `src/control-plane/scratchpad.ts` | Structured working notes: validation, persistence/restoration, and rendering. Same patterns as `state.ts`, applied to its own entry type. |
| `src/control-plane/sandbox.ts` | Bwrap command-line assembly and its own persisted on/off + network toggle. Pure: builds a command string, never spawns anything itself. Same patterns as `state.ts`/`scratchpad.ts`. |
| `src/control-plane/websearch.ts` | Pure searxng client (injected fetch): URL building, response parsing, result formatting. No Pi imports. |
| `src/control-plane/commands.ts` | Argument parsing for every command (so bad input handling is testable). |
| `src/control-plane/ui.ts` | All text formatting: status line, summaries, denial messages, the injected state block. |
| `policy/default-policy.json` | Restricted/Unattended-mode rules: denied path names/substrings, whether bash is allowed (default: no), out-of-root allowlist prefixes (default: none). Also the credential-path source of truth `/bwrap`'s `$HOME` shadowing reuses. Edit carefully — an invalid or old-schema file makes Restricted/Unattended behave as Read-only. |
| `tests/` | 168 unit and harness tests. Run with `npm test`. |
| `docs/` | Architecture, security model, and testing guides. |
| `IMPLEMENTATION-PROMPT.md` | The specification the first milestone was built from. Milestone 2 (unattended autonomy, web search, scratchpad, out-of-root allowlists) is documented in `docs/ARCHITECTURE.md`. |

## Pi built-ins worth knowing alongside this

- `/compact` — summarize older context to free the window (the control plane points at this, it does not replace it)
- `/new` — fresh session (there is no `/clear` in Pi)
- `/hotkeys` — list active keybindings
- `/model` — switch models
- `/reload` — reload extensions after editing this repo

## Current limitations

- Chat-visible command output renders in interactive (TUI) mode only; in RPC/print modes command results surface as notifications where possible.
- "Reason Pi says the tool is needed" in Attended confirmations shows `Unavailable` — Pi does not expose the model's rationale for a tool call.
- Provider-payload length/hash appear only after the first LLM call of a session (the payload must be observed to be measured).
- Secret redaction is pattern-based: it reduces risk, it does not guarantee detection of every secret.
- Restricted and Unattended modes are policy enforcement inside Pi's process — **not** an operating-system sandbox (see `docs/SECURITY.md`).
- `local_web_search` depends on a local searxng instance being reachable; if it is not, the tool returns a clear error string to the model rather than throwing, but there is no fallback search source (deliberately not a paid API — see `docs/ARCHITECTURE.md`).
- Tool-name collisions across extensions are silent (last-registered-wins, no error) — unlike command-name collisions, which Pi disambiguates automatically. Verify with `pi list` + a grep for `registerTool` before assuming a newly added tool is actually reaching the model, especially after installing another extension.
- Live behavior is validated headlessly by `node tests/smoke/rpc-smoke.mjs` (17 checks over pi's RPC mode against llama-swap); only TUI rendering of dialogs/widget and terminal hotkey delivery still need a human check. See `docs/TESTING.md`.

## Development

```bash
npm test        # 77 tests, no dependencies, uses Node's built-in test runner
/reload         # inside pi, after editing extension code
```
