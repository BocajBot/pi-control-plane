# Security model

## Threat model

What this extension defends against:

- **Scope drift** — the agent doing more than the accepted task (phase gates, task-brief injection, approval boundaries).
- **Unreviewed mutation** — files changed or commands run before the user has seen and corrected the agent's understanding (Discuss/Plan/Verify block mutation; Read-only default; Attended confirmations).
- **Accidental damage** — writes outside the project, credential files touched, destructive operations (Restricted policy: root containment, canonical paths, deny lists).
- **Context opacity** — not knowing what the model can see (redacted inspection, hashes, diffs).
- **Prompt-injection via task text** — user-supplied or interpreted task content imitating control-plane instructions (delimiter neutralization; task text treated as data).

What it does **not** defend against:

- A malicious or compromised Pi process, extension, or model provider.
- Code that the *user* runs outside Pi.
- A hostile model that produces misleading prose (the control plane gates tools, not text).

## Trust boundaries

Everything runs inside Pi's Node process with the user's full privileges. The `tool_call` hook is a policy checkpoint **inside** that process — cooperative enforcement, not containment.

## Unattended is Restricted plus a mandatory scope boundary, not a separate permission tier

`/mode execute-unattended` reuses `RestrictedPolicy` enforcement byte-for-byte (same deny lists, same root/allowlist containment, same `allowBash` gate) — it is not a more permissive mode. The one thing it adds is a precondition: no mutating call is permitted until a task brief is accepted (`/interpret` + `/task accept`, or `/task set`), because this is the one mode meant to run with nobody confirming actions in real time, and the accepted brief is the only scope boundary a human reviewed before that happened. Every *allowed* mutating or shell call is additionally logged as a diagnostic entry, specifically so there is something to review after the fact when there was no one to review it during. Reads are not gated by the task-brief requirement, and read tools are not logged (matches "reads execute immediately" everywhere else in this codebase — the volume would drown out the signal, and reads are not the risk this precondition targets). None of this is sandboxing; see below — it is the same cooperative Pi-level policy interception as Restricted, run without a human watching, which is exactly why the extra precondition and the audit trail exist.

## Restricted is not a sandbox

`/mode execute-restricted` (and its alias `sandboxed`) is Pi-level policy interception. It is not equivalent to a container, a VM, a restricted Unix user, Linux namespaces, seccomp, AppArmor, SELinux, Bubblewrap, Firejail, or filesystem virtualization. A process that escapes cooperation (native code, a compromised dependency, a Pi bug) is not contained by it. That is why the alias prints a warning and the status bar never says "Sandboxed". For real isolation, run Pi inside an OS-level sandbox.

## Why shell is blocked entirely in Read-only (and by default in Restricted)

Deciding whether an arbitrary shell command is "safe" requires parsing shell semantics (aliases, subshells, `$(...)`, `xargs`, redirects). Empirical result from a comparable agent harness on this machine: command-*pattern* allow/deny rules failed to reliably block matching commands, while whole-tool denial blocked reliably. So the control plane never classifies commands — the `bash` tool is allowed or denied as a unit. Attended mode is the escape hatch: each command is shown to the user verbatim for approval.

## Unknown tools

Any tool not in the built-in classification (`read`, `grep`, `find`, `ls` / `edit`, `write` / `bash`) is unknown. Unknown is never safe: blocked in Read-only and Restricted, confirmation-gated in Attended, blocked outside Execute.

## Path validation

Targets are canonicalized before comparison: resolved absolute, symlinks resolved via `realpath`; for not-yet-existing files the nearest existing ancestor is realpath'd and the remainder appended (non-existent segments cannot be symlinks). `..` traversal is resolved away; a resolved path outside the project root is blocked **unless** it falls under one of `policy.allowPathPrefixes` (see below). Unresolvable or malformed paths (including NUL bytes) are denied. Residual risk: a symlink created *between* the check and the tool's own filesystem operation (TOCTOU) is not defended — cooperative enforcement, see above.

## Out-of-root allowlist (`policy.allowPathPrefixes`)

A Restricted-mode (and, since it shares the same policy engine, Unattended-mode) mutating call whose target is outside the project root is still permitted if the canonical target falls under one of these prefixes. Each configured prefix is resolved via `realpath` fresh on every check; a prefix that does not exist on disk is skipped entirely — it is never treated as a literal-string match, so a typo'd or not-yet-created allowlist entry grants nothing rather than silently matching something unintended. The credential-path deny list (`denyPathBasenames`/`denyPathSubstrings`) still applies inside an allowlisted prefix exactly as it does inside the root: this setting only widens *where* a write may land, it never narrows *what* is denied. Default `[]` reproduces pre-allowlist behavior (root-only) exactly. Widening this is a deliberate trust decision the user makes by editing `policy/default-policy.json` — the control plane does not suggest or infer prefixes to add.

## Fail-closed defaults

| Failure | Result |
|---|---|
| Saved state malformed / unknown schema | Discuss + Read-only |
| Restricted or Unattended policy missing/invalid (incl. a policy file saved under the old schema version) | Enforces Read-only semantics; status says so |
| Unattended mode entered without an accepted task brief | Every mutating/shell call blocked (`unattended:no-task`); reads unaffected |
| Scratchpad entry malformed / unknown schema | That entry ignored, newest-still-valid entry restored, or empty scratchpad if none valid — same posture as state restoration, never a partially-repaired guess |
| `allowPathPrefixes` entry does not exist on disk | That entry grants nothing (skipped, never a literal-string fallback) |
| Confirmation UI unavailable in Attended | Risky call blocked, never silently allowed |
| Path unresolvable | Blocked |
| Tool unknown | Blocked (or confirm in Attended) |
| Source excision unverifiable | Source re-enabled and reported as enabled |
| Restart during /interpret | Guard cleared; mode from last persisted state |

## Secret redaction and its limits

Deterministic regex redaction (`redaction.ts`) runs before context display, before hashing, and before any diagnostic preview. Covered: private-key blocks, JWTs, OpenAI/Anthropic/GitHub/AWS key formats, Authorization/Cookie headers, bearer tokens, password assignments, `.env`-style secrets, generic credential assignments. **Pattern matching cannot guarantee detection of every secret** — an unrecognized format passes through. `/context full` prints this warning before output. Do not treat redacted output as safe to publish.

## What is and is not persisted

Persisted (in the Pi session file, via custom entries excluded from LLM context):

- Control-plane state: phase, autonomy, task briefs, source toggles, one content-free context snapshot (names/counts/hashes only), the redacted+truncated text of a pending interpretation.
- Command output entries (already-redacted display text) and diagnostic entries (tool name + timestamp; under Unattended, one such entry per *allowed* mutating/shell call too, not only blocked ones).
- Scratchpad notes: exactly the text given to `/scratchpad add`, capped at 4000 chars per note. This is user/model-authored working content, not redacted like system-prompt or provider-payload text — treat it the same as any other message content you'd put in a task brief.

Never persisted by this extension:

- Raw provider payloads, full system prompts, message histories, credentials, or any automatic context-capture files. Payloads are observed in memory, reduced to `{length, sha256}`, and discarded.

One deliberate, user-initiated exception: the `alt+e` context editor writes the **unredacted** session context to a temp file (mode 0600 in the system temp dir) so nvim can edit it, and deletes it when the editor exits — including on error. This only happens when the user presses `alt+e`; nothing writes context to disk automatically. The resulting override lives in process memory only and is never appended to the session file.
