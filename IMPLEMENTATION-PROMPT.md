# Build the Initial Pi Control Plane Extension

You are working on a custom control-plane extension for the Pi coding agent.

The purpose of this project is to make Pi's effective context, task interpretation, workflow phase, and execution authority visible and controllable before expanding into more autonomous workflows.

## Primary objective

Build the first production-quality version of the Pi Control Plane.

It must allow the user to determine:

1. What model and provider are active.
2. What prompt sources, tools, skills, and messages are available to the model — and toggle prompt sources on or off where Pi's API permits it.
3. How much of the context window is in use.
4. How Pi interprets a task before execution.
5. What task Pi currently believes it is completing.
6. What workflow phase is active.
7. What level of execution authority is currently permitted.
8. Whether those controls are actually enforced rather than merely displayed.

The central design principle is:

> The user must be able to inspect and correct Pi's effective context and task interpretation before Pi is permitted to modify anything.

Do not build the entire long-term agentic platform in this task. Implement only the bounded milestone defined below.

---

# Working environment

The intended repository is:

```text
~/Documents/pi-control-plane
```

As of 2026-07-18 this directory contains only this prompt file — the project has not been started. Initialize it (`git init`) and build the baseline below. If work already exists by the time you run, preserve and integrate with it instead of overwriting.

The intended baseline is:

```text
pi-control-plane/
├── extensions/
├── prompts/
├── skills/
├── policy/
├── docs/
├── tests/
├── README.md
└── .gitignore
```

## How Pi loads this project (verified against pi 0.80.10)

Pi does **not** load arbitrary directories from a global config. It auto-discovers extensions only from:

```text
~/.pi/agent/extensions/*.ts        (global)
.pi/extensions/*.ts                (project-local, after project trust)
```

and it loads **pi packages** listed under `packages` in `~/.pi/agent/settings.json`. Local paths are supported:

```bash
pi install ~/Documents/pi-control-plane
```

A pi package declares resources in `package.json` under the `pi` key, or via the conventional directories `extensions/`, `skills/`, `prompts/`, which is exactly the baseline layout above. Structure the repository as a local pi package and install it with the command above.

The current `~/.pi/agent/settings.json` contains only:

```json
{ "packages": ["git:github.com/huggingface/pi-llama"] }
```

plus theme/changelog keys. `pi install` will edit this file. Before any step that modifies it, create a backup using the established naming convention:

```text
settings.json.bak.<description>-YYYYMMDD-HHMMSS
```

(This backup-before-edit convention applies to any pre-existing config file this milestone touches.)

Do not modify the user's Pi authentication (`~/.pi/agent/auth.json`), provider configuration, shell configuration, or unrelated repositories. Do not remove or alter the `pi-llama` package entry.

---

# Authoritative sources

Use the following precedence order:

1. Current repository files.
2. Installed Pi package source and TypeScript definitions (`~/.local/lib/node_modules/@earendil-works/pi-coding-agent/`).
3. Current Pi runtime behavior.
4. Official Pi documentation (also shipped locally in the package's `docs/` directory).
5. This implementation prompt.
6. General assumptions.

The following APIs were verified to exist in the installed pi 0.80.10 type definitions (`dist/core/extensions/types.d.ts`). Re-verify their exact signatures before use — this list confirms existence, not shape:

```text
ctx.getContextUsage()
ctx.getSystemPromptOptions()
before_agent_start        (event)
context                   (event)
before_provider_request   (event)
tool_call                 (event)
ctx.ui.setStatus()
ctx.ui.setWidget()
ctx.ui.confirm()          (confirmation dialog — needed for Attended mode)
pi.appendEntry()
pi.registerCommand()
KeybindingsManager        (app-level keybindings)
```

When documentation and installed types disagree, prefer the installed version and document the discrepancy.

Use only official Pi documentation if network research becomes necessary.

Built-in commands in pi 0.80.10 include `/compact`, `/new`, `/model`, `/reload`, `/resume`, `/session`, `/settings`, `/hotkeys`, `/trust`, `/export`, `/fork`, `/tree` and others. The five commands required below were checked against this list and do not conflict, but re-verify at implementation time.

---

# Required workflow

Perform the work in this order.

## 1. Inspect

Before editing:

```bash
pwd
git status --short
find . -maxdepth 3 -type f -print | sort
pi list
cat ~/.pi/agent/settings.json
```

Then inspect:

* Existing source files.
* Existing package configuration.
* Existing tests.
* Existing Pi extension examples (`examples/extensions/` in the installed package).
* Installed Pi TypeScript definitions.
* Current command registration and lifecycle APIs.
* Session persistence APIs.
* Tool interception and UI confirmation APIs.
* Current keybinding assignments (`/hotkeys`, `docs/keybindings.md`) — note that `shift+tab` is already bound to `app.thinking.cycle`.

Record any material incompatibilities or missing APIs.

Do not stop after producing a plan. Continue through implementation and validation unless a genuinely external dependency makes completion impossible.

## 2. Design

Choose the simplest architecture that:

* Keeps one obvious extension entry point.
* Separates pure logic from Pi-specific integration.
* Can be unit tested without launching Pi.
* Uses no runtime dependencies unless clearly necessary.
* Fails closed when state, policy, or tool classification is unknown.
* Does not persist raw prompts or provider payloads.
* Can be extended later without requiring a rewrite.

## 3. Implement

Build all required commands, state management, UI status, keybindings, interpretation gating, and enforcement behavior.

## 4. Test

Run unit tests and practical Pi smoke tests where the installed environment permits them.

## 5. Document

Update the README and add focused architecture, security, and testing documentation.

**Plain-language requirement:** the user is comfortable with Docker, pacman, and CLI tooling, but is not confident writing extension/skill/prompt files. Every file the milestone creates must be explained in the README in plain language: what the file is, what it does, and when the user would ever need to touch it. Do the same for each command. Assume the README is the only document the user reads.

## 6. Report

At completion, report:

* Files created.
* Files modified.
* Commands implemented.
* Keybindings registered.
* Tests run.
* Test results.
* Manual validation performed.
* Known limitations.
* Deferred milestones.
* Final `git status --short`.

Do not commit, tag, push, publish, or create a release.

---

# Required architecture

Prefer an arrangement similar to:

```text
pi-control-plane/
├── extensions/
│   └── control-plane.ts
├── src/
│   └── control-plane/
│       ├── commands.ts
│       ├── context-snapshot.ts
│       ├── context-diff.ts
│       ├── interpretation.ts
│       ├── keybindings.ts
│       ├── redaction.ts
│       ├── state.ts
│       ├── tool-policy.ts
│       ├── types.ts
│       └── ui.ts
├── prompts/
│   └── interpret.md
├── policy/
│   └── default-policy.json
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   └── TESTING.md
├── tests/
└── README.md
```

Adjust this structure when the Pi loader or existing repository requires a different arrangement.

Only files intended to register an extension should live in an automatically loaded extension directory. Avoid accidentally loading helper modules as independent extensions.

Keep the main extension entry point small. Put normalization, state transitions, diffing, redaction, parsing, and tool classification into testable modules.

---

# Required commands

Implement these top-level commands:

```text
/context
/task
/phase
/autonomy
/interpret
```

Subcommands may be added only where specified below.

Commands must provide useful usage output when given invalid arguments.

Command names must not conflict with built-in Pi commands (checked against 0.80.10 above; re-verify).

---

# Required keybindings

The following hotkeys are in scope for this milestone (this supersedes any earlier guidance to defer keybindings):

1. **Context preview hotkey** — toggles a context summary widget (`ctx.ui.setWidget`) showing the same redacted summary as `/context`, without typing the command.
2. **Phase cycle hotkey** — cycles Discuss → Plan → Execute → Verify → Discuss.
3. **Autonomy cycle hotkey** — cycles Read-only → Attended → Restricted → Read-only.

Rules:

* Register via Pi's supported keybinding mechanism (`KeybindingsManager` / extension keybinding API — verify the current registration surface).
* Defaults must not collide with existing Pi bindings. `shift+tab` is already `app.thinking.cycle` in Pi — do **not** steal it by default. Pick free keys, verified against `/hotkeys` at implementation time.
* The user is accustomed to Claude Code's `shift+tab` mode cycling. Document in the README, in plain language, exactly how to rebind the phase-cycle hotkey to `shift+tab` via Pi's keybindings configuration if they prefer that, including the consequence (it displaces Pi's thinking-level cycle).
* Every hotkey action must produce the same state change and status update as its command equivalent — no keybinding-only code paths.

---

# 1. `/context`

## Default behavior

Running:

```text
/context
```

must display a concise, redacted summary of the effective context available to the model.

Include, when available:

* Provider.
* Model.
* Context-window size.
* Tokens currently used.
* Percentage of context consumed.
* Message count.
* Message counts grouped by role or message type.
* Loaded context files.
* Loaded instruction files.
* Available tools.
* Available skills.
* Available prompt templates.
* Active workflow phase.
* Active autonomy level.
* Whether an accepted task brief exists.
* System-prompt length and stable content hash.
* Provider-payload length and stable content hash.
* Timestamp of the snapshot.

Clearly distinguish:

```text
Observed
Unavailable
Inferred
```

Do not label inferred information as observed.

When context usage is high (for example above 75%), append a one-line reminder that Pi's built-in `/compact` summarizes older context and `/new` starts a fresh session. Do not reimplement compaction.

## Supported forms

Implement:

```text
/context
/context diff
/context full
/context sources
/context toggle <name>
```

### `/context diff`

Compare the current normalized context snapshot with the most recent snapshot produced by `/context` or `/context full`.

Show:

* Added sources.
* Removed sources.
* Changed sources.
* Added tools.
* Removed tools.
* Added skills.
* Removed skills.
* Model or provider changes.
* Message-count changes.
* Token-use changes.
* System-prompt hash changes.
* Provider-payload hash changes.

The first invocation must clearly state that no previous snapshot exists. It may establish the first baseline.

Snapshots should be maintained in session state.

Do not persist raw provider payloads merely to generate a diff.

### `/context full`

Display the provider-visible context in more detail, subject to redaction and practical output limits.

It may include:

* Prompt-source names and paths.
* Redacted system-prompt sections.
* Redacted message previews.
* Tool names and descriptions.
* Skill names and descriptions.
* Prompt-template names and descriptions.

It must not expose:

* Hidden model reasoning.
* Chain-of-thought.
* Authentication credentials.
* API keys.
* Bearer tokens.
* Cookies.
* Private keys.
* Raw authorization headers.
* Password values.
* Unredacted provider payloads containing secrets.

Print a warning before detailed context output:

```text
Detailed context may contain sensitive project information. Known credential patterns have been redacted, but redaction cannot be guaranteed to identify every secret.
```

Apply output size limits and clearly report truncation.

### `/context sources` and `/context toggle <name>`

The system prompt and its inputs must be toggle-able, not merely visible.

`/context sources` lists every prompt source the control plane can identify — system-prompt components (from `ctx.getSystemPromptOptions()`), loaded context/instruction files, skills, and prompt templates — each with a stable name and an `enabled` / `disabled` / `not toggleable` marker.

`/context toggle <name>` flips a source for subsequent turns, using whichever Pi mechanism actually supports exclusion (system-prompt options, the `context` event's message/system-prompt mutation surface, or skill/tool filtering — verify which of these the installed API genuinely allows).

Rules:

* Toggle state lives in control-plane session state and survives restoration like everything else.
* Where Pi's API provides no honest way to exclude a given source, report `not toggleable` for it. Never display a source as disabled while it still reaches the provider.
* Toggling must never touch Pi's built-in safety or core system prompt in a way that breaks tool calling; if excluding a component would do that, mark it `not toggleable` and document why.
* Do not persist toggled-out content to disk to "restore" it later — the toggle is a per-session include/exclude, not an editor.

## Context capture

Use the appropriate Pi lifecycle hooks to observe:

* Effective message context.
* Prompt-source configuration.
* Final provider request metadata.

Store only the minimum metadata necessary for display and diffing.

Never write complete provider requests, full system prompts, or full message histories to disk automatically.

---

# 2. `/task`

The task brief is the canonical statement of what the agent currently believes it is doing.

Implement:

```text
/task
/task set <text>
/task clear
/task accept
/task reject
```

## `/task`

Display:

* Accepted task brief.
* Pending interpretation, if one exists.
* Creation or update time.
* Source of the task brief.
* Completion criteria.
* Approval boundaries.
* Any unresolved unknowns.

If no task exists, say so explicitly.

## `/task set <text>`

Create a task brief directly from user-supplied text.

At minimum, store:

```typescript
interface TaskBrief {
  id: string;
  objective: string;
  deliverables: string[];
  includedScope: string[];
  excludedScope: string[];
  constraints: string[];
  assumptions: string[];
  unknowns: string[];
  completionCriteria: string[];
  approvalBoundaries: string[];
  sourceRequest: string;
  source: "direct" | "interpretation";
  createdAt: string;
  updatedAt: string;
}
```

A directly supplied task may initially contain only the objective and source request. Do not fabricate missing structured fields.

## `/task accept`

Accept the most recent successfully parsed `/interpret` result as the active task brief.

Do not accept malformed or incomplete interpretations silently.

## `/task reject`

Discard the pending interpretation without changing the accepted task.

## `/task clear`

Clear both accepted and pending task state after confirmation.

---

# 3. `/phase`

Implement these phases:

```text
Discuss
Plan
Execute
Verify
```

Supported usage:

```text
/phase
/phase discuss
/phase plan
/phase execute
/phase verify
```

(plus the phase-cycle hotkey defined above)

## Phase semantics

### Discuss

Purpose:

* Explore the request.
* Inspect current state.
* Identify ambiguity.
* Compare approaches.
* Establish constraints.

Mutation is prohibited.

### Plan

Purpose:

* Produce an ordered implementation plan.
* Define deliverables.
* Define tests and completion criteria.
* Identify risks and approval boundaries.

Mutation is prohibited.

### Execute

Purpose:

* Perform the accepted task.
* Modify files or invoke mutating tools when the autonomy policy permits it.
* Remain within the accepted task scope.

Mutation may be allowed depending on autonomy.

### Verify

Purpose:

* Run tests.
* Inspect output.
* Compare results against completion criteria.
* Report failures and uncertainty.

New feature work and unrelated modifications are prohibited.

When verification discovers a required code change, transition back to Execute before applying it.

## Enforcement

Phase must affect tool authorization.

A displayed phase with no behavioral effect is unacceptable.

Discuss, Plan, and Verify must block mutating tool calls regardless of autonomy setting.

Execute is the only phase in which mutation may be permitted.

---

# 4. `/autonomy`

Implement these actual modes:

```text
Read-only
Attended
Restricted
```

Supported usage:

```text
/autonomy
/autonomy read-only
/autonomy attended
/autonomy restricted
/autonomy sandboxed
```

(plus the autonomy-cycle hotkey defined above)

`/autonomy sandboxed` must be accepted only as an alias for `restricted` and must display this warning:

```text
This mode provides Pi-level policy restrictions, not operating-system isolation. It is not a security sandbox.
```

Do not display the mode as "Sandboxed" in the status UI.

An **Unattended** mode is deliberately excluded from this milestone. Prior local testing established two hard lessons that apply directly: headless agent runs execute tools with no gating unless explicitly denied, and local models unreliably self-report completion (claiming success for actions that never applied). Unattended execution belongs to a later milestone, after this enforcement layer has proven itself. Design the autonomy type and cycle order so an `unattended` mode can be added later without a rewrite, but do not implement or stub it.

Pi tool hooks are not equivalent to:

* A container.
* A virtual machine.
* A restricted Unix user.
* Linux namespaces.
* seccomp.
* AppArmor.
* SELinux.
* Bubblewrap.
* Firejail.
* Filesystem virtualization.

Never create a false impression that policy interception contains a malicious or compromised process.

## Read-only

Allow only explicitly classified read-oriented tools.

At minimum, the following built-in tool categories may be treated as read-oriented after verifying their actual Pi names and behavior:

```text
read
grep
find
ls
```

Block:

* File writes.
* File edits.
* Shell execution.
* Network access.
* Package installation.
* Git mutation.
* Unknown tools.
* Any tool that cannot be confidently classified as read-only.

Do not attempt to parse arbitrary shell commands and declare them safe in this milestone. Shell execution is blocked entirely in Read-only mode. (This matches an empirical local lesson: command-pattern-level allow/deny rules proved unreliable in practice in a comparable agent harness; only flat whole-tool denial blocked reliably. Classify at the tool level, never at the command-pattern level.)

## Attended

Allow clearly read-only operations without prompting.

Before any operation that may:

* Modify files.
* Execute shell commands.
* Access the network.
* Use credentials.
* Change repository state.
* Install dependencies.
* Create commits or tags.
* Push or publish.
* Delete data.
* Access files outside the project root.

show an explicit confirmation (via `ctx.ui.confirm` or the current equivalent) containing:

* Tool name.
* Risk category.
* Target path or destination, when available.
* Command, when available.
* Reason Pi says the tool is needed.
* Whether the operation is inside the current project root.

Denial must prevent the tool call.

When Pi does not expose a suitable confirmation API, do not silently downgrade Attended mode to unrestricted execution. Fail closed and document the limitation.

## Restricted

Implement a conservative Pi-level policy mode.

At minimum:

* Permit modifications only inside the current project root.
* Block access to obvious credential paths.
* Block network-capable tools unless explicitly permitted by policy.
* Block destructive commands.
* Block commit, tag, push, release, and publish operations.
* Treat unknown tools as denied.
* Treat unresolved or malformed paths as denied.
* Resolve paths canonically before comparing them with allowed roots.
* Prevent `..` traversal and symlink-based escape where practical.

Restricted mode remains policy enforcement, not process isolation.

Define its defaults in:

```text
policy/default-policy.json
```

Validate policy files before use.

When policy loading or validation fails, fall back to Read-only mode.

---

# 5. `/interpret`

Supported usage:

```text
/interpret <task request>
```

This command is a mandatory interpretation gate.

It must:

1. Save the current phase and autonomy state.
2. Temporarily activate a no-tools interpretation guard.
3. Prevent every tool invocation during the interpretation turn.
4. Ask the active model to interpret the supplied task.
5. Require the following exact sections:

```text
## Objective
## Deliverables
## Authoritative context
## Included scope
## Excluded scope
## Constraints
## Assumptions
## Unknowns
## Proposed actions
## Completion criteria
## Approval boundaries
## Restated task
```

6. Parse the response into a pending task brief.
7. Validate required sections.
8. Restore the previous phase and autonomy after the interpretation turn.
9. Tell the user to run `/task accept` or `/task reject`.

The interpretation result must not automatically become authoritative.

The interpretation command must not:

* Call tools.
* Modify files.
* Access the network.
* Install anything.
* Begin implementation.
* Change the accepted task.
* Claim that assumptions were verified.

If the model attempts a tool call during interpretation, block it and record the blocked attempt as a diagnostic event.

If required headings are missing, retain the response for display but mark it invalid and prevent `/task accept`.

---

# Session-persistent state

Persist control-plane state in the Pi session using the supported session-entry mechanism.

State must survive:

* Normal turns.
* `/reload`, when Pi supports restoration across reload.
* Closing and reopening a named session.
* Context compaction.
* Model changes.

Use a versioned state format, for example:

```typescript
interface ControlPlaneState {
  schemaVersion: 1;
  phase: "discuss" | "plan" | "execute" | "verify";
  autonomy: "read-only" | "attended" | "restricted";
  acceptedTask: TaskBrief | null;
  pendingInterpretation: PendingInterpretation | null;
  previousContextSnapshot: ContextSnapshot | null;
  sourceToggles: Record<string, boolean>;
  updatedAt: string;
}
```

Append state changes as extension-specific session entries.

On restoration:

1. Locate the most recent valid state entry.
2. Validate it.
3. Ignore malformed entries.
4. Fall back to safe defaults when restoration fails.

Safe defaults are:

```text
Phase: Discuss
Autonomy: Read-only
Accepted task: None
Pending interpretation: None
Source toggles: all enabled
```

Never fall back to Execute or an unrestricted mode.

Do not store state globally unless explicitly required by the existing Pi API.

---

# Agent-start injection

Before each normal agent turn, inject a concise control-plane state block into the effective instructions.

Use a format similar to:

```text
[PI CONTROL PLANE]

Phase: Discuss
Autonomy: Read-only
Task status: Accepted | Pending | None

Accepted objective:
...

Included scope:
...

Excluded scope:
...

Constraints:
...

Unknowns:
...

Completion criteria:
...

Approval boundaries:
...

Behavioral requirements:
- Obey the active phase.
- Obey the active autonomy policy.
- Do not broaden the accepted task.
- Distinguish observations, inferences, assumptions, and recommendations.
- Do not claim completion without verification evidence. A queued, pending, or blocked action is not a completed action and must never be described as done.
```

Requirements:

* Inject only the accepted task, not obsolete task history.
* Do not repeatedly append permanent duplicate messages.
* Use ephemeral lifecycle injection where possible.
* Limit field and total size.
* Mark truncation explicitly.
* Escape or delimit user-supplied task text so it cannot masquerade as control-plane instructions.
* Treat task text as data, not higher-priority instructions.

The injected state must complement rather than replace Pi's built-in system prompt.

Do not create or overwrite a global `SYSTEM.md`.

---

# UI requirements

Use Pi's supported status or widget APIs without replacing the normal footer.

Display a compact status similar to:

```text
CP: Discuss | Read-only | Task: set | Context: 42%
```

When no task exists:

```text
CP: Discuss | Read-only | Task: none | Context: 42%
```

Pi's own footer already shows token stats and model info natively — do not duplicate a tokens-per-second readout in the control-plane status. The persistent context-usage percentage plus Pi's native footer together satisfy the "X tok/s, Y% context usage always visible" requirement. If Pi's footer turns out not to show generation speed, note that as a limitation rather than rebuilding footer internals in this milestone.

The status must update after:

* Phase changes.
* Autonomy changes.
* Task acceptance.
* Task clearing.
* Context changes, where practical.
* Session restoration.
* Source toggles.

Do not display secrets, full task text, or raw prompts in the persistent status area.

The context preview hotkey must toggle its widget cleanly (show on first press, hide on second) and must reuse the `/context` rendering path, redaction included.

---

# Tool authorization rules

Tool authorization must combine:

```text
Interpretation guard
        ↓
Workflow phase
        ↓
Autonomy policy
        ↓
Tool classification
        ↓
Path and destination checks
```

Use the most restrictive applicable rule.

Examples:

| Situation                                 | Required result                                                       |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `/interpret` attempts any tool            | Block                                                                 |
| Discuss + write tool                      | Block                                                                 |
| Plan + shell tool                         | Block                                                                 |
| Verify + file edit                        | Block                                                                 |
| Execute + Read-only + write tool          | Block                                                                 |
| Execute + Attended + write tool           | Confirm                                                               |
| Execute + Restricted + write inside root  | Evaluate policy                                                       |
| Execute + Restricted + write outside root | Block                                                                 |
| Any mode + unknown tool                   | Block or confirm according to the most conservative applicable policy |
| Invalid or missing policy                 | Fall back to Read-only                                                |

Unknown tools must never be silently classified as safe.

Return actionable denial messages that explain:

* What was blocked.
* Which rule blocked it.
* What phase or autonomy change would be needed.
* Whether the operation is categorically prohibited.

Do not expose internal stack traces for normal policy denials.

---

# Secret redaction

Build a deterministic redaction layer for context inspection.

At minimum, detect and redact common forms of:

* API keys.
* Bearer tokens.
* JWTs.
* GitHub tokens.
* OpenAI keys.
* Anthropic keys.
* Authorization headers.
* Cookies.
* Password assignments.
* Private-key blocks.
* Common `.env` secret values.

Use a replacement such as:

```text
[REDACTED:<category>]
```

Redaction must occur before:

* Rendering context output.
* Hashing content intended to represent a redacted view.
* Recording diagnostic previews.
* Writing any debug artifact.

Document that pattern-based redaction reduces risk but cannot guarantee complete secret detection.

Do not create automatic context-capture files during this milestone.

---

# Testing requirements

Use dependency-free tests where practical.

Prefer the installed Node runtime's native test capabilities when it can execute the project's TypeScript safely. If an additional development-only test runner is genuinely required, add the smallest reasonable dev dependency and document why.

Do not add runtime dependencies merely for convenience.

## Required unit tests

Test at least:

### State

* Safe default initialization.
* Valid state serialization.
* Valid state restoration.
* Malformed state rejection.
* Unknown schema-version rejection.
* Compaction-safe restoration.
* No fallback to Execute.
* No fallback to Attended or Restricted.
* Source-toggle persistence and default (all enabled).

### Phase transitions

* Every valid transition.
* Invalid phase names.
* Case normalization.
* Cycle order (Discuss → Plan → Execute → Verify → Discuss).
* Mutation blocked during Discuss.
* Mutation blocked during Plan.
* Mutation blocked during Verify.
* Execute defers to autonomy policy.

### Autonomy

* Read-only allows known read tools.
* Read-only blocks shell execution.
* Read-only blocks write and edit tools.
* Read-only blocks unknown tools.
* Attended requests confirmation for risky tools.
* Denied confirmation blocks execution.
* Restricted blocks paths outside the project.
* Invalid policy falls back to Read-only.
* `sandboxed` resolves to Restricted with a warning.
* Cycle order (Read-only → Attended → Restricted → Read-only).

### Context snapshots

* Stable normalization.
* Stable hashing.
* Added-item diff.
* Removed-item diff.
* Changed-item diff.
* Token delta.
* First-snapshot behavior.
* Deterministic ordering.
* No raw secret persistence.

### Source toggles

* Toggleable source excluded after toggle-off.
* Re-enabled source included again.
* Non-toggleable source reported honestly (never shown disabled while still sent).
* Unknown source name produces usage output, not a state change.

### Redaction

* Bearer tokens.
* API keys.
* JWTs.
* Password assignments.
* Authorization headers.
* Private keys.
* Non-secret text remains readable.

### Task briefs

* Direct task creation.
* Valid interpretation parsing.
* Missing-heading rejection.
* Accept pending interpretation.
* Reject pending interpretation.
* Clear task state.
* User content cannot override control-plane delimiters.

### Tool policy

* Canonical in-root path accepted.
* Parent traversal rejected.
* Out-of-root absolute path rejected.
* Symlink escape addressed or clearly documented.
* Unknown destination rejected.
* Unknown tool rejected.

## Smoke tests

Where possible, validate these behaviors in Pi:

1. Start a new session.
2. Confirm default phase is Discuss.
3. Confirm default autonomy is Read-only.
4. Run `/context`.
5. Run `/context diff`.
6. Run `/context sources`, toggle one source off, confirm `/context diff` reflects it, toggle it back on.
7. Set and display a task.
8. Change each phase, by command and by cycle hotkey.
9. Change each autonomy level, by command and by cycle hotkey.
10. Press the context-preview hotkey; confirm the widget shows and hides.
11. Attempt a write in Discuss and confirm it is blocked.
12. Enter Execute while remaining Read-only and confirm the write is blocked.
13. Enter Attended and confirm a risky operation requests approval.
14. Deny approval and confirm no operation occurs.
15. Run `/interpret` with a request that encourages tool usage and confirm all tool calls remain blocked.
16. Accept a valid interpretation.
17. Restart or resume the session and confirm state restoration (phase, autonomy, task, toggles).
18. Confirm context output redacts a test credential.
19. Confirm no raw provider payload was written to disk.

Do not use real credentials for redaction testing.

---

# Documentation requirements

All documentation must follow the plain-language requirement from the workflow section: explain what each file and command is for and when the user would touch it, without assuming prior experience writing agent extensions or prompt files.

## `README.md`

Include:

* Project purpose.
* Installation: `pi install ~/Documents/pi-control-plane`, what it changes in `~/.pi/agent/settings.json`, and how to uninstall (`pi remove`).
* A "what each file does" section covering every file in the repository, in plain language.
* Command reference.
* Hotkey reference, including the plain-language recipe for rebinding the phase cycle to `shift+tab` and what that displaces.
* Default safe behavior.
* Example workflow.
* Pi built-ins worth knowing alongside the control plane: `/compact` (summarize old context), `/new` (fresh session), `/hotkeys`, `/model`.
* Current limitations.
* Development and test commands.

Provide an example workflow:

```text
/context
/interpret Refactor the configuration loader and verify backward compatibility.
/task accept
/phase plan
/phase execute
/autonomy attended
...
/phase verify
```

Explain that changing phase and autonomy does not alter the model's thinking level.

## `docs/ARCHITECTURE.md`

Document:

* Extension lifecycle.
* State model.
* Context snapshot model.
* Source-toggle mechanism and its honest-reporting rule.
* Task-brief injection.
* Command flow.
* Tool authorization precedence.
* Major extension points for later milestones (including where an `unattended` autonomy mode, web search, and a scratchpad would attach).

## `docs/SECURITY.md`

Document:

* Threat model.
* Trust boundaries.
* Secret-redaction limitations.
* Why Restricted is not a sandbox.
* Why shell commands are entirely blocked in Read-only.
* Why command-pattern-level classification is never used for allow decisions.
* Unknown-tool behavior.
* Path-validation behavior.
* Fail-closed defaults.
* Data that is and is not persisted.

## `docs/TESTING.md`

Document:

* Unit-test commands.
* Smoke-test procedure.
* Expected results.
* How to test without exposing credentials.
* Known environment-dependent tests.

---

# Explicit non-goals

Do not implement any of the following during this task:

* Real operating-system sandboxing.
* Container orchestration.
* Bubblewrap, Firejail, seccomp, or namespace isolation.
* Custom context compaction (Pi's built-in `/compact` already exists — surface it, don't rebuild it).
* Unattended/autonomous execution mode.
* Web-search integration.
* Structured long-term scratchpad.
* Local-model routing.
* Automatic provider routing.
* Model benchmarking.
* Git commits or automatic release creation.
* Third-party Pi extension installation.
* Importing all Claude Code or Codex skills.
* Credential management.
* Global configuration rewriting.
* Custom system-prompt replacement.
* Autonomous task decomposition across multiple agents.
* Background daemons.
* Telemetry.
* A remote control plane.
* A graphical configuration editor.

## Planned next milestones (leave seams, build nothing)

These are wanted features, deliberately deferred until the enforcement layer above is proven. Design so they can attach later without a rewrite, and list them in the final report:

1. **Unattended autonomy mode** — a fourth autonomy level in the existing cycle, gated behind the proven Attended/Restricted enforcement.
2. **Web search** — should integrate the user's existing local searxng instance (port 8888) rather than a paid API.
3. **Programming scratchpad** — structured working notes surviving compaction.
4. **Permission-based file-system access beyond the project root** — an allowlist extension of the Restricted policy model.

Do not build placeholders that pretend to implement them.

---

# Failure and fallback rules

Follow these decision rules:

1. If a Pi API is unavailable, verify the installed types and official documentation.
2. If the requested behavior cannot be implemented safely, fail closed.
3. If confirmation UI is unavailable, Attended mode must block risky operations rather than permit them.
4. If context data is unavailable, display `Unavailable`; do not invent it.
5. If state restoration fails, use Discuss plus Read-only.
6. If policy parsing fails, use Read-only.
7. If a tool is unknown, treat it as unsafe.
8. If a path cannot be canonicalized, deny it.
9. If a source cannot honestly be excluded, mark it `not toggleable`; never fake a toggle.
10. If a desired default hotkey is already bound in Pi, choose a free key and document the rebind path; never silently clobber an existing binding.
11. If a test exposes a design error, fix the implementation rather than weakening the test.
12. If a feature requires substantial scope expansion, document it as deferred.
13. Do not claim a real sandbox exists.
14. Do not claim completion when required tests remain failing.

---

# Completion criteria

This milestone is complete only when:

* All five top-level commands are registered.
* The repository is installed as a local pi package and loads on Pi startup.
* `/context` reports useful, redacted effective-context information.
* `/context diff` detects meaningful changes.
* `/context sources` lists prompt sources with honest toggle status, and `/context toggle` works for at least the source categories Pi's API genuinely supports.
* `/task` maintains an accepted session-persistent task brief.
* `/interpret` runs without tools and produces a pending task interpretation.
* `/phase` changes behavior, not just UI text.
* `/autonomy` changes tool authorization, not just UI text.
* The three hotkeys (context preview, phase cycle, autonomy cycle) work and collide with nothing.
* Discuss, Plan, and Verify block mutation.
* Read-only blocks all unapproved mutation, shell execution, network access, and unknown tools.
* Attended requires confirmation for risky tools.
* Restricted applies a validated project-bound policy.
* Invalid state and policy data fail closed.
* State restores from the Pi session.
* Context inspection does not automatically persist raw prompts or provider payloads.
* Secret-pattern redaction is tested.
* Unit tests pass.
* Available smoke tests pass.
* Documentation accurately describes implemented behavior and limitations, in plain language.
* Any modified pre-existing config file has a `.bak.<description>-YYYYMMDD-HHMMSS` backup.
* No unrelated files are modified.
* No commits, tags, pushes, or releases are created.

Stop after completing this milestone.

Do not continue into unattended mode, web search, scratchpad, custom compaction, or model routing.

---

# Final response format

Return a final implementation report using these exact headings:

```text
## Result

## Architecture implemented

## Commands implemented

## Keybindings registered

## Safety behavior

## Files created

## Files modified

## Tests run

## Test results

## Manual validation

## Known limitations

## Deferred milestones

## Repository status
```

Under `Repository status`, include the output of:

```bash
git status --short
```

Be explicit about anything that could not be validated in a live Pi session.
