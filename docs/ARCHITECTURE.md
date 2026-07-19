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
| `agent_end` | Detect completion of an `/interpret` turn, parse the response, restore phase/autonomy |
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

`before_agent_start` returns `{ systemPrompt: original + "\n\n" + block }`. Because the return value replaces the prompt only for that turn, injection is ephemeral: no duplicate messages accumulate in the session. The block contains phase, autonomy, task status, the accepted brief's key fields (each field capped at 700 chars, the block at 6000, truncation marked `[TRUNCATED]`), and the behavioral requirements. Task text passes through `neutralizeDelimiters()` so user-supplied content cannot imitate control-plane instructions.

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
autonomy               -> read-only: block; attended: confirm; restricted: policy
tool classification    -> read / mutate / shell / unknown (unknown never safe)
path checks            -> canonicalize (symlinks, .., nonexistent tails),
                          root containment, credential-path deny list
```

The confirm action is executed by the entry (`ctx.ui.confirm`); a denied dialog or a missing dialog API both result in a block.

## Extension seams for later milestones

- **Unattended autonomy**: add `"unattended"` to `AUTONOMY_LEVELS` and a branch in `evaluateToolCall`; state validation, cycling, and status handling pick it up from the constant. Deliberately absent until the enforcement layer has proven itself.
- **Web search**: a future custom tool registered via `pi.registerTool`, classified in `tool-policy.ts` (target: the existing local searxng instance on :8888, not a paid API).
- **Scratchpad**: a new custom-entry type alongside the state entry; survives compaction the same way.
- **Out-of-root allowlists**: extend `RestrictedPolicy` with `allowPathPrefixes`; `validatePolicy` and `matchesDenyPatterns` are the only touch points.
