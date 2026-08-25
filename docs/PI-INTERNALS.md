# Pi internals — field notes

Notes on the installed `@earendil-works/pi-coding-agent` package, gathered while
wiring keybindings and the `/effort` command (2026-08-24, pi 0.84.2). Paths are
for this machine; re-verify after a pi upgrade.

## Install layout

- Binary: `~/.local/bin/pi` → `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`
- Agent state dir: `~/.pi/agent/` — holds `settings.json`, `models.json`,
  `keybindings.json` (user overrides, absent by default), `sessions/`,
  `extensions/`, `skills/`, `themes/`, `trust.json`
- Extension npm deps: `~/.pi/agent/npm/node_modules/`
- Extension API types: `dist/core/extensions/types.d.ts` in the package
  (`ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`)

## Keybindings

- Defaults: `dist/core/keybindings.js` (`KEYBINDINGS` map, canonical ids like
  `app.thinking.cycle`, `app.model.select`). TUI-level ids come from
  `TUI_KEYBINDINGS` in `@earendil-works/pi-tui`.
- User overrides: `~/.pi/agent/keybindings.json`, shape
  `{ "<keybinding id>": "key" | ["key", ...] }`. An **empty array unbinds**
  the action (rebuild() uses user keys verbatim when the id is present).
- Notable defaults: `shift+tab` = `app.thinking.cycle`, `ctrl+p` = model cycle,
  `ctrl+l` = model selector, `ctrl+t` = toggle thinking blocks.

## Extension shortcuts

- `pi.registerShortcut(keyId, {description, handler})`; `keyId` is a pi-tui
  `KeyId` string ("alt+p", "shift+tab", ...).
- Conflict rules in `dist/core/extensions/runner.js` `getShortcuts()`:
  `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` (includes
  `app.thinking.cycle`, interrupt/clear/exit, submit, etc.) — an extension
  shortcut on a key currently bound to a reserved action is **skipped with a
  warning**. Non-reserved conflicts: extension wins with a warning.
- Therefore: to claim a reserved default key (e.g. shift+tab), first unbind
  the builtin in `keybindings.json` (`"app.thinking.cycle": []`). Done here so
  the control-plane extension can put mode cycling on shift+tab.

## Tools

- `pi.registerTool({name, label, description, parameters, execute})`.
- **`execute(toolCallId, params, signal, onUpdate, ctx)` — five arguments, ctx
  LAST** (`dist/core/tools/tool-definition-wrapper.js`). A three-argument
  lambda `(id, params, ctx)` binds `ctx` to the AbortSignal: `ctx.cwd` reads
  `undefined` silently, and `ctx.modelRegistry.getAvailable()` throws
  "Cannot read properties of undefined". Four harness tools shipped with this
  bug; `tests/harness-extension.test.ts` now pins the arity.
- `ctx` here is an `ExtensionContext`, so `modelRegistry`, `cwd`, `model` are
  available — but NOT the command-only methods.

## Commands

- `pi.registerCommand(name, {description, getArgumentCompletions?, handler})`;
  handler gets `(args: string, ctx: ExtensionCommandContext)`.
- `getThinkingLevel()/setThinkingLevel(level)` (clamped to model caps) live on
  **ExtensionAPI** — the `pi` object — NOT on ctx. The .d.ts lists them near
  `registerCommand` inside `interface ExtensionAPI`; easy to misread as
  context methods (that mistake produced "ctx.getThinkingLevel is not a
  function" at runtime). ctx has only a read-only `thinkingLevel?` property.
- `ExtensionCommandContext` (only in command handlers, not shortcuts) adds:
  `setModel()`, `newSession()`, `waitForIdle()`, `fork()`, `switchSession()`.
- `ThinkingLevel` union (from pi-agent-core): `off | minimal | low | medium |
  high | xhigh | max`. `/effort` in the control-plane extension wraps
  `setThinkingLevel`.
- `ExtensionContext` (all handlers): `ui`, `model`, `thinkingLevel?`,
  `isIdle()`, `abort()`, `compact()`, `getContextUsage()`, `getSystemPrompt()`.

## Local customizations (this machine)

- `~/.pi/agent/keybindings.json`: `{"app.thinking.cycle": []}` — shift+tab
  freed from thinking-level cycling.
- Control-plane extension: shift+tab and alt+p both cycle mode; `/effort`
  sets thinking level.
