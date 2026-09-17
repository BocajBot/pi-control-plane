# Security model

## Threat model

What this extension defends against:

- **Unreviewed mutation** — files changed or commands run before the user has seen and corrected the agent's understanding (Plan blocks mutation; Manual confirms each risky call; Accept confirms everything except in-root edits; Auto runs unattended — see below).
- **Accidental damage** — writes outside the project, credential files touched, destructive operations (Manual/Accept confirmations; in Auto, credential-pattern paths stay blocked and every allowed call is logged).
- **Context opacity** — not knowing what the model can see (redacted inspection, hashes, diffs).

What it does **not** defend against:

- A malicious or compromised Pi process, extension, or model provider.
- Code that the *user* runs outside Pi.
- A hostile model that produces misleading prose (the control plane gates tools, not text).

## Trust boundaries

Everything runs inside Pi's Node process with the user's full privileges. The `tool_call` hook is a policy checkpoint **inside** that process — cooperative enforcement, not containment.

## Auto runs unattended by design; the audit log is the compensating control

`/mode auto` (aliases `unattended`/`execute-unattended`) is the top of the mode ladder and is deliberately at least as permissive as Manual: there is no human in the loop to answer a confirmation, so every decision is allow or block — shell commands, unclassified third-party tools, and out-of-root targets run without asking. Two guards survive because neither is a confirmation a human could have released: an unloadable or invalid policy file fails closed to read-only, and credential-pattern paths (`denyPathBasenames`/`denyPathSubstrings`) are categorically blocked. Because this is the one mode meant to run with nobody confirming actions in real time, every *allowed* mutating or shell call is additionally logged as a diagnostic entry, specifically so there is something to review after the fact when there was no one to review it during. Read tools are not logged (matches "reads execute immediately" everywhere else in this codebase — the volume would drown out the signal). None of this is sandboxing; see below — it is cooperative Pi-level policy interception, which is exactly why the audit trail exists.

## Pi-level policy enforcement is not a sandbox

The control plane's policy layer (`RestrictedPolicy` in `tool-policy.ts`, applied in Auto) is Pi-level policy interception. It is not equivalent to a container, a VM, a restricted Unix user, Linux namespaces, seccomp, AppArmor, SELinux, Bubblewrap, Firejail, or filesystem virtualization. A process that escapes cooperation (native code, a compromised dependency, a Pi bug) is not contained by it. That is why the `sandboxed` alias still prints a warning (and degrades to read-only Plan — the mode it once selected no longer exists) and the status bar never says "Sandboxed". For real isolation, run Pi inside an OS-level sandbox.

## `/bwrap` is real isolation, with specific, listed limits

Unlike Auto-mode policy, `/bwrap on` (`sandbox.ts`) is not cooperative enforcement — it wraps the allowed `bash` command in `bwrap`, which asks the *kernel* for unprivileged user namespaces (mount, PID, UTS, IPC, and — unless `/bwrap network on` — network) before the command runs. A command inside cannot write outside the project root, cannot see a different process tree, and (network off, the default) cannot resolve a hostname at all, regardless of what the command itself tries to do. This was verified directly, not just asserted: a write to a read-only-bound system path fails with `Read-only file system`; `curl` against a real host fails with a DNS resolution error; a file placed under a shadowed credential directory reads back empty inside the sandbox while remaining intact outside it.

What it still does not cover:

- **Same kernel.** Unprivileged namespaces isolate resources, not the kernel itself. A kernel exploit escapes them. This is meaningfully stronger than Restricted mode, but it is not a VM or a hardware boundary — for an actively adversarial (not just possibly-buggy) command, use a VM.
- **Environment variables are inherited, not cleared.** `bwrap` is not passed `--clearenv`, so anything already in Pi's process environment (API keys in `$ANTHROPIC_API_KEY`, etc.) is visible to the sandboxed command exactly as it would be unsandboxed. The sandbox's job here is filesystem/network/process containment, not secret redaction from the environment.
- **Credential shadowing is path-based, not content-based, and only covers `$HOME`'s top level.** The shadow list (`sandboxOptionsFor` in `extensions/control-plane.ts`) reuses `policy/default-policy.json`'s `denyPathSubstrings` (fixed paths: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.pi/agent`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`) and `denyPathBasenames` at `$HOME`'s immediate top level only (`~/.env`, `~/.netrc`, `~/id_rsa`, …). A basename match nested deeper in `$HOME`, or anywhere inside the project root (which is bound read-write regardless — the whole point of sandboxing at all), is not shadowed. This is not a regression versus unsandboxed `bash`: the `bash` tool has never had `read`/`edit`/`write`'s pattern-based path denial (see "Why shell is blocked entirely" below) — the shadow list is a net addition for the sandboxed case, not a promise of parity with those tools.
- **The project root is fully read-write inside the sandbox, on purpose.** Sandboxing here bounds what the agent's *shell commands* can reach outside the project, not what they can do to the project itself. It is not a substitute for the phase/autonomy authorization in `tool-policy.ts` — a `bash` call still has to be allowed or confirmed under `/mode` before `/bwrap` ever gets to wrap it (see the `tool_call` handler in `extensions/control-plane.ts`: sandboxing is applied strictly after the authorization decision, never in place of it).
- **`/bwrap` and `/mode sandboxed` are unrelated settings that happen to share a family resemblance in the word "sandbox".** Enabling one does not enable or imply the other. `/bwrap status` and the footer segment are the only places that report the real setting; `/mode`'s status line never says "Sandboxed" for exactly this reason (see above).
- **Fails closed, not silently.** If `bwrap` is enabled but the binary is missing from `PATH` (uninstalled, or removed mid-session), the `bash` call is blocked with an explicit reason rather than falling back to running unsandboxed.

## Why shell is blocked entirely in Plan (Read-only)

Deciding whether an arbitrary shell command is "safe" requires parsing shell semantics (aliases, subshells, `$(...)`, `xargs`, redirects). Empirical result from a comparable agent harness on this machine: command-*pattern* allow/deny rules failed to reliably block matching commands, while whole-tool denial blocked reliably. So the control plane never classifies commands — the `bash` tool is allowed or denied as a unit. Manual and Accept are the escape hatch: each command is shown to the user verbatim for approval. Auto allows commands outright, logged.

## Unknown tools

Any tool not in the built-in classification (`read`, `grep`, `find`, `ls` / `edit`, `write` / `bash`) is unknown. Unknown is never silently safe: blocked in Plan, confirmation-gated in Manual and Accept, and in Auto it runs — logged — because there is no human to ask. The model's own description of the tool is the only signal about what it does; treat unknown-tool calls in Auto as reviewed only after the fact, via the diagnostic log.

## Path validation

Targets are canonicalized before comparison: resolved absolute, symlinks resolved via `realpath`; for not-yet-existing files the nearest existing ancestor is realpath'd and the remainder appended (non-existent segments cannot be symlinks). `..` traversal is resolved away; a resolved path outside the project root is blocked **unless** it falls under one of `policy.allowPathPrefixes` (see below). Unresolvable or malformed paths (including NUL bytes) are denied. Residual risk: a symlink created *between* the check and the tool's own filesystem operation (TOCTOU) is not defended — cooperative enforcement, see above.

## Out-of-root allowlist (`policy.allowPathPrefixes`)

A Restricted-mode (and, since it shares the same policy engine, Unattended-mode) mutating call whose target is outside the project root is still permitted if the canonical target falls under one of these prefixes. Each configured prefix is resolved via `realpath` fresh on every check; a prefix that does not exist on disk is skipped entirely — it is never treated as a literal-string match, so a typo'd or not-yet-created allowlist entry grants nothing rather than silently matching something unintended. The credential-path deny list (`denyPathBasenames`/`denyPathSubstrings`) still applies inside an allowlisted prefix exactly as it does inside the root: this setting only widens *where* a write may land, it never narrows *what* is denied. Default `[]` reproduces pre-allowlist behavior (root-only) exactly. Widening this is a deliberate trust decision the user makes by editing `policy/default-policy.json` — the control plane does not suggest or infer prefixes to add.

## Fail-closed defaults

| Failure | Result |
|---|---|
| Saved state malformed / unknown schema | Read-only (Plan) |
| Auto policy missing/invalid (incl. a policy file saved under the old schema version) | Enforces Read-only semantics; status says so |
| Scratchpad entry malformed / unknown schema | That entry ignored, newest-still-valid entry restored, or empty scratchpad if none valid — same posture as state restoration, never a partially-repaired guess |
| Sandbox entry malformed / unknown schema | Same posture: entry ignored, newest-still-valid restored, or sandbox off if none valid |
| `/bwrap on` requested but `bwrap` not on PATH | Refused with an error; sandbox stays off |
| Sandbox enabled but `bwrap` disappears from PATH mid-session | Every subsequent `bash` call is blocked with an explicit reason, not run unsandboxed |
| `allowPathPrefixes` entry does not exist on disk | That entry grants nothing (skipped, never a literal-string fallback) |
| Tool-profiles file (`policy/profiles.json`) missing/invalid/old schema | Profiles unavailable; `/context profile` reports the error, tool toggles otherwise unaffected |
| Confirmation UI unavailable in Attended | Risky call blocked, never silently allowed |
| Path unresolvable | Blocked |
| Tool unknown | Blocked (or confirm in Attended) |
| Source excision unverifiable | Source re-enabled and reported as enabled |

## Secret redaction and its limits

Deterministic regex redaction (`redaction.ts`) runs before context display, before hashing, and before any diagnostic preview. Covered: private-key blocks, JWTs, OpenAI/Anthropic/GitHub/AWS key formats, Authorization/Cookie headers, bearer tokens, password assignments, `.env`-style secrets, generic credential assignments. **Pattern matching cannot guarantee detection of every secret** — an unrecognized format passes through. `/context full` prints this warning before output. Do not treat redacted output as safe to publish.

## What is and is not persisted

Persisted (in the Pi session file, via custom entries excluded from LLM context):

- Control-plane state: phase, autonomy, source toggles, one content-free context snapshot (names/counts/hashes only).
- Command output entries (already-redacted display text) and diagnostic entries (tool name + timestamp; under Auto, one such entry per *allowed* mutating/shell call too, not only blocked ones).
- Scratchpad notes: exactly the text given to `/scratchpad add`, capped at 4000 chars per note. This is user/model-authored working content, not redacted like system-prompt or provider-payload text — treat it the same as any other message content you'd put in a scratchpad note.

Never persisted by this extension:

- Raw provider payloads, full system prompts, message histories, credentials, or any automatic context-capture files. Payloads are observed in memory, reduced to `{length, sha256}`, and discarded.

One deliberate, user-initiated exception: the `alt+e` context editor writes the **unredacted** session context to a temp file (mode 0600 in the system temp dir) so nvim can edit it, and deletes it when the editor exits — including on error. This only happens when the user presses `alt+e`; nothing writes context to disk automatically. The resulting override lives in process memory only and is never appended to the session file.
