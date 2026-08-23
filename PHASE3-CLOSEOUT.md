# Phase 3 Closeout — Packaged-Artifact Acceptance + Audit Serialization

Final report. Freeze candidate: **v0.3.2**. Artifact
`pi-harness-isolated-0.3.2.tar.gz`
sha256 `db2fc99a5c340df149f28d07013ff4688935077899fd2ac1b81f335dc1f24319`,
built reproducibly from the tag's tree (shipped inputs finalized at `7220850`).

## §1 Immutable starting provenance
- baseline commit: `a8475902ec8a83ccec2ea90c9630da3dd8e62a3c`
- pi-harness-isolated-0.3.0.tar.gz sha256 `81609b9c14c9a82d15c74ac126e70ec73c56e4537e5bb72dbbfe7da76f006e70` — verified, MATCHES the expected hash.
- Pi 0.84.1 · Node v22.22.3 · Linux 7.2.0-1-cachyos-kfdfix x64
- baseline in-repo unit 568/568; live baselines harness 25/25, delegate 41/41, reviewer corpus 66/66.
- No uncommitted Phase 2/3 work was lost; it was committed in `fa25560` (v0.3.1) and built upon.

## Two gaps closed
1. **Cross-process audit serialization** (§4–9) — landed in v0.3.1 (`fa25560`/`7cbd7c8`).
2. **Packaged-artifact live acceptance** (§2/§3) — this pass, which also uncovered and fixed a
   review-contract defect, producing **v0.3.2**.

---

## Audit serialization (§4–9) — v0.3.1
- **§4 counterexample:** 32 concurrent appenders reproduced the fork — 3 predecessor collisions, chain broke at event 12 (per-process cached tip). Recorded in VALIDATION §10.
- **§5 fix:** `appendAudit` wrapped in `withFileLock` (O_EXCL lockfile, 5s timeout, 30s stale-break, `Atomics.wait` sleep) and re-derives the predecessor from disk inside the lock. Narrowest correct layer: the single append seam.
- **§6 crash windows:** `checkAuditTip` treats tip-behind-log as consistent (benign second-writer/crash direction); a truncated/malformed final JSONL line is reported invalid rather than silently accepted.
- **§7 regression:** `tests/harness-audit-concurrency.test.ts` — **N=12 real spawned OS processes** → N events in one valid linear chain (re-verified this pass: `# pass 6 # fail 0`).
- **§8 mutations:** 4 discriminating ablations (remove lock, release-before-update, live-lock steal, disable stale recovery) each break the property; the lock-removal mutation reproduces the fork.
- **§9 doc reconciliation:** BUILD_STATUS §3 / VALIDATION §10 classify the audit chain as Defended (concurrent forks) / Detectable-but-not-prevented (offline tampering) / Explicit-trust-ceiling (no distributed consensus; local FS only; NFS unsupported). The local hash chain is **not** called tamper-proof.

## The v0.3.2 defect — found by live packaged testing (§2/§3)
Live-testing the ACTUAL packaged artifact (the highest-priority gap) exposed a real defect that
every in-repo unit test missed because the unit tests inject a canned reviewer reply:

- **Symptom:** the first live packaged reviewer run (`qwen3-8-27b`) returned `accepted=true` but
  `rawReply=""`, 0 proposals — a **vacuous** acceptance.
- **Root cause (primary evidence, nested session JSONL):** the reviewer's assistant message was a
  single `thinking` part with **no text**, `stopReason=length`, `output=8192` — the reasoning model
  spent its entire output budget thinking and never answered. Pi's `thinkingLevel:off` did not reach
  the model's jinja template. Discriminating control: the same model called directly with
  `enable_thinking:false` returns well-formed content.
- **The contract defect:** `checkReviewEvidence` accepted the empty reply — an empty parse passes
  shape (empty is well-formed), citations (nothing to cite) and the read. "The reviewer said nothing"
  was being recorded as "the reviewer found nothing", the two facts §19 insists are distinct.
- **Fix (`672d839`):** a distinct `reviewProduced` precondition. A blank/absent reply is refused; a
  non-blank reply that proposes nothing stays a legitimate empty review; callers exercising the
  citation logic directly omit the reply and are unaffected. +4 unit tests (28/28). Full suite 579/579.

## Packaged-artifact acceptance evidence (§2/§3)
All runs loaded the artifact via `PI_CODING_AGENT_DIR` → a throwaway agentdir whose `settings.json`
`packages` points at the extracted tarball; `PI_HARNESS_HOME` and the project were throwaways. The
user's `~/.pi/agent` was not modified.

- **Load provenance (§2 engagement marker):** ablation — moving the packaged extract aside made
  `/harness` **unavailable** under the same env, with no fallback to repo source. The resolved
  extension path is therefore the packaged tarball extract, not the in-repo tree.
- **Reviewer, accepted (Test F, thinking off):** `accepted=true`, `reviewProduced=true`, read 52/52,
  **24 grounded proposals, 0 uncited**, 6390-char reply. A meaningful accepted retrospective review
  from the packaged artifact.
- **Reviewer, empty rejected (Test D, thinking on):** the same empty-reply input v0.3.1 accepted is
  now `accepted=false`, reason "the reviewer produced no output" — the fix engaging live.
- **Coordinator standalone (14/14):** `tests/smoke/harness-coordinator-standalone.mjs` — extension
  loads and answers `/harness status|authority|capability`; builtin bash absent + sandboxed shell
  present; audit chain verifies live; per-project layout + non-authoritative WORKSTATE on disk.
- **Bounded delegation (41/41):** delegate smoke against the packaged extract (run `bXRlpL`); manifest
  sha matches `rawRunManifestSha256` in PHASE3-EVIDENCE.json.
- **Model note:** per user instruction the reviewer model is `llama-swap/qwen3-8-27b`. Every qwen3.8
  alias is a reasoning model; `--chat-template-kwargs '{"enable_thinking":false}'` was added to that
  model's llama-swap config (the user's infra, backed up) so its answer reaches Pi. This is
  configuration, not harness code, and is not part of the artifact.

## §10 Commit + tag
- `672d839` — the contract fix (6 files, diff leak-scanned: no machine paths, credentials, or temp evidence).
- `26c8d7d` — the standalone coordinator acceptance smoke.
- tag **v0.3.2** at `26c8d7d` (the exact commit the shipped artifact is built from). No prior history rewritten.

## §11 Reproducible artifact
- Two builds from the committed tree yield the identical SHA
  `db2fc99a5c340df149f28d07013ff4688935077899fd2ac1b81f335dc1f24319` (`--sort=name --mtime=@0`, `gzip -n`).
- Its extension bytes (`src/index.ts`, `src/agents.ts`, `src/types.ts`, `src/core/store.ts`) are
  byte-identical to the extract exercised by the live checks above — so the live evidence applies to
  this exact artifact.

## §12 Acceptance-instrument self-audit
A 6-agent adversarial workflow verified each claimed gate has a real executable scenario that was
actually run (guarding the earlier D3/OA-19 "declared but not run" error). Outcomes:
- audit-serialization, empty-review-reject, delegate-bounded, coordinator-standalone, reviewer-accept:
  each backed by a runnable test/smoke and an executed result.
- The audit flagged two things, both resolved here: (a) it doubted "packaged" provenance for the
  reviewer run — **refuted** by the load-provenance ablation (it had inspected the un-redirected
  `~/.pi/agent/settings.json`); (b) it found the shipped tarball didn't rebuild — **because the tree
  had gained the new smoke after the build**; committing it and rebuilding produced the reproducible
  `db2fc99a` above.
- Known, honestly-scoped limitations (not silenced): the pre-fix audit-fork reproduction lives as
  prose in the test docstring, not as a committed executable; `harness-smoke.mjs` cannot run against
  the standalone package (its startup handshake needs the control plane), which is why the standalone
  coordinator smoke exists; standalone project-root inference resolves to the nearest `.pi`/VCS
  ancestor (pre-existing project.ts precedence — §13 out of scope for redesign; a pi-initialised
  project anchors correctly).

## §13 Scope discipline — not done
No write-capable subagents, nested delegation, network children, semantic entailment in the review
gate, hosted providers, external audit anchoring, redesign of Pi builtins (including project-root
inference), or autonomous learning. The empty-reply check is mechanical ("did the reviewer answer"),
not semantic.

## Freeze criteria
- [x] coordinator + reviewer + bounded subagent verified live under real Pi
- [x] same behavior confirmed from the packaged artifact (load provenance proven by ablation)
- [x] cross-process audit serialized, with a real multi-process regression test
- [x] artifact reproducible (identical SHA from two builds) and traceable to committed, tagged source
- [x] source committed + tagged (v0.3.2 @ 26c8d7d)
- [x] every claimed live gate has an executable scenario with a recorded result

**Control plane is ready to freeze at v0.3.2.**
