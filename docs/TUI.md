# Minimal TUI

## Information hierarchy

Normal interaction needs conversation, active profile/tools, draft, and effective
permission mode. Full working directory, mode, context, OpenRouter credits and
model share one status row when width permits.
Conversation and input should dominate. No new borders, badges, panels or icons.

Blocked writes, invalid policy and context pressure matter when present. Keep
those messages adjacent to input, with explicit reason and next action. Color
supplements words: context pressure uses warning; invalid state and blocked
execution use error. Each message owns its color, so an unrelated urgent
condition cannot recolor it. Permission mode uses accent text; session identity
and detailed metrics use muted rather than dim text. Existing Pi theme roles
adapt to light/dark themes. Narrow detailed footers retain warning/error color
when clipped.

Full paths, branch, session name, token/cache totals, cost, thinking level and
draft/context counters are inspectable through `/control-ui details`. Return
with `/control-ui minimal`. `/context`, `/mode` and `/effort` still work.
The old idle counters and repeated context labels competed with conversation;
they no longer occupy the default view. Detailed mode retains the legacy layout.

## Layout: three regions

Pi stacks header, transcript, editor and footer in one viewport, so footer rows
are reserved in document flow and never overlay the transcript. The extension
contributes exactly one header row, opaque transcript rows for diagnostics, and
a compact footer whose contextual second row exists only when needed.

### Left grid

Every extension-owned line starts at column 1: header and footer rows carry a
literal one-space pad; transcript entries render inside a `Box(1, 0)`. Sub-items
(`  - `, `  [on] `) nest one indent level under that grid.

### Header

One normal-text row, clipped (never wrapped) to terminal width. It keeps active
profile, active tool count, names, and the `ctrl+alt+t` affordance together. At most
seven tool names are listed; the remainder collapses to `+N more`.

```text
 PROFILE minimal  ·  TOOLS 8  ask_user_question · bash · edit · find · grep · ls · read · +1 more  ·  ctrl+alt+t
```

### Status bar

The compact footer uses one status row, preceded by attention rows when any
exist. A second row appears only for active contextual extension statuses. Rows
use available terminal width and clip only at the actual viewport edge.

```text
 Context ~76% estimated — /compact
 ~/x/y  ·  Execute (attended)  ·  ctx 1%  ·  OpenRouter · $22.16  ·  model-name  ·  alt+h help
 LSP Active: typescript
```

Directory, context/provider/cost and model are muted; mode uses accent;
the context percentage turns warning/error at 75%/90%. The model sits beside
the provider metadata rather than at the far right. Attention text wraps on the
grid, preserving reasons and commands. Other extensions retain their own status.
The exact idle message `LSP Inactive` is hidden in minimal view and remains
available in details; active and error statuses stay visible. Detailed mode
(`/control-ui details`) keeps its legacy rows and uses available terminal width.

### Diagnostic rows

Each control-plane diagnostic is one opaque transcript row (`customMessageBg`)
followed by one blank line: a state glyph colored by tone, a sentence-case label
in normal text, the subject, then the timestamp in muted text.

```text
 ○ pending   ◐ running   ✓ passed   ✗ failed
 ✗ Blocked: read before edit "write"  2026-09-16T10:00:00.000Z
```

Unknown kinds render as pending with the kind verbatim. The running glyph is
static (entry renderers have no timer).

### Diagnostics panel and grouping

`alt+i` opens the session's diagnostic log as a centered modal (70% width,
minimum 40 columns, at most 60% of the terminal height). The panel is opaque:
every line is painted with `customMessageBg` after padding to the panel width,
so nothing beneath shows through. It has a rounded box-drawing border in the
subdued border color, a one-column dim `░` shadow on the right and bottom, and
a height equal to its content (no minimum, no empty middle; when the log
exceeds the cap a window of rows around the selection is shown).

```text
╭──────────────────────────────────────────╮
│ Control plane diagnostics (3)            │░
│                                          │░
│ ✗ Blocked: read before edit "write"      │░
│ ◐ Advisor consult  T2                    │░
│ ✓ Backup before edit /p/f.txt  T3        │░
│                                          │░
│ ↑↓ move · enter/esc close                │░
╰──────────────────────────────────────────╯░
 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

Hierarchy: title brightest (accent), diagnostic label and subject normal text,
timestamps muted, hint row and pending glyph dim. Accent is used only for the
title and the selected row's glyph; the selected row is filled with
`selectedBg`. Rows are grouped by blank lines rather than interior rules (the
profile picker's description/tools split uses a blank row for the same reason).

Limitations: pi-tui has no scrim or backdrop primitive, so the workspace behind
the panel is not dimmed; the opaque panel is the terminal-native equivalent.
Hover states need pi-tui's fullscreen mouse routing, which this extension does
not enable; focus is keyboard-only. Outside the TUI, `alt+i` emits the rows as
a chat entry.

### Width invariant

Base Pi throws (and exits) on any rendered line wider than the terminal. Every
custom `render(width)` in the extension returns lines passed through
`clipLine`/`clipLines` (pi-tui `truncateToWidth`/`visibleWidth`, with a plain
character fallback under the test harness): footer, header, context widget,
the alt+h/ctrl+alt+t/alt+i modals and the attended/advisor dialog headers. Pure
formatters in `ui.ts` stay width-unaware except `renderActiveTools` and
`renderDiagnosticsPanel`, which bound every row by construction.

## Scope and verification

Changes apply to `installFooter`, `installDraftCounter`, `/control-ui` in
`extensions/control-plane.ts`, and `compactFooterState` in
`src/control-plane/ui.ts`. Authorization, persistence and provider requests are
unchanged. Native tool operations, cancellation and approval dialogs remain Pi's
responsibility. Screenshot review identified competing bright input rails, a
floating two-row header and redundant idle LSP status. The revised theme uses
subtle violet thinking borders and one cell of native editor padding; the tool
header fits one row when possible, and model identity aligns right in the footer.
Live rendering of these revisions remains unverified.

Node tests exercise the real footer/widget factories, minimal/details switching,
unknown and estimated context, attention text, external statuses and widths from
1 to 120 columns. A live Pi terminal still needs visual review for contrast,
Unicode cell sizing and interaction with the native editor.

## Cyberpunk palette

`pi-cyberpunk` is bundled through `package.json` and selected in this project's
`.pi/settings.json`. Other projects can select it through Pi's `/settings` theme
picker once this package is loaded. Reload resources with `/reload` after updates.

Cool white text (`#E6EDF7`), readable slate metadata (`#A5AEC5`), cyan focus
(`#53F5FF`) and magenta headings/syntax (`#F48CFF`) sit on dark ink surfaces.
Amber (`#FFD166`) marks warnings; pink-red (`#FF719A`) marks errors; mint
(`#65F5B5`) marks success. Borders stay subdued. Semantic roles remain unchanged.

Pi does not set the terminal's default background: use a dark background such as
`#10121F` for unboxed conversation. Theme surfaces and HTML export use matching
ink tones. This theme is intended for dark terminals; switch themes in `/settings`
when using a light terminal. Terminal configuration itself is unchanged.

## Context tools header

A left-grid header row lists the active tool names from `pi.getActiveTools()`.
Names refresh on each render, including profile and individual toggle changes.
The list shows tools exposed to the model, not tools currently executing or
permission to execute them. Policy checks and approvals remain separate.

`PROFILE`, profile name, `TOOLS N`, active names, and `ctrl+alt+t` share one row,
clipped to terminal width and capped at seven names. The default profile is
confirmed here on fresh sessions instead of adding a duplicate transcript
notification; explicit profile changes still notify. The native header stays at the
top of conversation and scrolls with it; it is not a pinned overlay.
`installToolsHeader` owns registration; `renderActiveTools` owns formatting.


## Directory, credits and diagnostics refinement

The compact status line shows directory, mode, context percentage beside the
OpenRouter balance and current-turn delta (`ctx 1% · OpenRouter · $22.16 · Δ
−$0.08`), then the model (see "Status bar" above). `~` marks estimated context;
an unprefixed value uses the last request's tokenizer count. Detailed view
retains legacy token/cost metrics.

`src/control-plane/credits.ts` owns validated account snapshots and serialized,
nonblocking refreshes. `session_start` reads the initial balance;
`before_agent_start` queues a baseline; streaming events throttle live refreshes;
and each completed OpenRouter assistant message immediately deducts its
provider-reported `usage.cost.total`. `~$` marks this projected balance until the
account endpoint catches up. `agent_end` also starts short settlement checks, so
delayed billing appears without another prompt. The four-second timeout never
blocks model execution. Credentials resolve from `OPENROUTER_MANAGEMENT_KEY`,
`OPENROUTER_API_KEY`, then Pi's OpenRouter provider credential. Keys and response
bodies are never logged or persisted. Failed refreshes show unavailable or
explicitly stale balance while retaining any useful projection. Endpoint deltas
remain account-wide; other clients and top-ups can affect them.

Source: [OpenRouter credits API](https://openrouter.ai/docs/api/api-reference/credits/get-credits).
The API documents a management-key requirement; current existing credential was
verified against the live endpoint without printing the key or balance.

Tool output starts collapsed and successful/pending tools have transparent
backgrounds; error surfaces remain distinct. These presentation changes do not
remove tool results from model context.

## Task-list widget

The `todo` tool owns a workspace-persistent task list. Models receive an explicit
guideline to create tasks before multi-step work, complete each task as work
finishes, and leave unfinished tasks open. Session entries plus atomic state in
Pi's agent state directory preserve the list across reload, branch restoration,
compaction, and new windows opened in the same workspace. A noncapturing TUI
overlay anchors the list at the literal top-right, outside transcript flow, so
it remains visible while open tasks exist without taking keyboard focus.
Mutations request an immediate render. Hollow radial bullets mark open tasks.
Completing a task removes it from the live list and writes `Task [id] -
description has completed.` into the conversation. Rounded borders and theme
colors follow the active theme. Six tasks display before a `+N more` summary.
`/todo-clear` removes all tasks, including unfinished ones, immediately hides the
empty overlay, and notifies how many were removed. It saves the empty list across
sessions without adding task-completion entries.

`/control-ui timing` shows the workload ledger: last turn (first streamed text
+ total, including model, tools and hooks), cumulative model time across all
turns (count, total, average, slowest), and recent turn durations. The ledger
is persisted as its own session entry (`pi-control-plane-timing`), so resumed
sessions keep their totals; the detailed footer carries a compact segment
(`time 4m 12s · 9 turns`) once any turn has completed.

## Model picker modal (alt+m / /models)

The model picker is a `ctx.ui.custom` modal: a keymap header and separate
`Ctrl+s select and save as default` hint, both clipped to viewport width, a
filter line (`> query`), and pi-tui's `SelectList` (15 visible). Printable keys
extend the substring filter (rebuilt per keystroke), backspace edits it,
↑↓/enter/esc go to the list, and PageUp/PageDown jump a page via
`setSelectedIndex(±15)` — public component API only, no bundle patching (the
retired `bin/patch-pi-model-page-nav.mjs` approach is archived under
`~/.pi/agent/archive/`). OpenRouter rows show input/output pricing in Pi's
native `$input/$output per Mtok` format; `+` marks models with request-size
pricing tiers. Ctrl+s selects the highlighted filtered row, closes the modal,
and saves it as the global default after selection succeeds. Enter remains
session-only; Ctrl+s with no matches does nothing. Save success/failure is
notified explicitly, including when saving the already-current or only model.
Input requests an immediate repaint. At startup the same modal appears once; escape there
quits pi (guarded by `isIdle` so only a human answering it can). Outside the
TUI (`ctx.mode !== "tui"`), no modal is attempted — `/models <query>` switches
directly and `/models` prints the frecency-ordered list.

Historical note: an earlier vendor patch restyled pi-lens ("Code diagnostics"
above input). pi-lens is no longer installed; the patch script is archived
alongside the model-nav patch under `~/.pi/agent/archive/`.
