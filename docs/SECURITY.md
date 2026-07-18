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

## Restricted is not a sandbox

`/autonomy restricted` (and its alias `sandboxed`) is Pi-level policy interception. It is not equivalent to a container, a VM, a restricted Unix user, Linux namespaces, seccomp, AppArmor, SELinux, Bubblewrap, Firejail, or filesystem virtualization. A process that escapes cooperation (native code, a compromised dependency, a Pi bug) is not contained by it. That is why the alias prints a warning and the status bar never says "Sandboxed". For real isolation, run Pi inside an OS-level sandbox.

## Why shell is blocked entirely in Read-only (and by default in Restricted)

Deciding whether an arbitrary shell command is "safe" requires parsing shell semantics (aliases, subshells, `$(...)`, `xargs`, redirects). Empirical result from a comparable agent harness on this machine: command-*pattern* allow/deny rules failed to reliably block matching commands, while whole-tool denial blocked reliably. So the control plane never classifies commands — the `bash` tool is allowed or denied as a unit. Attended mode is the escape hatch: each command is shown to the user verbatim for approval.

## Unknown tools

Any tool not in the built-in classification (`read`, `grep`, `find`, `ls` / `edit`, `write` / `bash`) is unknown. Unknown is never safe: blocked in Read-only and Restricted, confirmation-gated in Attended, blocked outside Execute.

## Path validation

Targets are canonicalized before comparison: resolved absolute, symlinks resolved via `realpath`; for not-yet-existing files the nearest existing ancestor is realpath'd and the remainder appended (non-existent segments cannot be symlinks). `..` traversal is resolved away; a resolved path outside the project root is blocked. Unresolvable or malformed paths (including NUL bytes) are denied. Residual risk: a symlink created *between* the check and the tool's own filesystem operation (TOCTOU) is not defended — cooperative enforcement, see above.

## Fail-closed defaults

| Failure | Result |
|---|---|
| Saved state malformed / unknown schema | Discuss + Read-only |
| Restricted policy missing/invalid | Restricted enforces Read-only semantics; status says so |
| Confirmation UI unavailable in Attended | Risky call blocked, never silently allowed |
| Path unresolvable | Blocked |
| Tool unknown | Blocked (or confirm in Attended) |
| Source excision unverifiable | Source re-enabled and reported as enabled |
| Restart during /interpret | Guard cleared; phase/autonomy from last persisted state |

## Secret redaction and its limits

Deterministic regex redaction (`redaction.ts`) runs before context display, before hashing, and before any diagnostic preview. Covered: private-key blocks, JWTs, OpenAI/Anthropic/GitHub/AWS key formats, Authorization/Cookie headers, bearer tokens, password assignments, `.env`-style secrets, generic credential assignments. **Pattern matching cannot guarantee detection of every secret** — an unrecognized format passes through. `/context full` prints this warning before output. Do not treat redacted output as safe to publish.

## What is and is not persisted

Persisted (in the Pi session file, via custom entries excluded from LLM context):

- Control-plane state: phase, autonomy, task briefs, source toggles, one content-free context snapshot (names/counts/hashes only), the redacted+truncated text of a pending interpretation.
- Command output entries (already-redacted display text) and diagnostic entries (tool name + timestamp).

Never persisted by this extension:

- Raw provider payloads, full system prompts, message histories, credentials, or any automatic context-capture files. Payloads are observed in memory, reduced to `{length, sha256}`, and discarded.
