# Pi Harness v0.3 — remaining provisional claims

Referenced by `ARCHITECTURE2.md` section 32. `VALIDATION.md` records what was
executed; this file records what was **not**, and what is therefore still
being asserted rather than shown.

Section 31 says the correct next maturation signal is evidence that the
invariants survive real sessions, not more features. Everything below is a
place where that evidence does not yet exist.

---

## 1. Executed under v0.2, but not against a live model

**Closed in v0.2.1: the retrospective evidence contract has now gated a live
reviewer, and accepted it.** This section previously said the gate had never
faced a real reviewer, and named the risk: not that it fails open, but that it
fails *closed* on every real reviewer, killing the learning loop in a way unit
tests cannot show. That risk was real. The first live run rejected a review
whose content was fine, for three reasons that were all the harness's own:
the prompt was returned as part of the reply and parsed into phantom items,
the transcript header printed a session id the reviewer then cited on
everything, and the parser could not read the `## FINDINGS` heading style the
model actually used. All three are fixed and guarded. `VALIDATION.md` section
6 has the run.

That risk is now closed by evidence rather than by argument: **three live
reviews, three models, two model families, two session lengths, all
accepted** — an 11-line synthetic session and a 52-line real one carrying 20
tool calls, a failed tool call and a model change. Citation diversity was
total in both stressed runs (23 items / 23 distinct entry ids, 24 / 24), so
the gate is not being satisfied by padding.

What remains unproven is narrower. **No real session on disk contains a
compaction**, so a reviewer has never read one; that entry type is covered by
a unit test on an entry in Pi's real shape, not by a live review. Every model
tested so far is a local llama-swap model — no hosted provider has reviewed
anything. And the deepest limit is unchanged and unfixable mechanically: the
gate can verify that a cited id belongs to the session, never that the entry
supports the claim attached to it. A reviewer that cites loosely still fails
closed, by design.

**Closed in v0.3: bounded read-only delegation now has a measured enforcement
boundary.** The failed inherited-extension design remains historical evidence
in `VALIDATION.md`; the replacement uses an isolated loader and inline tools,
and passed the real lifecycle described in section 3.

## 2. What the adversarial pass did not close

**Reviewer citation relevance.** The evidence gate checks that every cited id
belongs to the session that was read. It cannot check that the cited entry
*supports* the claim, so one real id attached to eight unrelated assertions
is accepted. The pattern is flagged (`uniformCitation`) and printed as a
warning, and that is the whole defense. Judging relevance needs a reader.

**Audit integrity has a threat-model ceiling.** The hash chain plus the
endpoint commitment detect in-place edits, tail deletion and wholesale
rewriting *by anything that does not update both artifacts consistently* -
which covers accidents, crashes, and a model, but not an attacker with write
access to the harness home. The real boundary is that the harness home is
outside every project scope, so no scope-checked tool call can reach it. Do
not describe this as tamper-proof.

**Coordinator builtin-tool TOCTOU remains outside this package's control.**
Delegated reads are descriptor-pinned and race-tested. Pi's own builtin tools
still execute after the extension's pathname check, so the coordinator seam
retains a check/open window; v0.3 does not claim otherwise.

**A "corrupt" line can hide data.** `readJsonl` drops an unparseable middle
line and counts it as `invalid`; verification runs over the parsed records,
so the file can contain a line the verifier ignores. The count is reported,
the content is not.

## 3. Known-unrepaired, by decision

**Cross-process audit appends are serialized (v0.3.1).** This section
previously said simultaneous appends fork the chain and that no lock existed.
That was true and is now fixed. The three claims, kept distinct on purpose:

- *Defended.* Two harness processes on one host appending to the same chain
  no longer fork it. `appendAudit` runs the whole read-tip → chain → append →
  commit transaction inside an exclusive `O_EXCL` lock file, and re-derives
  its predecessor from the log **inside** the lock rather than from a
  per-process cache — the cache being the original fork's root cause.
  Reproduced pre-fix (32 concurrent appenders → 3 prevHash collisions,
  `verifyAudit` broke at event 12) and closed post-fix (32/32, one linear
  chain). Covered by a real multi-process regression test
  (`tests/harness-audit-concurrency.test.ts`) and four discriminating
  mutations (remove the lock; use the cached tip; make a live lock stealable;
  disable stale recovery — each fails the matching test).
- *Detectable but not prevented.* A crash between the JSONL append and the
  tip commit leaves the tip *behind* the log. That is reported as behind — a
  benign, expected state — and the next locked append reconciles it. The
  opposite direction (tip ahead of the log) is reported as the tail having
  been removed. A torn or malformed final line is counted, never silently
  dropped. None of these are auto-repaired into an ambiguous history; they
  are surfaced.
- *Explicit trust ceiling.* The lock defends against concurrent and crashing
  *harness* writers, not against an adversary. Anyone with unrestricted write
  access to the harness home can rewrite the audit log, the tip commitment,
  and the lock itself, and no local mechanism can stop that. The hash chain
  is tamper-**evident** against anything that does not update both artifacts
  consistently; it is not tamper-**proof**, and closing that gap needs an
  external authenticated commitment, which is out of scope. Do not describe
  the local chain as tamper-proof.

The lock's operating assumptions: local-filesystem `O_EXCL` semantics (NOT
safe on NFS/network filesystems); a lock older than 30s is treated as a dead
owner and broken; acquisition throws after 5s rather than proceeding
unlocked; a process that dies holding the lock is recovered by the next
writer via the stale-break.

**The session index is repaired, with stated limits.** This section previously
said `upsertSessionIndex` was an unguarded read-modify-write that could lose a
row, and that neither concurrency defect was covered by a test. That is no
longer accurate. `upsertSessionIndex` now performs its read-modify-write
inside `withFileLock`, and two tests cover it: an interleaved-upsert guard,
and a rebuild guard. It was reproduced first — 60 simultaneously spawned
processes lost 14 rows, while 60 spawned sequentially lost none, so the
obvious test would have shown the defect absent.

The lock's limits, which are real:

- It is an `O_EXCL` lockfile. That is atomic on a local filesystem and is not
  reliable on NFS, where `O_EXCL` create is famously not atomic.
- Acquisition times out after 5s and **throws**. A caller under sustained
  contention gets an exception, not a silent skip — which is the right
  failure, but it is a failure.
- A lockfile older than 30s is broken rather than waited on, on the
  assumption its holder died. A process stalled longer than that can have its
  lock stolen, reopening the original race for one window.
- It covers `upsertSessionIndex` only. It is not a general store lock, and in
  particular it does not cover the audit chain above.

The index remains derived, and `rebuildSessionIndex()` still repairs it by
scanning `sessions/`. That is the actual guarantee: the lock narrows the
window, and rebuildability is what makes a lost row survivable.

**Extension ordering remains load bearing.** Pi short-circuits `tool_call` on
the first blocking handler, and the control plane is registered first. Calls
it blocks never reach the harness and are absent from the harness audit log;
calls it allows are still independently checked. The composition is
fail-closed — neither extension can grant what the other denies — but the
harness log records what the harness saw, not every attempt.

**The tool-call gate resolves a target from a fixed set of argument keys**
(`path`, `file_path`, `filePath`, `filename`, `file`, `target_file`, `dir`,
`directory`). Under v0.2 this matters less than it did: an unrecognized tool
is now classified `unconfined` and needs a per-session user exception before
it can run at all. The residual gap is an exotic-argument mutating tool that
the user has granted an exception for — it is gated, prompted and audited,
but its path is not scope-checked.

**Delegation is enabled only through the constructed v0.3 child boundary.**
The earlier inherited-extension design failed and is not reinterpreted as a
pass. Corrected Pi 0.84.1 facts: a default nested session had 34 active tools
including `bash` and `harness_delegate`, 10 ambient extensions, 11 skills and
the project's AGENTS file. Pi loaded extensions, contrary to the old wording,
but did not initialize the harness session lifecycle; its gate was inert.

The accepted child instead had exactly `scoped_read`, `scoped_list`, and
`request_read_scope`, with zero ambient extensions, skills, prompt templates,
or context files. A real child completed useful work and returned all five
handoff sections. Every actual invocation was attested before and after.

The live lifecycle passed **41/41** enforcement-level checks: malformed-child
rejection before prompt; useful bounded work; block and denial without a
content leak; exact-root user approval; a provenance-linked replacement with
unchanged posture/tools; SIGKILL while durably running followed by explicit
orphaning and no duplicate; and nested-delegation refusal.

Limits are deliberate. Pi cannot pause/resume the same nested AgentSession;
approval starts a replacement linked to the blocked contract. A child cannot
write, shell, use network, discover capabilities, mutate policy, or delegate.
Descriptor-pinned reads are Linux-specific. Evidence covers Pi 0.84.1 and the
tested local model, not every future runtime or provider.

## 4. Behaviour changes a user will notice

**Capability authority withholds tools that used to be active.** The active
set is now computed from the catalog rather than inherited, so any tool that
is not a scope-aware builtin or a harness tool is catalogued but inactive
until the user grants a per-session exception. In this repository that
includes `local_web_search` and `transcribe_audio`, which are the control
plane's tools and therefore opaque from the harness's side. This is what
section 32 specifies, and the withheld list is printed at session start and
audited, but it is a real change to what works out of the box.

`/harness capability` lists the catalog; `/harness capability grant <tool>
<reason>` activates one for the session.

**A capability exception dies with the process.** There is deliberately no
persistence for it. A grant that survived into the next session would be a
durable authority expansion created by one in-conversation "yes".

**A project-scoped memory promotion now requires stated authority.** Any call
site must pass `PromotionAuthority` naming the project it is entitled to
write; an unstated authority is refused rather than read off the draft. This
is a breaking change to `promote()` and `supersede()` for external callers,
and it is deliberate - the parameter exists so a new call site cannot forget
to state its authority, only state it wrongly, which is visible in the diff.

## 5. Schema

`HARNESS_SCHEMA_VERSION` is now `2`; readers accept `[1, 2]`. v0.1 records
load, and the fields v0.1 lacked are filled with explicitly conservative
defaults at the point of use rather than by a migration pass:

- a v0.1 `ScopeState` has no ceiling; `defaultCeiling()` gives it exactly one
  boundary out, which is the authority v0.1 actually granted under S2;
- a v0.1 `MemoryEntry` becomes `global`, because v0.1 had one undifferentiated
  memory file and returned every entry everywhere — global preserves the
  behaviour that was in force, whereas defaulting to project would
  retroactively invent a binding nobody recorded;
- a v0.1 `AuditEvent` keeps `hash: null` forever.

`CANONICAL_FIELDS` in `audit.ts` is tied to the schema. A field added in a
later version must be appended there, and records written by that later
harness will then fail verification in this one. That must be surfaced as
"this reader cannot verify these", never as tampering.

## 6. The isolated artifact's live smoke has not been run as the isolated package

`npm run smoke` inside the extracted package would spawn `pi`, which loads
extensions from `~/.pi/agent/settings.json` — pointing at the in-repo package,
not the extracted one. So running it there would report on the repository's
copy while appearing to validate the artifact, which is worse than not running
it. The two trees are generated from the same sources by
`bin/build-isolated.mjs`, but the *packaged* extension has not itself been
loaded by Pi.

To do it properly: point `settings.json` at the extracted directory, then run
`npm run smoke` from inside it.

**Correction (v0.2.1).** This section previously said "the artifact's 299 unit
tests pass from a clean extract". That was false as written. A genuinely clean
extract has no `node_modules`, and 6 of the 299 failed there — the same 6 that
passed in the repository. The claim had been checked in a tree where the
repository's dependencies were resolvable, which is not a clean extract.

The cause is not a packaging error and not a code defect: every harness tool
is registered inside `if (TypeBoxType !== null)`, so an uninstalled `typebox`
registers no tools at all. With the declared dependency installed, the v0.2.1
artifact passes 332/332 from a clean extract.

**Current v0.3 evidence.** The isolated package passes **362/362** tests after
a genuinely clean extraction and installation of its one declared dependency.
Two new source-wiring guards initially failed only in the isolated layout
because they opened repository paths directly. That packaging-instrument
defect was fixed without changing either assertion, and the clean suite was
rerun from a newly built archive.

Two things changed as a result. The correct procedure is now `tar -xzf … &&
npm install && npm test`, and it is stated in the artifact's README. And the
degradation is no longer silent: a session that starts with no `typebox`
emits `Harness: degraded` and audits it, because the previous behaviour was a
harness that loaded, blocked the builtin shell, registered no replacement for
it, and said nothing.

## 7. Layout note

`ARCHITECTURE2.md` section 29 describes the harness as its own package
(`src/index.ts`, `src/agents.ts`, `src/types.ts`, `src/core/*.ts`). That is
exactly the layout of the isolated artifact, which `bin/build-isolated.mjs`
produces mechanically from this repository.

In-repo the harness lives as a second extension inside `pi-control-plane`
(`extensions/pi-harness.ts` + `src/harness/*.ts`), because that is how it
actually ships — through a package already listed in `~/.pi/agent/settings.json`.
The mapping between the two is a build step rather than a second copy of the
tree, so the two cannot drift.
