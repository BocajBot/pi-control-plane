# Design: backup-before-edit hard rule

**Status:** implemented (see `src/control-plane/backup.ts`, wiring in `extensions/control-plane.ts`)
**Companion to:** the existing `read-before-edit` hard rule in `extensions/control-plane.ts`
**Motivation:** today Pi guarantees *read → edit* but never *backup → edit*. The only
rollback path is an out-of-band git repo or a manual `.bak`. This adds the missing
step: before the first mutation of an existing file in a session, snapshot its
pre-edit contents to a durable, reviewable backup.

---

## 1. Goal and non-goals

**Goal.** A model (attended or unattended) cannot modify an existing file without a
recoverable copy of that file's exact pre-mutation bytes existing on disk first. The
backup must be:

- **Correct:** byte-identical to the file as it was at mutation time (not "as it was
  when last read").
- **Durable:** outside `/tmp` and any path a benchmark/sandbox could wipe.
- **Reviewable:** findable, attributable (which session, which tool, when), and never
  silently overwritten by a later edit in the same or a different session.

**Non-goals.**

- Not a substitute for version control. Git remains the primary rollback path; this is
  a safety net for files/dirs that are not under git, and for edits made before anyone
  thinks to commit.
- Not a backup of shell-mediated mutations (`bash`/`pi_harness_bash`). Out of scope,
  exactly as it is for `read-before-edit` (see §6).
- Not incremental/delta backups. One full snapshot per file per session.

---

## 2. Relationship to read-before-edit (the ordering invariant)

The two rules compose into a strict precondition chain on every mutation of an
existing file:

```
read (this session)
   └─► mtime unchanged since read          [read-before-edit]
          └─► pre-mutation snapshot taken   [backup-before-edit]  ← NEW
                 └─► policy decision (allow/confirm/block)
                        └─► sandbox (if enabled)
                               └─► mutation proceeds
```

**The backup is taken at the moment of mutation, not at read time.** This is the key
correctness decision. A snapshot taken when the file was *read* would be stale if the
file changed between read and edit; a snapshot taken just before the write captures the
true pre-mutation state. `read-before-edit` already guarantees the model has *seen* the
current contents, but "seen" ≠ "saved".

Consequence: the backup step runs **after** `readBeforeEditViolation` returns null (i.e.
the read is valid and fresh) and **before** the policy decision is enacted. It is a hard
precondition in the same sense as read-before-edit — it cannot be confirmed away.

---

## 3. Where it lives

Two layers, mirroring how read-before-edit is split:

1. **Decision logic (pure, unit-testable)** → `src/control-plane/backup.ts`
   - `planBackup(canonical, sessionTag): BackupPlan | null` — decides *whether* a backup
     is needed and *where* it goes. Pure function of inputs; takes injectable fs/path
     ops so tests need no real disk. Returns the target path and whether one is required.
   - `backupTargetPath(canonical, sessionTag): string` — deterministic naming (§4).
   - Exemptions live here (§6) so they are testable in isolation.

2. **Wiring (side effects)** → `extensions/control-plane.ts`
   - A `takeBackup(canonical, ctx)` helper that performs the copy and emits a diagnostic
     entry, called from `handleDecision` on the allow/confirm-approved path for
     mutate-class tools, gated by `planBackup`.

Keeping the *decision* in `src/` and the *copy* in the extension follows the file's own
stated separation ("All decision logic lives in ../src/control-plane/ and is
unit-tested without Pi. This file is wiring only.").

---

## 4. Backup location and naming

**Location.** A dedicated directory, never next to the target (a `.bak` sibling would be
inside the same dir a cleanup or sandbox could touch, and would pollute `ls`/glob):

```
$PI_BACKUP_DIR/<sanitized-path>/<basename>.<sessionTag>.bak
```

- `$PI_BACKUP_DIR` defaults to `~/.pi/backups` (honoring `PI_HARNESS_HOME` the same way
  `agentDir()` does, so a relocated harness home relocates backups too). Overridable via
  env for tests.
- `<sanitized-path>` mirrors the target's directory structure with `/` → `_`, so two
  files named `config.yaml` in different trees don't collide:
  `~/.pi/backups/home_bocaj_config_llama-swap__config.yaml.config.yaml.<sessionTag>.bak`
- **Sanitization is mandatory** (spec §54 "sanitize filenames"): strip everything not in
  `[A-Za-z0-9._-]`, cap segment length, never allow `..`. A target path is untrusted input.

**Session tag.** A per-control-plane-activation identifier (a short timestamp+counter
minted when the extension instance is created). One tag per activation means:
- a file edited 5× in one session → 1 backup (the pre-first-edit state);
- the same file edited in two sessions → 2 backups (each session's pre-edit state).

**Root resolution timing.** Both the tag and the backup root are captured ONCE when the
extension instance is created (`controlPlaneExtension(pi)`), NOT lazily per decision and
NOT at `session_start`. The closure is created exactly once per activation, so this pins
the destination for the whole session (matching the tag). Resolving it later would be a
bug: any code that reads `PI_BACKUP_DIR` after the process env has been restored (e.g. a
test fixture that sets it only around boot) would fall back to the real `~/.pi/backups`
and spill real backups into the user's home.

**No overwrite.** If the target backup path already exists (same session re-running, or a
clock/tag collision), append a monotonic counter: `.bak`, `.1.bak`, `.2.bak`. A backup
must never clobber a prior backup — that would defeat the purpose. `fs.writeFileSync`
with `wx` semantics (or an exists-check under the same lock-free assumption as elsewhere;
collisions are rare and the counter is cheap).

**Retention.** v1: no automatic deletion. Backups are small relative to the files they
protect only when the files are small; for large files this grows (§8, open question).
A `prune` policy (keep-N-per-file, or delete-on-successful-git-commit) is a follow-up,
not part of this rule.

---

## 5. Failure semantics (fail-closed)

The backup is a **safety** mechanism; it must fail in the safe direction.

| Condition | Behavior |
|---|---|
| `planBackup` returns null (exempt / new file) | proceed, no backup |
| copy throws (disk full, EACCES, read error) | **block the mutation**, reason: `backup-before-edit: <err>`. Do NOT proceed without a backup. |
| target vanished between plan and copy (race) | treat as "file changed"; block with `backup-before-edit:stale`, require re-read |
| backup dir cannot be created | block, `backup-before-edit: no-backup-dir` |

Rationale: the whole point is a recoverable pre-image. If we can't produce one, the safe
action is to stop, not to mutate blind. This mirrors read-before-edit's fail-closed
posture (unresolvable path → deny).

**Diagnostic entry** on every backup taken (and on every failure), so `/harness-eval` and
the retrospective reviewer can see exactly which files were snapshotted and where:

```json
{ "kind": "backup-before-edit", "toolName": "edit",
  "target": "<canonical>", "backupPath": "<dest>", "sessionTag": "...",
  "bytes": 12345, "at": "<iso>" }
```

and on failure: `{ "kind": "backup-before-edit-failed", ..., "error": "..." }`.

---

## 6. Scope and exemptions (must match read-before-edit exactly)

The backup rule applies to the **same set of calls** read-before-edit does, so the two
never disagree about what counts as a mutation:

- **In scope:** `classifyTool(name) === "mutate"` → `edit` and `write`, targeting an
  **existing** file (resolved via `canonicalizePath`, same helper read-before-edit uses).
- **Exempt — new file:** target does not exist (`fs.existsSync(canonical) === false`).
  Nothing to back up. (Same exemption as read-before-edit.)
- **Exempt — out of scope tools:** `shell` / `harness-shell` (`bash`, `pi_harness_bash`),
  `harness` meta-tools, `unknown`. Shell can rewrite a file without going through the
  write tool; covering it would require parsing arbitrary commands and is explicitly out
  of scope, documented as such (consistent with read-before-edit's stated boundary).
- **Exempt — harness-mediated records:** audit/proposal appends go through
  `pi.appendEntry`, not the generic write tool, so they never reach this rule (same as
  read-before-edit).

**Placement subtlety.** read-before-edit is checked in the *hook* before `handleDecision`
(it preempts the confirm dialog). The backup must be checked **inside** `handleDecision`,
on the path where a mutation is actually about to be allowed — i.e. after the decision is
`allow`, or `confirm`+approved, and immediately before `applySandboxIfEnabled`. Reasons:

1. It must not run for a call that will be *blocked* by policy (no point snapshotting a
   file we're not going to touch).
2. It must run regardless of attended/unattended — the unattended path is exactly where
   an unreviewed edit is most dangerous and there is no human to have made a manual backup.
3. Taking it after approval but before sandbox means the pre-image reflects the true
   on-disk state at mutation time, not a post-sandbox view.

So the chain in `handleDecision`'s allow-branch (and confirm-approved branch) becomes:

```
recordReadCredit / writtenFiles bookkeeping   (existing)
takeBackup(canonical, ctx)  ← NEW; blocks on failure
applySandboxIfEnabled(...)    (existing)
proceed
```

---

## 7. Interaction with the sandbox and unattended mode

- **Sandbox (`bwrap`):** the backup is written by the *extension process* (host fs), not
  inside the sandboxed child, so it is unaffected by the read-only scope mount. The copy
  happens on the host before the sandboxed tool runs. No interaction problem.
- **Unattended mode:** this is where the rule earns its keep. Unattended already logs
  every allowed non-read call (`unattended-call-allowed`); the backup gives each of those
  a recoverable pre-image for free. No new authority is granted — the rule only *adds a
  precondition*, it never loosens a gate.

---

## 8. Open questions (deferred — resolve in a later milestone)

Per the accepted task, items 1–4 are deferred; v1 ships plain-copy with no pruning.

1. **Large files / growth.** Snapshotting a multi-GB file per session is expensive.
   Candidate resolutions (not implemented): size threshold that *blocks* above the limit
   (fail-closed, never skip), hardlink dedup (needs per-tool in-place-write verification),
   content-hash dedup across backups.
2. **`write` full-overwrite vs `edit` partial.** Both snapshot the whole file; no
   distinction needed — resolved by construction.
3. **Shared stat with read-before-edit's mtime check.** Kept independent for
   testability; fold only if profiling shows it matters.
4. **Retention/pruning.** keep-N-per-file or delete-on-successful-git-commit, as a
   separate milestone so v1 stays minimal.

---

## 9. Test plan (mirrors the read-before-edit suite in `tests/extension-harness.test.ts`)

Unit tests for `src/control-plane/backup.ts` (pure, fake fs):
- existing file → plan produces a target path under `$PI_BACKUP_DIR`, sanitized, no `..`.
- new (nonexistent) file → plan returns null (exempt).
- same canonical + same sessionTag → same path; second call in "exists" state → counter
  increments, never overwrites.
- two different dirs, same basename → distinct backup paths (no collision).
- shell/unknown tool name → not a mutation, no plan (defensive; the hook gates this too).

Integration tests in `tests/extension-harness.test.ts` (fake pi + tmp dir), parallel to the
existing RBE tests:
1. **blind edit still blocked by read-before-edit** (unchanged) — backup never reached.
2. **read then edit of existing file** → a backup file exists at the planned path, bytes
   equal the pre-edit content; diagnostic `backup-before-edit` emitted; edit proceeds.
3. **edit a new file** → no backup created (exempt), no diagnostic.
4. **copy fails** (fake fs throws on write) → mutation **blocked**, reason matches
   `/backup-before-edit/`, diagnostic `backup-before-edit-failed` emitted, target file
   unchanged on disk.
5. **file changes after read** → read-before-edit:stale blocks first (backup not reached);
   re-read then edit → backup of the *new* content is taken.
6. **unattended mode** → allowed mutation still produces a backup (rule applies in
   unattended, not just attended).
7. **no cross-session inheritance** → a second activation editing the same file takes its
   own backup under a different sessionTag (does not reuse session 1's).

Acceptance: all existing RBE tests still pass unchanged; the new suite passes; `git diff`
shows the backup step is strictly additive (a precondition), with no path that reaches a
mutation without either an exemption or a successful backup.

---

## 10. Summary of the guarantee after this change

```
Before:  read ─► edit                 (pre-image recoverable only via git/manual)
After:   read ─► snapshot ─► edit     (pre-image always on disk, reviewable, per-session)
```

The model cannot alter an existing file without a durable, attributable copy of what it
was — and if producing that copy fails, the edit is refused rather than run blind.
