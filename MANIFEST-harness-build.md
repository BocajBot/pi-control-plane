# Pi Harness build — file manifest

Every file created or edited while building the harness specified in
`ARCHITECTURE.md`. Paths are repo-relative and the archive preserves them, so
extracting over a checkout of `pi-control-plane` reproduces the build.

Validation at the time of packaging: `npm test` = **341 pass, 0 fail**;
`node tests/smoke/harness-smoke.mjs` = **17/17** against a live pi 0.84.1.

## Created (24)

### Harness core — `src/harness/`

| File | Role |
|---|---|
| `types.ts` | Every persisted state contract, plus the mode and actor vocabularies |
| `util.ts` | Ids, timestamps, device and project keys |
| `config.ts` | Runtime config and the section 28 storage layout |
| `project.ts` | Project-root inference (`.pi` > outermost VCS > package marker > cwd) |
| `scope.ts` | Scope as an authority object: symlink-safe checks, one-step expansion, narrowing |
| `policy.ts` | Constitutional rules, per-actor capability matrix, inheritance, `authorize()` |
| `audit.ts` | Audit-event construction — cannot write, cannot amend |
| `store.ts` | The only I/O module: atomic state writes, append-only JSONL |
| `state.ts` | Session lifecycle, checkpoints, recovery reconciliation |
| `workstate.ts` | `WORKSTATE.md` rendering |
| `memory.ts` | Promotion, supersession, active view |
| `records.ts` | Decision and incident constructors |
| `tasks.ts` | The explicit task queue |
| `sandbox.ts` | Shell boundary: scope-derived mounts, fail-safe refusal |
| `agents.ts` | Delegation contracts, handoff parsing, review prompt/parse |

### Wiring

- `extensions/pi-harness.ts` — the Pi extension entry point

### Tests

- `tests/harness-scope.test.ts` — S1–S6
- `tests/harness-policy.test.ts` — A1–A5, sections 21–22
- `tests/harness-records.test.ts` — M, D, I, T invariants
- `tests/harness-agents.test.ts` — SA1–SA5, MO4–MO5
- `tests/harness-state.test.ts` — AU1–AU5, R1–R5, storage, project inference, sandbox
- `tests/harness-extension.test.ts` — the real entry against a fake Pi API
- `tests/smoke/harness-smoke.mjs` — live smoke inside a real pi process

## Edited (6)

| File | Change |
|---|---|
| `ARCHITECTURE.md` | Section 29 rewritten to the real module paths (it described `src/index.ts` and `src/core/*`, which never existed); "Status as built" added under section 30 |
| `package.json` | Registered `./extensions/pi-harness.ts` in `pi.extensions` |
| `policy/profiles.json` | Added `pi_harness_bash` to the `minimal` profile — the harness removes builtin bash, and without this a session had no shell at all |
| `README.md` | Pi Harness section, file-map rows, limitations, test counts |
| `docs/TESTING.md` | Harness test tables, live smoke instructions, expected counts |
| `docs/ARCHITECTURE.md` | Cross-reference explaining how the two extensions divide and where they couple |
| `.gitignore` | `.pi/` — WORKSTATE is a recovery snapshot, not a tracked artifact |

## Not included, and needed to run

This archive is scoped to files this build touched. Two files it depends on
were **not** modified and are therefore absent:

- `src/control-plane/sandbox.ts` — `src/harness/sandbox.ts:30` imports
  `buildSandboxedCommand` and `shQuote` from it. Deliberate: one bwrap argv
  builder, not two.
- `src/control-plane/types.ts` — which that file imports for `SandboxState`
  and `SANDBOX_SCHEMA_VERSION`.

Extract over an existing `pi-control-plane` checkout and both resolve. To use
the harness standalone, either copy those two files across or inline the
~30-line command builder into `src/harness/sandbox.ts`.

The archive also carries no `node_modules`. `typebox` (declared in the
included `package.json`) must be installed, or the extension loads but
registers no tools — the guarded dynamic import degrades silently by design.

### Verified after packaging

Extracted to a clean directory, given only the two dependency files above and
`npm install`:

```
node --test "tests/harness-*.test.ts"   ->  135 pass, 0 fail
```

Without `typebox` present, 5 of those 135 fail — all of them tool-registration
tests. That is the documented degradation, not a packaging fault.

Also excluded, because they were already uncommitted before this build began
and are unrelated to it: the audio-transcription work
(`src/control-plane/transcription.ts`, `tests/transcription.test.ts`,
`bin/transcribe-voicemail.ts`, and the transcription edits to
`extensions/control-plane.ts`, `src/control-plane/tool-policy.ts`,
`tests/extension-harness.test.ts`, `tests/tool-policy.test.ts`).

## Known gaps

- `harness_delegate` and `/harness-review run` call `createAgentSession` and
  have never been executed against a live model.
- Delegate isolation relies on Pi constructing nested sessions in-process so
  `PI_HARNESS_DELEGATE_CONTRACT` is inherited. Re-check on Pi upgrades.
- The tool-call gate resolves targets from a fixed set of argument keys; a
  mutating tool with an exotic key is gated and audited, but its path is not
  scope-checked.
