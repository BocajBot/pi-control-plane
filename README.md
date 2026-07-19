# Pi Control Plane

A control-plane extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono). It makes visible — and actually enforces — four things that are normally invisible while an agent works:

1. **What the model can see** (context files, skills, tools, system prompt, token usage) — `/context`
2. **What the model thinks it is doing** (an explicit, reviewable task brief) — `/task`, `/interpret`
3. **What stage of work is active** (Discuss / Plan / Execute / Verify) — `/phase`
4. **What the model is allowed to do** (Read-only / Attended / Restricted) — `/autonomy`

The central rule: **you can inspect and correct Pi's context and task interpretation before Pi is permitted to modify anything.** Enforcement is real — a phase or autonomy setting that would only change a label is treated as a bug.

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
| Phase | **Discuss** | No file writes, no shell, no mutation of any kind |
| Autonomy | **Read-only** | Only `read`, `grep`, `find`, `ls` are allowed |
| Task | none | No task brief accepted |

If anything fails to load or validate (saved state, the Restricted policy), the extension falls back to these defaults — never to a more permissive mode.

The footer shows a live status segment:

```text
Phase: Discuss | Mode: Read-only | No task | Context 12% full
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

A live `Token Counter: ~N` sits at the bottom right of the input box, estimating the token cost of what you are typing. It is an estimate (~4 characters per token — no tokenizer runs in-process), hence the `~`.

## Commands

### `/context` — what does the model actually see?

- `/context` — redacted summary: provider, model, token usage, message counts, context files, skills, prompt templates, active tools, system-prompt hash, provider-payload hash. Values the extension cannot observe print as `Unavailable`, never guessed.
- `/context diff` — what changed since the last `/context` or `/context full` (sources, tools, skills, model, tokens, hashes). The first run establishes the baseline.
- `/context full` — detailed view including the redacted system prompt (size-limited, truncation marked). Prints a warning first: redaction is pattern-based and cannot guarantee every secret is caught.
- `/context sources` — every prompt source with its toggle status: `enabled`, `disabled`, or `not toggleable`.
- `/context restore` — remove the `alt+e` context override (see the context editor section below).
- `/context recount` — re-count the last provider request with the model's own tokenizer (via llama-swap) and compare against pi's estimate. The same count feeds the footer's context segment automatically after every request.

The exact count also drives context-fullness warnings: a warning notification at 75% of the window and an error-level one at 90%, each fired once until usage drops back below 75% (e.g. after `/compact`). This matters because pi's built-in auto-compaction watches its own estimate, which can be off by a large margin (46% observed) — the control plane warns from the accurate number so you can `/compact` before the window actually overflows.
- `/context profile [name]` — tool profiles: named loadouts that enable exactly the listed tools and toggle everything else off (big context savings when many extensions are installed — e.g. `minimal` cut 19 of 26 tools in testing). No argument lists profiles and marks the active one; `all` re-enables everything. Ships with `minimal` (core coding tools) and `reading` (read-only tools). Define your own in `policy/profiles.json` — or just ask pi to "create a context profile for X": the bundled `create-context-profile` skill walks it through the schema, validation, and `/reload`. Applied profiles persist with the session like any toggle.
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

The accepted brief is injected into the system prompt each turn (objective, scope, constraints, unknowns, completion criteria, approval boundaries) together with behavioral requirements — including "do not claim completion without verification evidence".

### `/interpret <request>` — the interpretation gate

Runs one **no-tools turn** in which the model must restate the task as twelve required sections (Objective, Deliverables, Included/Excluded scope, Constraints, Assumptions, Unknowns, Proposed actions, Completion criteria, Approval boundaries, …). During this turn **every** tool call is blocked, and blocked attempts are recorded as diagnostic entries. Afterwards, phase and autonomy are restored and you decide: `/task accept` or `/task reject`. A response missing required sections is kept for display but cannot be accepted.

Your request text is wrapped in delimiters and treated as data — it cannot masquerade as control-plane instructions.

### `/phase` — what stage of work is active?

`discuss`, `plan`, `execute`, `verify`. **Discuss, Plan, and Verify block every mutating tool call regardless of autonomy.** Execute is the only phase where mutation is possible, and there autonomy decides. When verification reveals a needed change, switch back to Execute to apply it.

### `/autonomy` — what is the model allowed to do?

- `read-only` — only classified read tools (`read`, `grep`, `find`, `ls`). Shell is blocked entirely — commands are never parsed to guess whether they are "safe" (pattern-level command filtering proved unreliable in practice; whole-tool denial is reliable).
- `attended` — reads inside the project run freely; anything risky (writes, edits, shell, unknown tools, reads outside the project root) pops a confirmation dialog showing the tool, risk category, target/command, and whether it is inside the project root. Denying blocks the call. If no confirmation UI exists (e.g. print mode), risky calls are blocked — never silently allowed.
- `restricted` — policy-enforced mode: writes only inside the project root (paths canonicalized, symlinks resolved, `..` traversal caught), credential paths blocked (`.env`, `.ssh`, `.aws`, etc. — see `policy/default-policy.json`), shell blocked by default, unknown tools always blocked. If the policy file is missing or invalid, enforcement falls back to Read-only.
- `sandboxed` is accepted only as an alias for `restricted` and prints: *"This mode provides Pi-level policy restrictions, not operating-system isolation. It is not a security sandbox."* The status bar never displays "Sandboxed". See `docs/SECURITY.md` for why this distinction matters.

## Hotkeys

| Key | Action |
|---|---|
| `alt+c` | Toggle a context-preview widget above the editor |
| `alt+e` | Open the session context in **nvim** to view and edit it |
| `alt+s` | **Send preview**: everything the next message will send — system prompt (with the auto-appended control-plane block shown read-only), full history, and your unsent draft — in nvim, editable |
| `alt+t` | Tool-profile picker: modal with profile names in a left column (1/5 width) and, on the right, the selected profile's description over its tool list. ↑/↓ or j/k select, **enter** applies for this session only, **space** also saves it as the default for new sessions (written to `policy/profiles.json` as `defaultProfile`), esc closes; `*` marks the active profile, `(default)` the default one |
| `alt+p` | Cycle phase: Discuss → Plan → Execute → Verify |
| `alt+a` | Cycle autonomy: Read-only → Attended → Restricted |
| `alt+h` | Hotkey cheat sheet as a centered modal (any key closes; `/hotkeys` lists everything) |

`alt+s` is `alt+e` plus two things: lines prefixed `#> ` show the control-plane state block exactly as it will be appended to the system prompt (read-only — edits to them are ignored), and a `DRAFT` section holds your unsent message — editing it rewrites the input box on save. Context edits behave identically to `alt+e` (override, `Context edited`, `/context restore`).

### The context editor (`alt+e`)

`alt+e` suspends the TUI and opens the current session context — the system prompt plus every message the model would receive — in nvim (falls back to vim). Each message sits under a marker line; edit the text, delete whole message sections to remove them, `:wq` to apply, `:q!` to cancel.

- Edits become an **override for future turns in this session**: the model sees your edited history instead of the original. The session file is never rewritten — the chat scrollback still shows what really happened.
- Tool calls, tool results, thinking, and images appear as `[non-text: …]` placeholders and are preserved exactly; only text is editable. (Deleting one half of a tool call/result pair can make the provider reject the request — if that happens, `alt+e` again or restore.)
- `/context restore` removes the override. The footer shows `Context edited` while one is active.
- The override lives in memory only: it does not survive quitting, `/reload`, or compaction (compaction invalidates it with a notification, since the conversation no longer lines up).
- Malformed edits (broken markers, missing system-prompt section) are rejected whole — nothing half-applies.

**Why not shift+tab?** Pi already binds `shift+tab` to cycling the thinking level, so these default elsewhere. If you prefer Claude-Code-style `shift+tab` for the phase cycle, add this to `~/.pi/agent/keybindings.json` to move the *thinking* cycle somewhere else first, then the control plane's binding can take its place — see Pi's `docs/keybindings.md` for the file format:

```json
{
  "app.thinking.cycle": "ctrl+shift+t"
}
```

Then edit `extensions/control-plane.ts` in this repo and change `"alt+p"` to `"shift+tab"` in the `registerShortcut` call near the bottom, and run `/reload`. Trade-off: you lose one-key thinking-level cycling on its default key.

## Example workflow

```text
/context
/interpret Refactor the configuration loader and verify backward compatibility.
/task accept
/phase plan
/phase execute
/autonomy attended
...
/phase verify
```

Note: phase and autonomy control what *tools* may do. They do not change the model or its thinking level.

## What each file does

| File | What it is |
|---|---|
| `extensions/control-plane.ts` | The extension entry point Pi loads. Pure wiring: registers commands, hotkeys, event hooks. The logic lives in `src/`. |
| `src/control-plane/types.ts` | Shared type definitions and constants (phases, autonomy levels, state shape). |
| `src/control-plane/state.ts` | Safe defaults, validation, and restoration of saved state. Anything malformed falls back to Discuss + Read-only. |
| `src/control-plane/tool-policy.ts` | The authorization engine: tool classification, path canonicalization, and the allow/confirm/block decision. |
| `src/control-plane/redaction.ts` | Pattern-based secret redaction applied before any context is displayed or hashed. |
| `src/control-plane/context-snapshot.ts` | Builds the content-free context snapshot (names, counts, hashes — never raw content). |
| `src/control-plane/context-diff.ts` | Compares two snapshots for `/context diff`. |
| `src/control-plane/interpretation.ts` | Builds the `/interpret` prompt, parses the response, creates task briefs. |
| `src/control-plane/toggles.ts` | Verified excision of toggled-off sources from the system prompt. |
| `src/control-plane/commands.ts` | Argument parsing for the five commands (so bad input handling is testable). |
| `src/control-plane/ui.ts` | All text formatting: status line, summaries, denial messages, the injected state block. |
| `policy/default-policy.json` | Restricted-mode rules: denied path names/substrings, whether bash is allowed (default: no). Edit carefully — an invalid file makes Restricted behave as Read-only. |
| `tests/` | 77 unit and harness tests. Run with `npm test`. |
| `docs/` | Architecture, security model, and testing guides. |
| `IMPLEMENTATION-PROMPT.md` | The specification this milestone was built from. |

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
- Restricted mode is policy enforcement inside Pi's process — **not** an operating-system sandbox (see `docs/SECURITY.md`).
- Live behavior is validated headlessly by `node tests/smoke/rpc-smoke.mjs` (17 checks over pi's RPC mode against llama-swap); only TUI rendering of dialogs/widget and terminal hotkey delivery still need a human check. See `docs/TESTING.md`.

## Development

```bash
npm test        # 77 tests, no dependencies, uses Node's built-in test runner
/reload         # inside pi, after editing extension code
```
