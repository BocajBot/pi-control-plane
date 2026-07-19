# Testing

## Unit and harness tests

```bash
npm test          # = node --test "tests/*.test.ts"
```

No dependencies: Node 22's built-in test runner executes the TypeScript directly (native type stripping; verified on v22.22.3). 77 tests across seven files:

| File | Covers |
|---|---|
| `state.test.ts` | Safe defaults, serialization round-trip, malformed/unknown-schema rejection, compaction-safe restoration, guard-never-restored, cycle orders, no fallback above Read-only |
| `tool-policy.test.ts` | Classification, canonicalization (traversal, symlink escape, malformed paths — uses real temp dirs and symlinks), deny patterns, policy validation, the full phase × autonomy decision matrix, invalid-policy fallback |
| `redaction.test.ts` | Every redaction category with fabricated credentials; non-secret text preserved; determinism |
| `context-snapshot.test.ts` | Normalization stability, hash stability, no-raw-secret persistence, all diff categories, deterministic ordering |
| `interpretation.test.ts` | Prompt construction, delimiter neutralization (hostile input), section parsing, missing-heading invalidation, direct-brief non-fabrication, truncation |
| `toggles.test.ts` | Verified excision success/failure, skills-block replacement, toggle naming |
| `extension-harness.test.ts` | The real entry against a fake Pi API: attended deny-blocks/approve-allows, no-UI fail-closed, full `/interpret` guard lifecycle with diagnostics, cross-"session" restoration incl. tool toggles, sandboxed alias warning, injection block + verified excision + honest failure, hotkey cycling |

Expected result: `pass 77, fail 0`.

## Testing without exposing credentials

All secrets in tests are fabricated (`sk-FAKE…`, `AKIAIOSFODNN7EXAMPLE`, dummy PEM bodies). Follow that pattern; never paste a real credential into a test. For a live redaction check, put a fabricated key in a scratch file, `/context full`, and confirm it renders as `[REDACTED:…]`.

## Loader smoke (headless, already run)

Loading the entry through Pi's real extension loader must produce zero errors and register: commands `context, task, phase, autonomy, interpret`; shortcuts `alt+c, alt+p, alt+a`; handlers `session_start, before_agent_start, before_provider_request, tool_call, agent_end, agent_settled, model_select`; two entry renderers. Reproduce with a small script calling `loadExtensions([...control-plane.ts], repoRoot)` from `@earendil-works/pi-coding-agent`'s loader module.

## Live smoke suite (headless, automated)

```bash
node tests/smoke/rpc-smoke.mjs
```

Drives a **real pi session** over RPC mode against the local llama-swap provider (`~/.pi/agent/models.json`, provider `llama-swap` on :9292). Override with `CP_SMOKE_MODEL=provider/model` or `CP_SMOKE_REPO=/path`. 17 checks: startup defaults, phase/autonomy commands and status, Attended confirm dialog (denied blocks + nothing on disk; approved writes), dialog detail content, the `/interpret` guard (no tools, no dialogs, no files, completion notification), `/task accept`, Read-only blocking without dialogs, state persistence in the session file (entries present, content-free snapshot, no raw payloads), and restoration via `pi --continue`. Expected: `17/17 smoke checks passed`. Requires llama-swap running; each run costs a handful of short local-model turns.

## Manual smoke checklist (interactive TUI)

Most items below are covered headlessly by the RPC suite; the TUI-only remainder is dialog/widget rendering (steps 8, `alt+c`) and hotkey delivery.

1. `pi` in any project → footer shows `Phase: Discuss | Mode: Read-only | No task | Context …% full`.
2. `/context` → summary renders; values are labeled, unknowns say `Unavailable`.
3. `/context diff` → first run states no previous snapshot exists and sets the baseline.
4. `/task set try things` → status shows `Task accepted`.
5. `/phase plan`, `/phase execute`, `/phase verify`, `alt+p` → status follows; invalid input (`/phase yolo`) prints usage.
6. In Discuss, ask the model to write a file → blocked with rule `phase:discuss` and an actionable hint.
7. `/phase execute` (still Read-only) → same write blocked with rule `autonomy:read-only`.
8. `/autonomy attended` → the write pops a confirmation showing tool, risk, target, in-root flag. **Deny** → nothing on disk, model receives the denial.
9. Approve a retry → file written.
10. `/interpret <request that encourages tool use>` → no tool runs; blocked attempts appear as dim diagnostic lines; afterwards a notification says accept/reject.
11. `/task accept` → `Task: set`; next turn's behavior reflects the injected brief.
12. `/context toggle tool:bash` → bash disappears from the model's tool list (ask the model to run a command; it reports the tool unavailable).
13. Quit, `pi /resume` the session → phase, autonomy, task, and toggles restored.
14. Put `FAKE_API_KEY=sk-FAKEFAKEFAKEFAKEFAKE1` in a project file, `/context full` → shows `[REDACTED:…]`.
15. `grep -r "systemPrompt" ~/.pi/sessions/<session>.jsonl` → no raw system prompt/payload stored by the control plane (only hashes/lengths in its entries).

## Environment-dependent tests

- Steps 6–12 need a configured, reachable model provider (this machine: pi-llama expects a llama.cpp endpoint; point it at a running server or log into a provider first).
- Confirmation dialogs and the `alt+c` widget only exist in TUI mode. In print/RPC modes Attended blocks risky calls outright (fail-closed) — that is the expected behavior, not a bug.
- `alt+*` hotkeys depend on the terminal delivering Alt combinations (foot/kitty/alacritty fine; some terminals swallow Alt).
