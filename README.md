# Pi Control Plane

A control-plane extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono). It makes visible — and actually enforces — four things that are normally invisible while an agent works:

1. **What the model can see** (context files, skills, tools, system prompt, token usage) — `/context`
2. **What the model thinks it is doing** (an explicit, reviewable task brief) — `/task`, `/interpret`
3. **What the model is allowed to do right now** (one merged setting: Discuss / Plan / Execute (attended) / Execute (restricted) / Execute (unattended) / Verify) — `/mode`

The central rule: **you can inspect and correct Pi's context and task interpretation before Pi is permitted to modify anything.** Enforcement is real — a mode that would only change a label is treated as a bug.

## Installation

```bash
pi install ~/Documents/pi-control-plane
```

This adds the package to `~/.pi/agent/settings.json` (`packages` list). Nothing else is changed. To uninstall:

```bash
pi remove ../../Documents/pi-control-plane   # the path as shown by: pi list
```

A backup of `settings.json` from before the first install exists at `~/.pi/agent/settings.json.bak.pre-control-plane-<timestamp>`.

## Default behavior (safe by default)

Every new session starts as:

| Setting | Default | Meaning |
|---|---|---|
| Mode | **Discuss** | No file writes, no shell, no mutation of any kind; only `read`, `grep`, `find`, `ls` run |
| Task | none | No task brief accepted |

If anything fails to load or validate (saved state, the Restricted policy), the extension falls back to these defaults — never to a more permissive mode.

The footer shows a live status segment:

```text
Mode: Discuss | No task | Context 12% full
```

The extension also replaces pi's cryptic stats line (`↑4.2k ↓30 R4.2k CH99.2% 8.6%/49k`) with plain words:

```text
sent 4.2k · received 30 · cache 4.2k reused (99.2% hits) · context 8.6% of 49k
```

- **sent / received** — cumulative tokens sent to and received from the model this session.
- **cache … reused / stored (…% hits)** — prompt-cache tokens read/written, and the latest turn's cache hit rate.
- **cost $…** — cumulative API cost (shown only when nonzero).
- **context … of … tokens at last request (model tokenizer)** — the exact size of the last provider request, counted by the model's own tokenizer through llama-swap (`/v1/messages/count_tokens` for Anthropic-shaped payloads, `/upstream/<model>/apply-template` + `/tokenize` for OpenAI-shaped ones). Yellow above 70%, red above 90% of the window.
- **context ~…% of … (estimated)** — fallback when no exact count is available yet (before the first request, or when the provider does not answer the counting endpoints): pi's internal estimate, labeled as such.

Pi's "(auto)" auto-compact indicator is not shown: extensions cannot observe that setting, and the control plane never guesses values it cannot verify.

A live `Token Counter: ~N` sits at the bottom right of the input box, estimating the token cost of what you are typing. It is an estimate (~4 characters per token — no tokenizer runs in-process), hence the `~`. Below it, `Added Context: ~N` shows the tokens that will accompany your draft when it is sent — system prompt, conversation history, and tool definitions — counted **before sending** by the model's own tokenizer while the agent is idle (refreshed after every turn, profile change, and at session start; never per keystroke). After the first request the count is built from the real last request plus what arrived since, and lands within a couple of tokens of the actual next request. Before the first request it is reconstructed from scratch and can undercount somewhat (pi adds serialization the extension cannot see); hence the `~`. `?` appears only when nothing could be counted at all.

## Commands

### `/context` — what does the model actually see?

- `/context` — redacted summary: provider, model, token usage, message counts, context files, skills, prompt templates, active tools, system-prompt hash, provider-payload hash. Values the extension cannot observe print as `Unavailable`, never guessed.
- `/context diff` — what changed since the last `/context` or `/context full` (sources, tools, skills, model, tokens, hashes). The first run establishes the baseline.
- `/context full` — detailed view including the redacted system prompt (size-limited, truncation marked). Prints a warning first: redaction is pattern-based and cannot guarantee every secret is caught.
- `/context sources` — every prompt source with its toggle status: `enabled`, `disabled`, or `not toggleable`.
- `/context restore` — remove the `alt+e` context override (see the context editor section below).
- `/context recount` — re-count the last provider request with the model's own tokenizer (via llama-swap) and compare against pi's estimate. The same count feeds the footer's context segment automatically after every request.

The exact count also drives context-fullness warnings: a warning notification at 75% of the window and an error-level one at 90%, each fired once until usage drops back below 75% (e.g. after `/compact`). This matters because pi's built-in auto-compaction watches its own estimate, which can be off by a large margin (46% observed) — the control plane warns from the accurate number so you can `/compact` before the window actually overflows.
- `/context profile [name]` — tool profiles: named loadouts that enable exactly the listed tools and toggle everything else off (big context savings when many extensions are installed — e.g. `minimal` cut 19 of 26 tools in testing). No argument lists profiles and marks the active one; `all` re-enables everything *except* `policy/profiles.json`'s `alwaysDisabledTools` (see below) — `all` has never meant "literally every tool, no matter what" since that field was added. Ships with `minimal` (core coding tools) and `reading` (read-only tools). Define your own in `policy/profiles.json` — or just ask pi to "create a context profile for X": the bundled `create-context-profile` skill walks it through the schema, validation, and `/reload`. Applied profiles persist with the session like any toggle.
- **`alwaysDisabledTools`** (`policy/profiles.json`, top-level, alongside `profiles`/`defaultProfile`): tools forced off every time *any* profile is applied — including `all` — regardless of which one. This is not another profile; it is a hard denylist layered on top of whichever allowlist a profile computes, specifically for when two installed extensions do the same job and you want exactly one of them reachable no matter which profile gets picked later. Ships with `["web_search"]`: `pi-web-access`, if installed, registers a tool of that exact name, and this package's own `local_web_search` (see below) is the local/free alternative — both being active at once means the model has to guess between two tools for one job, and Pi's tool registry has no picker to help it the way command-name collisions get one (see the `local_web_search` section for why that matters). A tool individually re-enabled afterward with `/context toggle tool:<name>` stays that way for the session — this only guards *bulk* profile application, never a deliberate single-tool override. Restored sessions are never touched by it; only fresh ones.
- `/context toggle <name>` — turn a source on or off for subsequent turns:
  - `tool:<name>` — genuinely removed from the model's tool list.
  - `file:<path>` — the file's content is excised from the system prompt each turn, **with verification**. If the excision cannot be verified, the toggle is reverted and you are warned — a source is never shown as disabled while it still reaches the provider.
  - `skill:<name>` — same verified-excision approach for the skills section.
  - `template:<name>` — not toggleable (Pi provides no honest way to exclude these); shown for visibility only.

When context usage passes 75%, `/context` reminds you that Pi's built-in `/compact` summarizes old context and `/new` starts a fresh session. The control plane does not reimplement compaction.

### `/task` — what does the agent believe it is doing?

- `/task` — show the accepted task brief and any pending interpretation.
- `/task set <text>` — set a task brief directly. Only your text is stored as the objective; structured fields are never fabricated.
- `/task accept` — adopt the pending `/interpret` result as the active brief. Refused if the interpretation was invalid.
- `/task reject` — discard the pending interpretation, leaving the accepted task unchanged.
- `/task clear` — clear both (asks for confirmation; `/task clear force` skips the dialog).
- `/brief` — collision-free alias for `/task`. Other extensions may also register `/task` (e.g. pi-task); when the name is ambiguous, pi's TUI shows a picker but non-interactive modes route unpredictably — `/brief` always reaches the control plane.

The accepted brief is injected into the system prompt each turn (objective, scope, constraints, unknowns, completion criteria, approval boundaries) together with behavioral requirements — including "do not claim completion without verification evidence".

### `/interpret <request>` — the interpretation gate

Runs one **no-tools turn** in which the model must restate the task as twelve required sections (Objective, Deliverables, Included/Excluded scope, Constraints, Assumptions, Unknowns, Proposed actions, Completion criteria, Approval boundaries, …). During this turn **every** tool call is blocked, and blocked attempts are recorded as diagnostic entries. Afterwards, the previous mode is restored and you decide: `/task accept` or `/task reject`. A response missing required sections is kept for display but cannot be accepted.

Your request text is wrapped in delimiters and treated as data — it cannot masquerade as control-plane instructions.

### `/scratchpad` — structured working notes that survive `/compact`

- `/scratchpad` — list current notes (id, timestamp, text).
- `/scratchpad add <text>` — add a note.
- `/scratchpad remove <id>` — remove one note.
- `/scratchpad clear` — remove all notes (asks to confirm; `force` skips the dialog).

Persisted as its own session entry, the same way control-plane state is: excluded from LLM context, untouched by `/compact` (which only summarizes messages), and injected into the system prompt every turn so the model can actually see and use its own notes across a compaction that would otherwise have wiped that context. The control plane never writes, edits, or summarizes a note's text itself — it only stores what it is told and shows back what is there.

### `/mode` — what is the model allowed to do right now?

One merged setting (workflow stage and permissions used to be two separate settings — `/phase` and `/autonomy` — which allowed contradictory combos like Execute + Read-only; they are now one):

- `discuss` — talk only. Every mutating tool blocked; reads (`read`, `grep`, `find`, `ls`) allowed. Shell is blocked entirely — commands are never parsed to guess whether they are "safe" (pattern-level command filtering proved unreliable in practice; whole-tool denial is reliable).
- `plan` — same permissions as discuss, framed for planning.
- `execute` — changes allowed, **attended**: reads inside the project run freely; anything risky (writes, edits, shell, unknown tools, reads outside the project root) pops a confirmation dialog showing the tool, risk category, target/command, and whether it is inside the project root. Denying blocks the call. If no confirmation UI exists (e.g. print mode), risky calls are blocked — never silently allowed.
- `execute-restricted` — changes allowed under policy, no confirmations: writes only inside the project root or an allowlisted prefix (`policy.allowPathPrefixes`, off by default — see `policy/default-policy.json`), paths canonicalized, symlinks resolved, `..` traversal caught, credential paths blocked (`.env`, `.ssh`, `.aws`, etc.), shell blocked by default, unknown tools always blocked. If the policy file is missing or invalid, enforcement falls back to read-only. (`restricted` is accepted as shorthand.)
- `execute-unattended` — identical policy enforcement to `execute-restricted` (same file, same rules, same allowlist), but requires an accepted task brief first — `/interpret` + `/task accept`, or `/task set <text>` — before any mutating or shell call is permitted; without one, every mutating call is blocked (reads are unaffected). Every *allowed* mutating/shell call is logged as a diagnostic entry, since this is the one mode meant to run with nobody confirming actions in real time. (`unattended` is accepted as shorthand.) See `docs/SECURITY.md` for the full reasoning.
- `verify` — read-only again, framed for checking the work. When verification reveals a needed change, switch back to `execute`.
- `sandboxed` is accepted only as an alias for `execute-restricted` and prints: *"This mode provides Pi-level policy restrictions, not operating-system isolation. It is not a security sandbox."* The status bar never displays "Sandboxed". See `docs/SECURITY.md` for why this distinction matters.

Sessions saved before the merge restore safely: a legacy combination that no longer exists is coerced to the nearest mode **without ever escalating permissions** (e.g. Plan + Attended restores as Plan; Execute + Read-only restores as Discuss).

### `/bwrap` — real OS-level isolation for `bash`, independent of `/mode`

`/mode`'s `sandboxed` alias (previous section) is Pi-level policy only — no OS isolation, by its own admission. `/bwrap` is the actual OS-level isolation: when on, every `bash` call that `/mode`'s policy layer already allowed (or a human already confirmed) is additionally wrapped in [bubblewrap](https://github.com/containers/bubblewrap) — unprivileged Linux user namespaces — before it runs. The two are independent and stack: `/mode execute` (per-command confirmation) + `/bwrap on` (kernel-enforced containment of whatever gets confirmed) is a reasonable combination, not a redundant one.

- `/bwrap` / `/bwrap status` — show whether the sandbox is on, whether networking is shared, and whether the `bwrap` binary is actually on `PATH`.
- `/bwrap on` — enable. Refuses (with an error, not a silent no-op) if `bwrap` is not installed.
- `/bwrap off` — disable (default).
- `/bwrap network on` / `/bwrap network off` — allow or unshare networking for sandboxed commands (default off, same "safe by default" posture as everything else in this package).

What the sandbox binds, every time, freshly resolved per call (see `sandboxOptionsFor` in `extensions/control-plane.ts`):

- The project root — read-write. This is the entire point: code the agent may still modify.
- Standard system directories (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, `/opt`) and `$HOME` — read-only, so interpreters, package managers, and toolchains under `$HOME` (nvm, cargo, a user pip install, …) resolve normally.
- Credential paths from `policy/default-policy.json` (`denyPathSubstrings`, `denyPathBasenames`) — blanked inside `$HOME` (empty `tmpfs` over directories, `/dev/null` over files) so `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.pi/agent`, `~/.docker/config.json`, and friends are unreadable from inside the sandbox even though the rest of `$HOME` is bound in. This deliberately reuses the *same* deny list the `read`/`edit`/`write` tools already enforce rather than maintaining a second one that could drift — see `docs/SECURITY.md` for what this reuse does and does not cover (basename patterns like a stray `.env` are only shadowed at `$HOME`'s top level, not everywhere on disk).

Fails closed: if the sandbox is on and `bwrap` disappears from `PATH` mid-session, the `bash` call is blocked with an explicit reason rather than silently running unsandboxed.

## Hotkeys

| Key | Action |
|---|---|
| `alt+c` | Toggle a context-preview widget above the editor |
| `alt+e` | Open the session context in **nvim** to view and edit it |
| `alt+s` | **Send preview**: everything the next message will send — system prompt (with the auto-appended control-plane block shown read-only), full history, and your unsent draft — in nvim, editable |
| `alt+t` | Tool-profile picker: modal with profile names in a left column (1/5 width) and, on the right, the selected profile's description over its tool list. ↑/↓ or j/k select, **enter** applies for this session only, **space** also saves it as the default for new sessions (written to `policy/profiles.json` as `defaultProfile`), esc closes; `*` marks the active profile, `(default)` the default one |
| `alt+p` | Cycle mode: Discuss → Plan → Execute (attended) → Execute (restricted) → Execute (unattended) → Verify |
| `alt+h` | Hotkey cheat sheet as a centered modal (any key closes; `/hotkeys` lists everything) |

`alt+s` is `alt+e` plus two things: lines prefixed `#> ` show the control-plane state block exactly as it will be appended to the system prompt (read-only — edits to them are ignored), and a `DRAFT` section holds your unsent message — editing it rewrites the input box on save. Context edits behave identically to `alt+e` (override, `Context edited`, `/context restore`).

### The context editor (`alt+e`)

`alt+e` suspends the TUI and opens the current session context — the system prompt plus every message the model would receive — in nvim (falls back to vim). Each message sits under a marker line; edit the text, delete whole message sections to remove them, `:wq` to apply, `:q!` to cancel.

- Edits become an **override for future turns in this session**: the model sees your edited history instead of the original. The session file is never rewritten — the chat scrollback still shows what really happened.
- Tool calls, tool results, thinking, and images appear as `[non-text: …]` placeholders and are preserved exactly; only text is editable. (Deleting one half of a tool call/result pair can make the provider reject the request — if that happens, `alt+e` again or restore.)
- `/context restore` removes the override. The footer shows `Context edited` while one is active.
- The override lives in memory only: it does not survive quitting, `/reload`, or compaction (compaction invalidates it with a notification, since the conversation no longer lines up).
- Malformed edits (broken markers, missing system-prompt section) are rejected whole — nothing half-applies.

**Why not shift+tab?** Pi already binds `shift+tab` to cycling the thinking level, so these default elsewhere. If you prefer Claude-Code-style `shift+tab` for the mode cycle, add this to `~/.pi/agent/keybindings.json` to move the *thinking* cycle somewhere else first, then the control plane's binding can take its place — see Pi's `docs/keybindings.md` for the file format:

```json
{
  "app.thinking.cycle": "ctrl+shift+t"
}
```

Then edit `extensions/control-plane.ts` in this repo and change `"alt+p"` to `"shift+tab"` in the `registerShortcut` call near the bottom, and run `/reload`. Trade-off: you lose one-key thinking-level cycling on its default key.

## Web search (`local_web_search` tool)

Registered directly by this package (no separate extension needed): searches the user's local searxng instance rather than a paid API. Classified as a read tool — available in every mode including Discuss/Plan/Verify, not gated behind Execute, since it never mutates anything. Targets `http://127.0.0.1:8888` by default; override with the `PI_CONTROL_PLANE_SEARXNG_URL` environment variable if searxng runs elsewhere. If `typebox` (the parameter-schema library) is not resolvable in the current environment, the tool is silently not registered rather than failing extension load — same fallback pattern already used for the Pi SDK imports themselves.

**Named `local_web_search`, not the more obvious `web_search`:** if you also have `pi-web-access` (or any other extension shipping a tool literally named `web_search`) installed, Pi's tool registry is a flat last-registered-wins map — there is no collision error and no picker the way colliding *command* names get one. A same-named tool from an extension that loads later in `packages` (`~/.pi/agent/settings.json`) would silently and completely replace this one; the model would never see it again, with no warning anywhere. Check `pi list` and grep for `registerTool` in anything else you install before assuming a new tool this package adds is actually reaching the model.

## Audio transcription (`transcribe_audio` tool)

Transcribes voicemails, call recordings and any other ffmpeg-readable audio or video file to plain text, using a local whisper.cpp `large-v3-turbo` model. Nothing leaves the machine. Like `local_web_search` it is classified as a read tool, so it works in Discuss/Plan/Verify as well as Execute, and it is likewise not registered at all if `typebox` cannot be resolved.

```text
transcribe_audio(path: "~/voicemails/2026-08-11-0912.mp4")
transcribe_audio(path: "call.m4a", language: "auto")
```

**It is off under the default profile.** Fresh sessions auto-apply `defaultProfile` (ships as `minimal`), and profiles are allowlists — `transcribe_audio` is no more in `minimal` than `local_web_search` is. Reach it with `/context profile voicemail` (a bundled profile: transcription plus read tools and `write`, for saving transcripts out), `/context profile all`, or `/context toggle tool:transcribe_audio` for just this one. The `defaultProfile` is deliberately left alone here; change it yourself with **space** in the `alt+t` picker if you want transcription on by default.

**Phone numbers come back as digits, not words.** Three layers, weakest to strongest:

1. the whisper server runs with an initial `--prompt` whose example callback numbers are digit-formatted, biasing the decoder's output style;
2. `large-v3-turbo` already emits digits unprompted for clean speech (measured: 3/3 identical runs on a phone-band fixture);
3. `normalizeSpokenDigits()` in `src/control-plane/transcription.ts` deterministically collapses runs of spoken digit words — `"five five five, one two three four"` becomes `555-1234`. Only layer 3 is a guarantee rather than a tendency.

Layer 3 is deliberately conservative: it rewrites a run only when it lands on a US phone shape (7, 10, or 1+10 digits), a numeral can never *start* a run (so `"in 2024 one two three"` is untouched), and a run that misses those shapes is emitted verbatim rather than re-scanned from its second word. `"one of the tenants"` stays prose. The cost of that caution is that international numbers outside those lengths are not reformatted — they are still whatever whisper emitted, which is normally already digits.

**Backend.** The tool posts to the `whisper-voicemail` model in `~/.config/llama-swap/config.yaml` (`http://127.0.0.1:9292/v1` by default; override with `PI_CONTROL_PLANE_TRANSCRIBE_URL`, and the model id with `PI_CONTROL_PLANE_TRANSCRIBE_MODEL`). That entry runs on the **GPU (Vulkan0)** and lives in llama-swap's exclusive `chat` group. Measured on real 8kHz voicemails: 0.03–0.04x realtime (a 32.8s voicemail transcribes in ~1.0s; 1.8s cold through llama-swap). It was CPU-only until 2026-08-11 — GPU is ~15x faster on identical audio and flags.

Two consequences worth knowing:

- **Transcribing evicts your loaded chat model**, and the next chat turn reloads it. That is the price of the exclusive group, and the group is not optional: peak VRAM here is 1234 MiB while the tightest chat entries leave under 1 GiB free, so a free-floating GPU entry would attempt an allocation it cannot satisfy — the failure mode behind this box's amdkfd crashes.
- **The group does not protect against processes llama-swap doesn't manage.** `ds4-server` (hermes' default provider on :8000) was measured holding 18.5 GiB while llama-swap believed only whisper was loaded. Check `rocm-smi --showpids` before raising the model size here.

The tool's request ceiling stays at 15 minutes — a cold start may have to evict a 23 GiB model before loading weights.

Multiple files in one Pi request are safe: `transcribe_audio` is registered with
sequential execution. Pi otherwise runs sibling tool calls in parallel; a live
two-voicemail directory test showed that concurrent Whisper requests could both
return HTTP 200 while their text drifted from the deterministic single-file
results. Sequential execution keeps each upload on an isolated inference pass.

**Same logic from outside Pi.** `bin/transcribe-voicemail.ts` is a CLI over the identical module — it prints the transcript to stdout and nothing else:

```bash
./bin/transcribe-voicemail.ts ~/voicemails/2026-08-11-0912.wav
./bin/transcribe-voicemail.ts call.mp4 --language auto --output call.txt
```

That is how the Hermes agent reaches it too, wired as an `stt.providers.voicemail: type: command` provider in `~/.hermes/config.yaml`. Hermes' built-in `openai` STT provider *cannot* be pointed at llama-swap instead: it builds its client with a hardcoded `timeout=30`, which a voicemail much past a minute would exceed once a cold start is added. Routing both agents through this one module also means there is a single implementation of the phone-number rules for them to agree on.

**Hermes rewrites its own `config.yaml` and drops every comment when it does** (observed: it reflowed the `command:` string and stripped an entire commented rationale block, while leaving the settings themselves correct and working). Do not keep durable reasoning in that file — it lives here and in `docs/ARCHITECTURE.md` instead. Re-verify the `stt` block after anything causes Hermes to write its config.

## Example workflow

```text
/context
/interpret Refactor the configuration loader and verify backward compatibility.
/task accept
/mode plan
/mode execute
...
/mode verify
```

Note: the mode controls what *tools* may do. It does not change the model or its thinking level.

## Pi Harness (`/harness`, second extension)

The control plane above governs one session: what the model can see, what it
believes it is doing, and what it is allowed to touch right now. The **Pi
Harness** is a second, independent extension in this same package that
governs what persists *between* sessions — authority, durable state,
evidence, and recovery. Its specification is `ARCHITECTURE2.md` at the repo
root (v0.2); the acceptance invariants it is built against are section 27
there, and the v0.2 integration-hardening delta is section 32.

The organizing idea is that Pi is the persistent agent and models are
interchangeable workers. Switching models changes who is reasoning; it
changes nothing about scope, approval posture, or the current task.

| Command | What it does |
|---|---|
| `/harness status` | Session, project, scope, coordinator, autonomy, approval posture, sandbox availability |
| `/harness scope [approve <path>\|network on\|off]` | Show scope; grant a wider one; grant or revoke sandbox networking |
| `/harness authority <actor>` | What that actor may ever do, plus the constitutional rules no model can change |
| `/harness audit` | The most recent append-only audit events |
| `/harness capability [grant\|revoke <tool> <reason>]` | The tool catalog, what is active, and per-session exceptions for unconfined tools |
| `/harness recover` | Reconcile persisted state against the real environment; reports conflicts and uncertainties rather than resolving them |
| `/harness checkpoint <verified state>` | Record a verified resume point and flush `WORKSTATE.md` |
| `/harness-mode reasoning\|autonomy\|approval <value>` | Reasoning style and autonomy are independent controls |
| `/harness-task list\|new\|status` | The explicit task queue — nothing becomes a task by being mentioned |
| `/harness-decide`, `/harness-incident` | First-class decision and incident records |
| `/harness-memory list [all]\|search\|add [global\|project]` | Durable memory, typed as fact / assumption / opinion, and scoped global or per project |
| `/harness-review list\|run [id]` | The retrospective review queue, and running a reviewer over an archived session |
| `/harness-policy show\|set <level> <field> <value>` | Durable soft policy: global, device and project layers, resolved broadest-first |
| `/harness-identity show\|add\|remove` | Who Pi is across sessions and models. User-writable only; injected into every turn |
| `/harness-goal list\|new\|status\|link\|check` | Goals above tasks and relationships between projects. Advisory, never permissions |

Tools it registers: `pi_harness_bash` (the only permitted shell path),
`harness_request_scope`, `harness_memory_search`, `harness_note`,
`harness_find_capability`, `harness_delegate` (read-only advisor or bounded
subagent under an explicit delegation contract), and `harness_set_posture`.

What it enforces rather than merely displays:

- **The builtin shell is blocked.** `bash` is removed from the active tool set
  *and* denied at the `tool_call` seam, so another extension restoring the
  tool set does not reopen it. `pi_harness_bash` runs under bubblewrap or
  refuses — there is no fallback to an unenforced shell.
- **Scope is an authority object.** One automatic expansion to the next
  boundary is available per scope, and it is spent, not renewed. Anything
  wider needs the user. Symlinks are resolved before the comparison.
- **Authority is per actor.** A coordinator cannot promote durable memory, a
  reviewer cannot mutate files, an advisor can only read, and no actor —
  including the user — has an operation that rewrites audit history.
- **A subagent cannot exceed its parent.** Delegation contracts derive scope,
  autonomy, and approval by intersection, so there is no parameter through
  which a child gets more than the parent had.
- **Claimed and validated completion are different fields.** So are observed
  effect and suspected cause on an incident, and fact, assumption, and
  opinion in memory.

Added in v0.2 (section 32):

- **Scope carries a ceiling, not just a budget.** Narrowing is
  authority-reducing and may happen automatically — which means a narrowed
  scope must be able to step back out, which means it could otherwise walk
  out one legal step at a time past anything the user authorized. The
  ceiling is the limit those steps can never cross; only a user approval
  moves it.
- **Tools are catalogued, not automatically active.** The active set is
  computed from the catalog rather than inherited, so a tool the harness
  cannot resolve a target for is `unconfined` and stays inactive until the
  user grants a per-session exception. It is labelled unconfined in the
  prompt and in the audit log — never described as sandboxed. **This
  withholds `local_web_search` and `transcribe_audio` by default**, since
  from the harness's side they are another extension's tools.
- **Loosening posture needs the user.** The coordinator may change reasoning
  style freely and may tighten its own autonomy or approval, but "ask me less
  often" is the same act as enlarging scope and is gated as one — even under
  `approvalPolicy: "none"`, so a posture of never-ask cannot extend itself.
- **Audit events are SHA-256 hash chained, with an endpoint commitment.**
  Editing a stored event is detected at that line; deleting events off the
  end is detected by a separate `audit.tip.json`, because a chain commits to
  order and content and to nothing about length. This is not tamper-proofing
  — anything that can write the log can usually write the tip beside it. What
  it covers is accidents, crashes, and a model, and the reason a model is
  covered is that the harness home sits outside every project scope. v0.1
  records carry no hash and are declared a legacy-unverified prefix that the
  first chained event anchors to; no hash is ever back-filled, because that
  would claim a protection that did not exist when the record was written.
- **State is per session, with a global index.** `sessions.json` maps a
  session id to its project root, structured state lives at
  `projects/<hash>/sessions/<id>.json`, and `.pi/workstates/<id>.md` sits
  alongside `WORKSTATE.md`. In v0.1 the second session in a project
  overwrote the first.
- **Durable memory is global or project-scoped.** Default retrieval is global
  plus the current project, so one repository's lesson stops following you
  into unrelated ones.
- **A reviewer is accepted only on evidence.** Complete read of the session,
  valid output shape, and every finding, pattern, lesson, unresolved item and
  memory candidate citing a real entry id from that session. Repeated reviews
  are stored as separate generations rather than overwriting the earlier
  reading.

State lives in `~/.pi/agent/pi-harness/` (override with `PI_HARNESS_HOME`),
plus a human-readable `.pi/WORKSTATE.md` in the project — a recovery
snapshot that is explicitly *not* authoritative: structured state and the
observed environment both outrank it.

`VALIDATION.md` records what has actually been executed against a real Pi,
including an adversarial pass in which seven of fourteen constructed attacks
succeeded on the first run; `BUILD_STATUS.md` records what is still asserted
rather than shown, and what the adversarial pass deliberately did not close.
`node bin/build-isolated.mjs` produces the harness as a standalone package in
the layout of `ARCHITECTURE2.md` section 29.

## What each file does

| File | What it is |
|---|---|
| `extensions/control-plane.ts` | The extension entry point Pi loads. Pure wiring: registers commands, hotkeys, event hooks. The logic lives in `src/`. |
| `src/control-plane/types.ts` | Shared type definitions and constants (modes, state shape). |
| `src/control-plane/state.ts` | Safe defaults, validation, and restoration of saved state. Anything malformed falls back to Discuss + Read-only. |
| `src/control-plane/tool-policy.ts` | The authorization engine: tool classification, path canonicalization, and the allow/confirm/block decision. |
| `src/control-plane/redaction.ts` | Pattern-based secret redaction applied before any context is displayed or hashed. |
| `src/control-plane/context-snapshot.ts` | Builds the content-free context snapshot (names, counts, hashes — never raw content). |
| `src/control-plane/context-diff.ts` | Compares two snapshots for `/context diff`. |
| `src/control-plane/interpretation.ts` | Builds the `/interpret` prompt, parses the response, creates task briefs. |
| `src/control-plane/toggles.ts` | Verified excision of toggled-off sources from the system prompt. |
| `src/control-plane/scratchpad.ts` | Structured working notes: validation, persistence/restoration, and rendering. Same patterns as `state.ts`, applied to its own entry type. |
| `src/control-plane/sandbox.ts` | Bwrap command-line assembly and its own persisted on/off + network toggle. Pure: builds a command string, never spawns anything itself. Same patterns as `state.ts`/`scratchpad.ts`. |
| `src/control-plane/websearch.ts` | Pure searxng client (injected fetch): URL building, response parsing, result formatting. No Pi imports. |
| `src/control-plane/commands.ts` | Argument parsing for every command (so bad input handling is testable). |
| `src/control-plane/ui.ts` | All text formatting: status line, summaries, denial messages, the injected state block. |
| `policy/default-policy.json` | Restricted/Unattended-mode rules: denied path names/substrings, whether bash is allowed (default: no), out-of-root allowlist prefixes (default: none). Also the credential-path source of truth `/bwrap`'s `$HOME` shadowing reuses. Edit carefully — an invalid or old-schema file makes Restricted/Unattended behave as Read-only. |
| `extensions/pi-harness.ts` | The harness extension entry point. Wiring only, same discipline as `control-plane.ts`: enforcement points attached to Pi's events, decisions made in `src/harness/`. |
| `src/harness/types.ts` | Every persisted state contract (session, scope, task, decision, incident, memory, audit, delegation) plus the mode and actor vocabularies. |
| `src/harness/policy.ts` | The authorization decision: constitutional rules, the per-actor capability matrix, policy inheritance, and `authorize()` — deny-by-default, no model input. |
| `src/harness/scope.ts` | Scope as an authority object: symlink-safe canonicalization, the one-step automatic expansion, the ceiling that bounds where those steps can reach, and two distinct narrowings — automatic (re-expandable) and delegated (not). |
| `src/harness/store.ts` | The only module that does I/O: atomic whole-file writes for current state, append-only JSONL for evidence, and a reader that tolerates an interrupted append. |
| `src/harness/audit.ts` | Audit-event construction and the SHA-256 hash chain. Cannot write and cannot amend — a correction is a new event pointing at the old one. |
| `src/harness/capability.ts` | The tool catalog and the scope-aware / harness / unconfined classification that decides what the coordinator actually sees. |
| `src/harness/state.ts` | Session lifecycle, checkpoints, and the recovery reconciliation that reports conflicts instead of resolving them. |
| `src/harness/memory.ts` | Promotion, supersession, and the active view. Refuses a coordinator promotion and an uncited reviewer promotion. |
| `src/harness/records.ts` | Decision and incident constructors that refuse a decision with no rationale, a temporary decision with no revisit condition, and an incident with no observed effect. |
| `src/harness/tasks.ts` | The explicit task queue: frozen authority envelopes, legal transitions, and validated-vs-claimed completion. |
| `src/harness/agents.ts` | Delegation contracts, handoff parsing, the retrospective-review prompt/parse, and the evidence gate that accepts a reviewer only on a complete read, a valid shape, and real citations. Never spawns anything; execution is injected. |
| `src/harness/sandbox.ts` | The harness shell boundary: scope-derived mounts and fail-safe refusal. Reuses the control plane's bwrap argv builder rather than forking a second one. |
| `src/harness/workstate.ts`, `project.ts`, `config.ts`, `util.ts` | Recovery-file rendering, project-root inference, the storage layout, and ids/timestamps/keys. |
| `src/harness/identity.ts`, `goals.ts` | Identity state (user-writable only) and goals/project relationships, which inform recommendations and are structurally incapable of changing an authorization outcome. |
| `bin/build-isolated.mjs` | Builds the harness as a standalone package in the `ARCHITECTURE2.md` section 29 layout, rewriting imports and inlining the bwrap builder. One artifact, generated — never a hand-maintained second tree. |
| `VALIDATION.md`, `BUILD_STATUS.md` | What has actually been executed (with the ablations that make the checks discriminating), and what is still asserted rather than shown. |
| `tests/` | 505 unit, invariant, extension-harness, and adversarial regression tests. Run with `npm test`. |
| `docs/` | Architecture, security model, and testing guides. |
| `IMPLEMENTATION-PROMPT.md` | The specification the first milestone was built from. Milestone 2 (unattended autonomy, web search, scratchpad, out-of-root allowlists) is documented in `docs/ARCHITECTURE.md`. |
| `ARCHITECTURE.md` | The Pi Harness specification (identity, authority, memory, lifecycle, acceptance invariants). Distinct from `docs/ARCHITECTURE.md`, which documents the control plane. |

## Pi built-ins worth knowing alongside this

- `/compact` — summarize older context to free the window (the control plane points at this, it does not replace it)
- `/new` — fresh session (there is no `/clear` in Pi)
- `/hotkeys` — list active keybindings
- `/model` — switch models
- `/reload` — reload extensions after editing this repo

## Current limitations

- Chat-visible command output renders in interactive (TUI) mode only; in RPC/print modes command results surface as notifications where possible.
- "Reason Pi says the tool is needed" in Attended confirmations shows `Unavailable` — Pi does not expose the model's rationale for a tool call.
- Provider-payload length/hash appear only after the first LLM call of a session (the payload must be observed to be measured).
- Secret redaction is pattern-based: it reduces risk, it does not guarantee detection of every secret.
- Restricted and Unattended modes are policy enforcement inside Pi's process — **not** an operating-system sandbox (see `docs/SECURITY.md`).
- `local_web_search` depends on a local searxng instance being reachable; if it is not, the tool returns a clear error string to the model rather than throwing, but there is no fallback search source (deliberately not a paid API — see `docs/ARCHITECTURE.md`).
- `transcribe_audio` depends on llama-swap serving the `whisper-voicemail` model; if it is unreachable the tool returns an error string naming both rather than throwing. Its spoken-digit pass only reformats US phone shapes (7, 10, 1+10 digits) — that narrowness is deliberate (a false rewrite corrupts a transcript undetectably), but it means other number formats are left exactly as whisper produced them. Containers actually exercised end to end are wav, mp4 and m4a; the rest are inferred from whisper-server's `--convert` handing decoding to ffmpeg. The digit guarantee is an English-language one: with `language: "auto"` on non-English audio, whisper groups digits by that language's conventions and the phone-shape pass does not apply.
- Tool-name collisions across extensions are silent (last-registered-wins, no error) — unlike command-name collisions, which Pi disambiguates automatically. Verify with `pi list` + a grep for `registerTool` before assuming a newly added tool is actually reaching the model, especially after installing another extension.
- `harness_delegate` and `/harness-review run` register only when Pi's `createAgentSession` SDK export resolves at load time. Outside Pi it does not, so the tool is simply absent rather than throwing — the same guarded-degradation pattern the control plane uses for `pi-tui`. If the tool is missing inside Pi, that import is the first thing to check.
- The Pi Harness is smoke-tested inside a real pi process: `node tests/smoke/harness-smoke.mjs` (17 checks) and `node tests/smoke/harness-review-smoke.mjs` (the full retrospective-review loop, including a real reviewer model promoting cited memory). `harness_delegate` is now the only path never executed against a live model — it shares the nested-agent plumbing the reviewer exercises, but no advisor or subagent has actually run.
- Extension order matters. Pi short-circuits `tool_call` on the first blocking handler and the control plane is registered first, so a call it blocks never reaches the harness and is absent from the harness audit log. Calls the control plane *allows* are still independently scope-checked by the harness (the smoke test proves this by approving a write at the control plane prompt and watching the harness deny it).
- The harness `tool_call` gate reads a tool's target from a fixed list of argument keys (`path`, `file_path`, `filePath`, `filename`, `file`, `target_file`, `dir`, `directory`). A tool naming its target under some other key still reaches the gate — an unrecognized tool is classified as *mutating*, so it is gated and audited rather than waved through — but its path itself is not scope-checked. The residual risk is a mutating tool with an exotic argument name that the user then approves at the prompt.
- Live behavior is validated headlessly by `node tests/smoke/rpc-smoke.mjs` (17 checks over pi's RPC mode against llama-swap); only TUI rendering of dialogs/widget and terminal hotkey delivery still need a human check. See `docs/TESTING.md`.

## Development

```bash
npm test        # 505 tests, no dependencies, uses Node's built-in test runner
/reload         # inside pi, after editing extension code
```
