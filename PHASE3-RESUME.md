# Phase 3 (Live Delegation Architecture) — COMPLETE

Statement A demonstrated: a real nested Pi child executed useful work while
its runtime capabilities, context, scope, and escalation behaviour stayed
inside an externally measured contract.

## Final state
- unit: 568/568 in-repo · 362/362 clean extract
- live: `harness-delegate-smoke.mjs` 41/41 (llama-swap/qwopus-35b-a3b-coder)
- artifact: pi-harness-isolated-0.3.0.tar.gz
  sha256 81609b9c14c9a82d15c74ac126e70ec73c56e4537e5bb72dbbfe7da76f006e70
  reproducible (byte-identical rebuild), clean extract verified
- evidence manifest emitted per live run (sha256 printed at run end)

## Architecture (the answer to the phase question)
Enforcement is the child's tools, not an extension inside the child. Measured
facts, pi 0.84.1: nested createAgentSession() LOADS every global extension but
never dispatches session_start, so an in-child harness gate is inert. An
explicit `tools` allowlist is exact; customTools work standalone; a
substituted ResourceLoader (built on Pi's createExtensionRuntime()) isolates
completely. So the child gets isolated resources + exact allowlist + three
inline read-only tools (scoped_read/scoped_list/request_read_scope) written
here, attested before first prompt and re-attested per tool call.

Key modules: src/harness/delegate-runtime.ts (openInScope pinned-fd auth,
buildDelegateTools, attestChild, attestCalls), src/harness/delegation-jobs.ts
(durable blocked/orphaned job lifecycle). Wiring in extensions/pi-harness.ts
harness_delegate.

## Live gates all passing (41/41)
D1 bounded delegation + per-call attestation + 5-section handoff (graded on
the tool result, not parent prose) + no fabrication + context isolation
(0 ambient extensions/skills/prompts/AGENTS, no sentinel leak). D2 boundary
enforced at the tool. D3 denied escalation persists + auditable. D4 approved
exact-root restart, provenance-linked, only the approved root widened. D5
parent crash -> child orphaned not running, no auto-duplicate, auditable.
D6 nested delegation refused by construction.

## TOCTOU (unit, worker-thread race)
177,550 reads / 4,000,000 symlink flips: naive check-then-open leaked 710x,
pinned-fd leaked 0. Naive control required to prove the window was exercised.

## Docs
BUILD_STATUS.md / VALIDATION.md / README-isolated.md updated: delegation
re-enabled under the constructed-child architecture; the wrong Phase 2.1
"Pi does not load extensions" wording corrected to "loads but never
initializes".

## Remaining honest limits
- one coordinator/child model family (llama-swap/qwopus); no hosted provider
- no real session on disk contains a compaction (reviewer axis covered by a
  Pi-shaped unit fixture only)
- semantic citation support remains unprovable mechanically (by design)
