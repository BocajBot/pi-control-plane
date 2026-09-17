# Pi Control Plane Continuity

Read [`README.md`](README.md), especially **Continuity contract — read before
changing Pi**, before changing Pi behavior. It is feature inventory and source
of truth for user-visible expectations.

## Preserve

- Control-plane modes and fail-closed policy behavior: credential protection,
  read-before-edit, backup-before-edit, and malformed-state recovery.
- Both model selectors: extension `/models` + `alt+m`, and native `/model`.
  Native `/model` scoped OpenRouter pricing is an installed-runtime patch.
  Repair source and executable bundle together; run
  `node --test tests/native-model-pricing.test.ts` after Pi updates.
- Persistent To-Do behavior: wrapped top-right open-task overlay, no duplicate
  `todo` tool, completion removes task state, and transcript says
  `Task [id] - description has completed.`
- Live OpenRouter cost projection, To-Do theme colors, readable editor/Working
  state, `/clear` alias, PageUp/PageDown model navigation, and requested labels.
- User-local settings, runtime state, and unrelated dirty work. Never expose
  credentials or raw sensitive context.

## Change protocol

1. Map affected command/tool/event/persistence/TUI path before editing.
2. Add regression coverage for behavior changes. Keep native runtime patches
   distinct from repository extension code.
3. Update README continuity inventory for changed ownership, behavior, paths,
   invariants, or validation. Update architecture, TUI, and testing docs where
   each applies.
4. Run focused tests and `git diff --check`; run applicable broader tests.
   Report failed checks exactly.
