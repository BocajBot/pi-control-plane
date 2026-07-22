# Architecture

## Layering

```text
extensions/control-plane.ts     <- wiring only: Pi API calls, event hooks
        |
src/control-plane/*.ts          <- pure logic: no Pi imports, no I/O (except
                                   node:crypto, node:path; fs is injected)
```

The entry point registers everything against the `ExtensionAPI` Pi passes to the factory. Every decision (authorization, parsing, diffing, redaction, validation) is a pure function in `src/`, unit-tested without launching Pi. The entry imports `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` **dynamically** with fallbacks, so the same entry file can be loaded by the test harness (`tests/extension-harness.test.ts`) under plain Node: inside Pi both imports resolve; outside, skill toggles report as not applied and entry renderers render nothing.

## Extension lifecycle

Verified against pi 0.80.10 (`dist/core/extensions/types.d.ts`):

| Hook | Used for |
|---|---|
| `session_start` | Restore state from session entries, re-apply tool toggles, show status |
| `before_agent_start` | Apply source toggles (verified excision), append the control-plane block to the system prompt (ephemeral, per-turn) |
| `before_provider_request` | Capture redacted payload length + sha256 (metadata only; payload never stored or persisted) |
| `tool_call` | The enforcement point: allow / confirm / block every tool call |
| `agent_end` | Detect completion of an `/interpret` turn, parse the response, restore the previous mode |
| `agent_settled`, `model_select` | Refresh the footer status segment |

## State model

`ControlPlaneState` (schemaVersion 1): phase, autonomy, acceptedTask, pendingInterpretation, previousContextSnapshot, sourceToggles, interpretGuard, updatedAt.

- Persisted via `pi.appendEntry("pi-control-plane-state", state)` on every change. Custom entries live in the session file but never enter LLM context, and they survive `/compact` (compaction summarizes messages; entries remain on the branch).
- Restoration (`state.ts: restoreFromEntries`) walks the branch backward, takes the newest entry that passes strict validation, ignores malformed ones, and falls back to defaults (Discuss + Read-only) otherwise. An unknown `schemaVersion` is malformed by definition.
- The interpretation guard is never restored: a restart cannot resume a half-finished no-tools turn, so the guard is always cleared on `session_start`.

## Context snapshot model

Snapshots are **content-free**: names, paths, counts, lengths, and sha256 hashes of *redacted* text — never raw prompt or message content. Lists are sorted so identical state produces identical snapshots (`context-snapshot.ts`), which makes `/context diff` (`context-diff.ts`) deterministic. The one stored snapshot (`previousContextSnapshot`, the diff baseline) is therefore safe to persist in the session file.

Provider payload observation: `before_provider_request` serializes the payload, redacts it, records `{length, hash}`, and drops the text. Nothing is written to disk.

## Source toggles

Three mechanisms, by kind:

- **Tools** — `pi.setActiveTools()`: the tool genuinely disappears from the model's tool list. Applied incrementally (only the toggled tool is added/removed) so other extensions' tool management is not clobbered. Re-applied on restore.
- **Context files** — the file's content is excised from the assembled system prompt in `before_agent_start`, then the result is verified to no longer contain it (`toggles.ts: exciseExact`).
- **Skills** — Pi's own `formatSkillsForPrompt()` renders the skills block for the full and the filtered skill list; the former is replaced with the latter, with verification.

**Honesty rule:** when verification fails, the toggle is reverted, the user is warned, and the source is reported as enabled. A source is never displayed as disabled while it still reaches the provider. Prompt templates are shown as `not toggleable` because Pi provides no honest exclusion mechanism for them.

## Task-brief injection

`before_agent_start` returns `{ systemPrompt: original + "\n\n" + block }`. Because the return value replaces the prompt only for that turn, injection is ephemeral: no duplicate messages accumulate in the session. The block contains the mode, task status, the accepted brief's key fields (each field capped at 700 chars, the block at 6000, truncation marked `[TRUNCATED]`), and the behavioral requirements. Task text passes through `neutralizeDelimiters()` so user-supplied content cannot imitate control-plane instructions.

## Context editor (alt+e)

`context-editor.ts` (pure) serializes the effective context — system prompt + messages captured from the `context` event — into a marker-delimited document, parses the edited result, and splices text edits back while preserving non-text blocks verbatim. The entry suspends the TUI with the same `tui.stop()` → spawn (stdio inherit) → `tui.start()` pattern Pi's own external-editor support uses, launching nvim (vim fallback) on a mode-0600 temp file that is always unlinked.

An accepted edit becomes an in-memory `Overlay { messages, baseCount, systemPrompt }`. On every `context` event the overlay replaces the first `baseCount` live messages and newer messages are appended unchanged (`mergeOverlay`); if the live conversation shrinks below `baseCount` (compaction, tree navigation) the overlay is invalidated with a notification. The system-prompt override substitutes the base prompt in `before_agent_start` before toggles and the control-plane block apply. `/context restore` clears it; the status segment shows `Context edited` while active. Nothing about the override is persisted.

## Command flow

`registerCommand` handlers parse arguments through the pure parsers in `commands.ts` (usage errors are data, not exceptions), act on state, persist, refresh status, and emit chat-visible output as custom entries (`pi-control-plane-output`) rendered by a registered entry renderer — visible in the TUI, excluded from LLM context.

## Tool authorization precedence

Implemented in `tool-policy.ts: evaluateToolCall`, in this order; the first applicable restriction wins:

```text
interpretation guard   -> block everything, reads included
workflow phase         -> Discuss/Plan/Verify block mutate/shell/unknown
autonomy               -> read-only: block; attended: confirm;
                          restricted/unattended: policy (unattended adds one
                          earlier check: no accepted task -> block outright)
(the user sets both through one /mode setting: Discuss/Plan/Verify imply
read-only, Execute picks attended, restricted, or unattended; internally the
two layers stay separate and legacy saved combos are coerced without
escalation)
tool classification    -> read / mutate / shell / unknown (unknown never safe;
                          local_web_search is a registered custom tool classified read)
path checks            -> canonicalize (symlinks, .., nonexistent tails), then
                          root containment OR an allowlisted prefix
                          (policy.allowPathPrefixes, realpath'd at check time),
                          then the credential-path deny list either way
```

The confirm action is executed by the entry (`ctx.ui.confirm`); a denied dialog or a missing dialog API both result in a block.

## Milestone 2: unattended autonomy, web search, scratchpad, out-of-root allowlists

All four seams named in the original milestone plan are now implemented, each exactly where that plan said it would live:

- **Unattended autonomy** (`tool-policy.ts`, `types.ts`, `state.ts`): `"unattended"` is a fourth `AUTONOMY_LEVELS` value and `execute-unattended` a sixth `Mode`, both picked up automatically by the existing cycling/validation/restoration code (no new state-machine logic needed there). `evaluateToolCall` gates it on `hasAcceptedTask`: every mutating call is blocked with `unattended:no-task` until a task brief is accepted, and once gated, enforcement reuses the exact same `RestrictedPolicy` logic Restricted uses (same rule names, same deny patterns, same root containment) — Unattended is Restricted's policy engine plus a mandatory scope boundary, not a separate, more permissive path. Reads are not gated by the task-brief requirement (observation is not the risk this level targets). The entry point (`extensions/control-plane.ts`, `tool_call` handler) logs every *allowed* mutating/shell call as a `DIAGNOSTIC_ENTRY_TYPE` entry — an audit trail for when nobody is watching in real time. Entering the mode without an accepted task shows a warning instead of silently doing nothing.
- **Web search** (`websearch.ts`, new): pure module (injected `fetch`, no Pi imports) targeting the user's local searxng instance (`http://127.0.0.1:8888` by default, overridable via `PI_CONTROL_PLANE_SEARXNG_URL`) via its `?format=json` API — explicitly not a paid API, matching the original plan. Registered as `local_web_search` via `pi.registerTool` in the entry point, dynamically importing `typebox` with the same load-outside-Pi fallback pattern already used for `@earendil-works/pi-coding-agent`/`@earendil-works/pi-tui` (if `typebox` is unavailable, the tool is simply not registered). Classified as a `read` tool in `tool-policy.ts` (`READ_TOOLS`), so it is available in Discuss/Plan/Verify like `grep` or `find`, not gated behind Execute.
  - **Named `local_web_search`, not `web_search`** (renamed 2026-07-22, before ever shipping under the original name - checked via `pi list` + reading Pi's own `agent-session.js`): Pi's tool registry (`_refreshToolRegistry` in `agent-session.js`) merges every extension's tools into one flat `Map`, later `packages` entries overwriting earlier ones by name, with no error and no picker (contrast with *command* names, which Pi disambiguates automatically via an `invocationName` suffix - see `resolveRegisteredCommands` in `extensions/runner.js`). `pi-web-access`, if installed, registers a tool literally named `web_search`; reusing that name here would have silently and permanently shadowed this tool the moment both extensions loaded, with nothing anywhere indicating it had happened. Lesson for any future custom tool added to this package: grep every other installed extension's `registerTool` calls first, or prefix the name distinctly.
- **Scratchpad** (`scratchpad.ts`, new): a `SCRATCHPAD_ENTRY_TYPE` custom entry alongside the state entry, restored with the identical walk-backward-take-first-valid pattern as `state.ts:restoreFromEntries` (`restoreScratchpadFromEntries`). Survives `/compact` the same way state does. `/scratchpad [add <text>|remove <id>|clear]`. Notes are injected into the system prompt each turn (`before_agent_start`, after the task-brief block) via `renderScratchpadBlock`, capped at `LIMITS.injectionTotal`; an empty scratchpad renders nothing (no per-turn noise). The control plane never writes, edits, or summarizes note content on the model's behalf — same "never invent what you cannot observe" posture as the rest of this codebase.
- **Out-of-root allowlists** (`tool-policy.ts`, `types.ts`, `policy/default-policy.json`): `RestrictedPolicy.allowPathPrefixes: string[]` (policy schema bumped 1 -> 2 — a schema-1 policy file is an unknown version and fails closed to Read-only, deliberately, not a bug). `isAllowedDestination` widens the Restricted-mode mutate-branch destination check: a canonical target outside the project root is still permitted if it falls under one of the allowlisted prefixes, each resolved via `realpath` at check time; an entry that does not exist on disk is skipped entirely (never a literal-string fallback match). Deny patterns (credential paths) still apply inside an allowlisted prefix exactly as inside the root — the allowlist only widens *where* writes may land, never *what* is denied. Applies to Unattended too, since it shares the same policy-enforcement code path.

Test coverage: `tests/tool-policy.test.ts` (unattended gate + shared-enforcement equivalence + allowlist, pure), `tests/scratchpad.test.ts`, `tests/websearch.test.ts` (pure, injected fetch/fs), `tests/extension-harness.test.ts` (end-to-end: command registration, tool registration, gate + audit-log wiring, scratchpad persistence + injection).

## Cross-extension tool redundancy: `alwaysDisabledTools`

Discovered 2026-07-22 auditing every extension in `~/.pi/agent/settings.json`'s `packages` list for tool/command/hotkey overlap with this package. Two findings, handled differently because Pi's own collision handling differs by registration kind:

- **Tool names collide silently.** `_refreshToolRegistry` in Pi's `agent-session.js` merges every extension's tools into one flat `Map`, later `packages` entries overwriting earlier ones with no error and no signal anywhere that it happened. This package's `web_search` tool (built the same day, before ever validating this) was silently and completely shadowed by `pi-web-access`'s tool of the identical name from the moment both were active. Renamed to `local_web_search` to fix the specific collision (see the tool's own section above).
- **Command names do not collide silently.** `resolveRegisteredCommands` in `extensions/runner.js` detects a name used by more than one extension and assigns each occurrence a disambiguated `invocationName` (`task:1`, `task:2`, ...), which Pi's TUI resolves via a picker. `/task` colliding with the third-party `pi-task` extension is exactly this case, already handled by `/brief` as the deterministic alias (see the `/task` section above) - not a bug, confirmed by reading the source rather than assumed.
- **Beyond exact-name collisions, three extensions do overlapping jobs with different tool names**: this package's `local_web_search`, `pi-web-access`'s `web_search` (paid multi-provider), and `pi-task`'s `pi-worker-search` (search, paired with its own `pi-worker-fetch` - both wired into `pi-task`'s own `/task` pipeline orchestration, not standalone utilities). `alwaysDisabledTools` in `policy/profiles.json` (a new field alongside `profiles`/`defaultProfile`, `profiles.ts`) currently disables only `web_search`: it and `local_web_search` are both plain, standalone, general-purpose search tools with no other extension depending on either of them, making the redundancy a clean call. `pi-worker-search`/`pi-worker-fetch` were deliberately left alone - disabling them risks degrading `pi-task`'s own `/task` pipeline feature, a different job (deterministic multi-stage orchestration) than "search the web" as a standalone utility, and that risk was not fully resolved before deciding not to touch it.
- **Mechanism**: `applyAlwaysDisabled` (`profiles.ts`) forces the listed tools off in a toggle map; `applyNamedProfile` (`extensions/control-plane.ts`) calls it after computing whichever profile's own allowlist, including `"all"` - so `alwaysDisabledTools` wins regardless of which profile is active, and `"all"` no longer means literally every tool (documented in `currentProfileName`'s matching logic, which now excludes `alwaysDisabledTools` from what `"all"` is expected to equal). Applied once more, independently, for a fresh session that starts with no default profile at all (`defaultProfile: null` or `"all"`) so the invariant holds even outside the profile system. Restored sessions are never touched - the same "don't silently revert a toggle set by hand" rule the rest of source-toggle handling already follows. An individual `/context toggle tool:<name>` afterward still works normally; only bulk profile application is guarded.
