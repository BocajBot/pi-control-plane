# Testing

## Unit and harness tests

```bash
npm test          # = node --test "tests/*.test.ts"
```

No dependencies: Node 22's built-in test runner executes the TypeScript directly (native type stripping; verified on v22.22.3). Twenty-two files:

| File | Covers |
|---|---|
| `state.test.ts` | Safe defaults, serialization round-trip, malformed/unknown-schema rejection, compaction-safe restoration, guard-never-restored, cycle orders (all four modes), no fallback above Read-only |
| `tool-policy.test.ts` | Classification (incl. `local_web_search` and pi-web-access's `fetch_content`/`get_search_content`/`source_check` as read; remote-vs-local URL targeting), canonicalization (traversal, symlink escape, malformed paths — uses real temp dirs and symlinks), deny patterns, Pi agent package-read carve-out with `auth.json` held, policy validation (schema v2, `allowPathPrefixes`), the full phase × autonomy decision matrix incl. Unattended, out-of-root allowlist behavior, invalid-policy fallback |
| `redaction.test.ts` | Every redaction category with fabricated credentials; non-secret text preserved; determinism |
| `context-snapshot.test.ts` | Normalization stability, hash stability, no-raw-secret persistence, all diff categories, deterministic ordering |
| `context-editor.test.ts` | Context serialization/parsing round-trip, overlay merge/invalidation, edit application |
| `toggles.test.ts` | Verified excision success/failure, skills-block replacement, toggle naming |
| `profiles.test.ts` | Tool-profile validation, application, active-profile detection, `alwaysDisabledTools` (schema v2: applyAlwaysDisabled, "all" no longer meaning literally every tool, already-disabled/not-present edge cases) |
| `token-counter.test.ts` | Payload-format detection, message serialization for counting, count-endpoint dispatch (Anthropic vs OpenAI shaped payloads) |
| `ui.test.ts` | Status/mode display strings, footer stats formatting, context-warning thresholds, draft/added-context counters |
| `scratchpad.test.ts` | Note CRUD, truncation and capacity limits, strict validation, compaction-safe restoration, injection-block rendering (incl. the empty-scratchpad-renders-nothing rule) |
| `todo.test.ts` | Task CRUD, completion removal, strict restoration, prompt injection, open-task bullets, rounded widget rendering, wrapping, and item caps |
| `todo-store.test.ts` | Atomic workspace persistence, workspace isolation, malformed-state rejection, and newest-snapshot selection |
| `websearch.test.ts` | searxng URL building, response parsing (missing URL/results dropped gracefully), network/HTTP/JSON failure handling (caught, never thrown), result formatting |
| `extension-harness.test.ts` | The real entry against a fake Pi API: attended deny-blocks/approve-allows, no-UI fail-closed, cross-"session" restoration incl. tool toggles, sandboxed alias warning, injection block + verified excision + honest failure, hotkey cycling through all four modes, `/scratchpad` end-to-end incl. system-prompt injection, `local_web_search` tool registration, Unattended's per-call audit logging, workload-timing ledger end-to-end, and todo overlay positioning, immediate repaint, completion transcript, cleanup, and cross-session restoration |
| `backup.test.ts` | Backup-before-edit decision logic: pre-mutation snapshot, fail-closed |
| `credits.test.ts` | OpenRouter balance parsing, live response-cost projection, reconciliation, and formatting (`CreditBalance`) |
| `model-picker.test.ts` | Frecency ordering (recency decay, local-provider boost), usage IO (record, atomic save, tolerant load), OpenRouter input/output price labels, substring filtering, page-jump clamping, key classification (printables, backspace, PageUp/PageDown incl. modifier variants), `modelPicker:false` opt-out, `/models` argument resolution |
| `native-model-pricing.test.ts` | Installed Pi `/model` regression guard: scoped OpenRouter models retain cached input/output prices in source and executable bundle |
| `turn-timing.test.ts` | Workload ledger: turn recording and accumulation, recent cap, strict validation, backward-walking restoration, duration formatting, footer segment and summary rendering |
| `rules.test.ts` | Remembered-decision soft rules ("Always" confirmations) validation and matching |
| `sandbox.test.ts` | Bwrap command-line assembly: arg building, credential shadowing, pure (no spawn) |
| `sensitive-paths.test.ts` | Sensitive read-target denylist matching |
| `transcription.test.ts` | Audio transcription tool (`transcribe_audio`) logic |

Expected result: `pass 318, skip 1, fail 0`.

## Testing without exposing credentials

All secrets in tests are fabricated (`sk-FAKE…`, `AKIAIOSFODNN7EXAMPLE`, dummy PEM bodies). Follow that pattern; never paste a real credential into a test. For a live redaction check, put a fabricated key in a scratch file, `/context full`, and confirm it renders as `[REDACTED:…]`.

## Loader smoke (headless, already run)

Loading both entries through Pi's real extension loader must produce zero errors. `control-plane.ts` registers: commands `context, mode, effort, scratchpad, bwrap, control-ui, clear, control-reload, harness-rules`; shortcuts `alt+c, alt+e, alt+s, alt+h, alt+i, ctrl+alt+t, ctrl+alt+r, alt+p, shift+tab`; handlers `session_start, session_tree, before_agent_start, before_provider_request, tool_call, tool_result, agent_end, agent_settled, model_select, context, message_update, message_end`; two entry renderers. `model-picker.ts` registers: command `models`; shortcut `alt+m`; handlers `model_select` (usage tracking), `session_start` (startup picker). Reproduce with a small script calling `loadExtensions([...control-plane.ts], repoRoot)` from `@earendil-works/pi-coding-agent`'s loader module.

## Live smoke suite (headless, automated)

```bash
node tests/smoke/rpc-smoke.mjs
```

Drives a **real pi session** over RPC mode against the local llama-swap provider (`~/.pi/agent/models.json`, provider `llama-swap` on :9292). Override with `CP_SMOKE_MODEL=provider/model` or `CP_SMOKE_REPO=/path`. 13 checks: startup defaults (fresh session opens as Auto), the /mode command and status, Attended confirm dialog (denied blocks + nothing on disk; approved writes), dialog detail content, plan-mode blocking (phase-switch dialog offered and denied, no write), state persistence in the child's own session file, learned from `get_state` (entries present, content-free snapshot, no raw payloads), and restoration via `pi --session <file>`. Expected: `13/13 smoke checks passed`. Requires llama-swap running; each run costs a handful of short local-model turns.

## Manual smoke checklist (interactive TUI)

Most items below are covered headlessly by the RPC suite; the TUI-only remainder is dialog/widget rendering (step 6, `alt+c`) and hotkey delivery.

1. `pi` in any project → footer shows the mode segment (`Auto` on a fresh session) plus the context segment.
2. `/context` → summary renders; values are labeled, unknowns say `Unavailable`.
3. `/context diff` → first run states no previous snapshot exists and sets the baseline.
4. `/mode manual`, `/mode accept`, `/mode auto`, `alt+p` / `shift+tab` → status follows; invalid input (`/mode yolo`) prints usage.
5. In Plan, ask the model to write a file → blocked with rule `phase:plan` and an actionable hint; the phase-switch dialog offers the `/mode manual` transition.
6. `/mode manual` → the write pops a confirmation showing tool, risk, target, in-root flag (Yes/No/Always in the TUI). **Deny** → nothing on disk, model receives the denial.
7. Approve a retry → file written.
8. `/context toggle tool:bash` → bash disappears from the model's tool list (ask the model to run a command; it reports the tool unavailable).
9. Quit, `pi /resume` the session → mode and toggles restored.
10. Put `FAKE_API_KEY=sk-FAKEFAKEFAKEFAKEFAKE1` in a project file, `/context full` → shows `[REDACTED:…]`.
11. `grep -r "systemPrompt" ~/.pi/sessions/<session>.jsonl` → no raw system prompt/payload stored by the control plane (only hashes/lengths in its entries).

## Environment-dependent tests

- Steps 5–9 need a configured, reachable model provider (this machine: pi-llama expects a llama.cpp endpoint; point it at a running server or log into a provider first).
- Confirmation dialogs and the `alt+c` widget only exist in TUI mode. In print/RPC modes Attended blocks risky calls outright (fail-closed) — that is the expected behavior, not a bug.
- `alt+*` hotkeys depend on the terminal delivering Alt combinations (foot/kitty/alacritty fine; some terminals swallow Alt).
