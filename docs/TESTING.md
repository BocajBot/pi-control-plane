# Testing

## Unit and harness tests

```bash
npm test          # = node --test "tests/*.test.ts"
```

No dependencies: Node 22's built-in test runner executes the TypeScript directly (native type stripping; verified on v22.22.3). 484 tests across twenty-eight files:

| File | Covers |
|---|---|
| `state.test.ts` | Safe defaults, serialization round-trip, malformed/unknown-schema rejection, compaction-safe restoration, guard-never-restored, cycle orders (all six modes), no fallback above Read-only |
| `tool-policy.test.ts` | Classification (incl. `local_web_search` as read), canonicalization (traversal, symlink escape, malformed paths — uses real temp dirs and symlinks), deny patterns, policy validation (schema v2, `allowPathPrefixes`), the full phase × autonomy decision matrix incl. Unattended, out-of-root allowlist behavior, invalid-policy fallback |
| `redaction.test.ts` | Every redaction category with fabricated credentials; non-secret text preserved; determinism |
| `context-snapshot.test.ts` | Normalization stability, hash stability, no-raw-secret persistence, all diff categories, deterministic ordering |
| `context-editor.test.ts` | Context serialization/parsing round-trip, overlay merge/invalidation, edit application |
| `interpretation.test.ts` | Prompt construction, delimiter neutralization (hostile input), section parsing, missing-heading invalidation, direct-brief non-fabrication, truncation |
| `toggles.test.ts` | Verified excision success/failure, skills-block replacement, toggle naming |
| `profiles.test.ts` | Tool-profile validation, application, active-profile detection, `alwaysDisabledTools` (schema v2: applyAlwaysDisabled, "all" no longer meaning literally every tool, already-disabled/not-present edge cases) |
| `token-counter.test.ts` | Payload-format detection, message serialization for counting, count-endpoint dispatch (Anthropic vs OpenAI shaped payloads) |
| `ui.test.ts` | Status/mode display strings, footer stats formatting, context-warning thresholds, draft/added-context counters |
| `scratchpad.test.ts` | Note CRUD, truncation and capacity limits, strict validation, compaction-safe restoration, injection-block rendering (incl. the empty-scratchpad-renders-nothing rule) |
| `websearch.test.ts` | searxng URL building, response parsing (missing URL/results dropped gracefully), network/HTTP/JSON failure handling (caught, never thrown), result formatting |
| `transcription.test.ts` | Spoken-digit normalization (7/10/1+10 phone shapes, `oh`/`o` as zero, `double`/`triple` expansion, `hundred`, numerals joining a word-opened run) and — as importantly — every case it must *not* rewrite: prose containing digit words, non-phone-shape runs, a numeral seeding a run, a sentence boundary breaking one. Segment-join rules (hyphen-split number spliced without a space, leading punctuation not spaced). Transport: empty upload short-circuits before the network, transport/HTTP/JSON failures caught not thrown, silence reported as an explicit failure |
| `extension-harness.test.ts` | The real entry against a fake Pi API: attended deny-blocks/approve-allows, no-UI fail-closed, full `/interpret` guard lifecycle with diagnostics, cross-"session" restoration incl. tool toggles, sandboxed alias warning, injection block + verified excision + honest failure, hotkey cycling through all six modes, `/scratchpad` end-to-end incl. system-prompt injection, `local_web_search` tool registration, `transcribe_audio` sequential registration and Pi-native `AgentToolResult.content` shape on its missing-file path (no network needed), Unattended's task-brief gate and per-call audit logging |

The Pi Harness (`ARCHITECTURE2.md` at the repo root) adds twelve more files.
They are organized by *acceptance invariant* rather than by function, because
the invariants in section 27 of that spec are the thing worth protecting — a
test named after the rule it defends fails in a way that says what broke:

| File | Covers |
|---|---|
| `harness-scope.test.ts` | S1-S6: smallest initial scope; exactly one automatic next-boundary expansion, spent not renewed; user approval not refilling it; `$HOME` and `/` refused as boundaries; symlink escape caught despite a matching string prefix; unresolvable and NUL-containing paths denied; delegation narrowing that strips the parent's unspent expansion |
| `harness-policy.test.ts` | A1-A5 and sections 21-22: audit rewrite refused for *every* actor including the user; hard policy refused for every actor except the user; coordinator refused global-memory promotion at all four approval settings; advisor read-only; subagent read-only in MVP; unknown actor denied by default; approval and autonomy gates; user approval not unlocking a constitutional refusal; inheritance that tightens but never weakens |
| `harness-records.test.ts` | M1-M6, D1-D4, I1-I6, T1-T4: promotion authority; uncited reviewer promotion refused; supersession retaining the old content; decision without rationale and temporary decision without a revisit condition both refused; reopening leaving the original untouched; observed effect kept separate from suspected cause; similar-incident matching by cause and model rather than by wording; a task's frozen authority envelope; claimed vs validated completion |
| `harness-agents.test.ts` | SA1-SA5 and MO4-MO5: fully populated contracts; child scope outside the parent refused; autonomy and approval intersected downward; capabilities capped by delegate kind with the drop reported; handoff parsing including a blocked delegate and a malformed reply; review proposals dropping uncited memory candidates |
| `harness-state.test.ts` | AU1-AU5 and R1-R5, against a real temp directory: append-only accumulation; a truncated final line reported as *uncertain* rather than failed, with the intact prefix kept; atomic writes leaving no partial file; unknown schema versions rejected for state but preserved for audit evidence; project-root inference precedence; the sandbox refusing without bubblewrap; recovery that reports conflicts instead of resolving them |
| `harness-continuity.test.ts` | Sections 13, 17, 21-22: soft policy surviving a restart and still binding `authorize()`; layers resolving broadest-first with a child unable to relax a parent; the coordinator able to tighten but not loosen; goals scoped and prioritized; a goal surfacing tension **without** changing an authorization outcome; a project link granting no scope; identity writable only by the user, deduplicated, and rendering nothing when empty |
| `harness-extension.test.ts` | The real harness entry against a fake Pi API: builtin shell dropped from the tool set *and* blocked at the `tool_call` seam after another extension restores it; out-of-scope path blocked; approval prompt on an in-scope write and fail-closed with no UI; session start and denials audited without touching earlier lines; task creation only by explicit command; compaction flushing WORKSTATE; close queueing a review without running it; a crashed previous session surfacing as interrupted work. Plus the v0.2 wiring: per-session state and the global index, the second session not overwriting the first, per-session WORKSTATE copies, an unconfined tool withheld and named, a declined exception refusing the call, a delegate refused an exception outright, posture tightening allowed while loosening fails closed, an invalid posture value refused rather than written, and a v0.1 log anchored rather than retroactively claimed as protected |

The v0.2 integration-hardening delta (section 32) adds five more:

| File | Covers |
|---|---|
| `harness-audit-chain.test.ts` | AU1 with cryptographic weight: a v0.1-only file verifies as an all-legacy prefix with `verifiedCount 0`; the first chained event anchors to that exact prefix digest; editing any field of any chained event fails verification *at that index*; reorder, mid-delete and forged insert all refused; a truncated tail still verifies the surviving prefix; digests insensitive to JavaScript key insertion order |
| `harness-capability.test.ts` | TO1-TO5 and section 32: an opaque tool catalogued but not active; unconfined labelled unconfined and never sandboxed; only the user may grant an exception; the builtin shell unreachable through one; a reasonless or no-op grant refused; the active set computed rather than filtered; and a drift guard asserting every tool the extension registers is declared |
| `harness-memory-scope.test.ts` | Section 32: a project-A memory not returned while working in project B (asserted as absence *and* as presence in A, so it cannot pass vacuously); global returned everywhere; project scope with no root refused; global scope carrying a project refused; supersession across scopes refused; a v0.1 entry upgrading to global |
| `harness-review-contract.test.ts` | Section 32's three conditions: an item citing an id that does not occur in the session rejected — with an in-test control proving the fabricated id *does* parse as well-formed, so the refusal comes from set membership and not from shape; uncited items rejected per class; a short read failing acceptance even with perfect citations; malformed output failing shape validation; `rejectedItems` preserved verbatim; generation sequencing |
| `harness-recovery-v2.test.ts` | Section 32 recovery: two sessions in one project both surviving (with the v0.1 single-snapshot collision asserted as an explicit control); the index resolving a session id to its project; the legacy file read but never rewritten; per-session workstates; audit appends chaining, and the tip advancing in memory rather than re-reading |

Expected result: `pass 484, fail 0`.

`VALIDATION.md` at the repo root records the ablations run against these — a
green check with no ablation is only evidence that it is green.

### Live harness smoke (headless, needs pi + llama-swap)

```bash
node tests/smoke/harness-smoke.mjs        # 17 checks against a real pi process
```

Runs in a throwaway project with `PI_HARNESS_HOME` pointed at a temp
directory, so it never touches real harness state. It checks that pi loads the
extension, that `/harness` commands answer, that the section 28 layout appears
on disk, that session start is audited, that the builtin shell is gone from
the model's live tool list while `pi_harness_bash` is reachable, that a write
outside the scope root is denied and audited, and that session close writes
`.pi/WORKSTATE.md`.

Two of its checks are worth understanding before editing them, because both
started out measuring the wrong thing:

- **The shell check asks the model to list its tools** rather than waiting for
  a bash denial. The denial never fires: the model has no bash tool to call,
  which is the mechanism succeeding, not failing. The check is only decisive
  because `policy/profiles.json`'s `minimal` profile *grants* bash — so if the
  live list lacks it anyway, the harness is what removed it.
- **The scope check approves at the control plane's confirmation prompt.** Pi
  short-circuits `tool_call` on the first blocking handler, so declining there
  ends the call before the harness ever sees it and proves nothing about the
  harness. Approving forces the harness to catch the out-of-scope write on its
  own, which is the property under test.

### Live check for `transcribe_audio` (needs llama-swap running)

The unit tests deliberately never touch the network, so the ASR path itself is checked by hand. Regenerate the phone-band fixture — espeak through a µ-law 8kHz round trip, which is what a real voicemail has been through — and run it end to end:

```bash
espeak-ng -v en-us -s 150 -w /tmp/vm_raw.wav \
  "Please give me a call back at five five five, one two three, four five six seven. \
   Or reach the office at eight one two, five five five, zero one nine nine, extension four four seven one."
ffmpeg -y -i /tmp/vm_raw.wav -ar 8000 -ac 1 -c:a pcm_mulaw -f wav /tmp/vm8k.wav
ffmpeg -y -i /tmp/vm8k.wav -ar 16000 -ac 1 /tmp/voicemail.wav

./bin/transcribe-voicemail.ts /tmp/voicemail.wav
```

Every callback number in the output must be digits. The same fixture also exercises the Hermes side (`python3 -c "from tools.transcription_tools import transcribe_audio; print(transcribe_audio('/tmp/voicemail.wav'))"` from `~/.hermes/hermes-agent`) and llama-swap dispatch directly (`curl -F file=@/tmp/voicemail.wav -F model=whisper-voicemail http://127.0.0.1:9292/v1/audio/transcriptions`).

## Testing without exposing credentials

All secrets in tests are fabricated (`sk-FAKE…`, `AKIAIOSFODNN7EXAMPLE`, dummy PEM bodies). Follow that pattern; never paste a real credential into a test. For a live redaction check, put a fabricated key in a scratch file, `/context full`, and confirm it renders as `[REDACTED:…]`.

## Loader smoke (headless, already run)

Loading the entry through Pi's real extension loader must produce zero errors and register: commands `context, task, brief, mode, interpret`; shortcuts `alt+c, alt+p`; handlers `session_start, before_agent_start, before_provider_request, tool_call, agent_end, agent_settled, model_select`; two entry renderers. Reproduce with a small script calling `loadExtensions([...control-plane.ts], repoRoot)` from `@earendil-works/pi-coding-agent`'s loader module.

## Live smoke suite (headless, automated)

```bash
node tests/smoke/rpc-smoke.mjs
```

Drives a **real pi session** over RPC mode against the local llama-swap provider (`~/.pi/agent/models.json`, provider `llama-swap` on :9292). Override with `CP_SMOKE_MODEL=provider/model` or `CP_SMOKE_REPO=/path`. 17 checks: startup defaults, the /mode command and status, Attended confirm dialog (denied blocks + nothing on disk; approved writes), dialog detail content, the `/interpret` guard (no tools, no dialogs, no files, completion notification), `/brief accept` (the collision-free /task alias), verify-mode blocking without dialogs, state persistence in the session file (entries present, content-free snapshot, no raw payloads), and restoration via `pi --continue`. Expected: `17/17 smoke checks passed`. Requires llama-swap running; each run costs a handful of short local-model turns.

## Manual smoke checklist (interactive TUI)

Most items below are covered headlessly by the RPC suite; the TUI-only remainder is dialog/widget rendering (steps 8, `alt+c`) and hotkey delivery.

1. `pi` in any project → footer shows `Phase: Discuss | Mode: Read-only | No task | Context …% full`.
2. `/context` → summary renders; values are labeled, unknowns say `Unavailable`.
3. `/context diff` → first run states no previous snapshot exists and sets the baseline.
4. `/task set try things` → status shows `Task accepted`.
5. `/mode plan`, `/mode execute`, `/mode verify`, `alt+p` → status follows; invalid input (`/mode yolo`) prints usage.
6. In Discuss, ask the model to write a file → blocked with rule `phase:discuss` and an actionable hint.
7. `/mode execute` → the write pops a confirmation showing tool, risk, target, in-root flag. **Deny** → nothing on disk, model receives the denial.
9. Approve a retry → file written.
10. `/interpret <request that encourages tool use>` → no tool runs; blocked attempts appear as dim diagnostic lines; afterwards a notification says accept/reject.
11. `/task accept` (or `/brief accept`) → `Task accepted`; next turn's behavior reflects the injected brief.
12. `/context toggle tool:bash` → bash disappears from the model's tool list (ask the model to run a command; it reports the tool unavailable).
13. Quit, `pi /resume` the session → mode, task, and toggles restored.
14. Put `FAKE_API_KEY=sk-FAKEFAKEFAKEFAKEFAKE1` in a project file, `/context full` → shows `[REDACTED:…]`.
15. `grep -r "systemPrompt" ~/.pi/sessions/<session>.jsonl` → no raw system prompt/payload stored by the control plane (only hashes/lengths in its entries).

## Environment-dependent tests

- Steps 6–12 need a configured, reachable model provider (this machine: pi-llama expects a llama.cpp endpoint; point it at a running server or log into a provider first).
- Confirmation dialogs and the `alt+c` widget only exist in TUI mode. In print/RPC modes Attended blocks risky calls outright (fail-closed) — that is the expected behavior, not a bug.
- `alt+*` hotkeys depend on the terminal delivering Alt combinations (foot/kitty/alacritty fine; some terminals swallow Alt).
