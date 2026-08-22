# Pi Harness

A persistent personal agent harness for the [Pi coding agent](https://github.com/earendil-works/pi-mono), built to `ARCHITECTURE2.md` (v0.3).

Pi is the persistent agent; models are interchangeable workers. This package
is the part that stays the same when the model changes: scope as an authority
object, append-only hash-chained evidence, durable state, recovery, and
bounded delegation.

Install by pointing Pi at this package:

```jsonc
// ~/.pi/agent/settings.json
{ "extensions": ["/path/to/pi-harness"] }
```

## What it enforces

| Rule | Where |
|---|---|
| The unrestricted builtin `bash` is blocked; `pi_harness_bash` runs under bubblewrap or refuses | section 9 |
| A path outside the working scope is refused, symlinks resolved first | S3, S6 |
| One automatic scope expansion, and never past the ceiling | S2, section 32 |
| Only the user and a reviewer may write durable memory | M1 |
| A reviewer's claim must cite a real entry from the session it read | M5, section 32 |
| Audit history is append-only and hash chained | AU1, section 32 |
| Delegates get exactly three attested inline read tools and no ambient resources | SA1–SA5 |
| Loosening autonomy or approval needs the user | A2, section 32 |
| A tool the harness cannot confine is catalogued, not activated | TO1, section 32 |

## Commands

| Command | What it does |
|---|---|
| `/harness status` | Session, project, scope, coordinator, posture, sandbox, audit-chain state |
| `/harness scope [approve <path>\|network on\|off]` | Show scope; grant a wider one; grant or revoke sandbox networking |
| `/harness authority <actor>` | What that actor may ever do, plus the constitutional rules no model can change |
| `/harness capability [grant\|revoke <tool> <reason>]` | The tool catalog, what is active, and per-session exceptions |
| `/harness audit` | Recent append-only audit events |
| `/harness recover` | Reconcile persisted state against the real environment; reports conflicts, does not resolve them |
| `/harness checkpoint <verified state>` | Record a verified resume point and flush `WORKSTATE.md` |
| `/harness-mode reasoning\|autonomy\|approval <value>` | Reasoning style and autonomy are independent controls |
| `/harness-task list\|new\|status` | The explicit task queue |
| `/harness-decide`, `/harness-incident` | First-class decision and incident records |
| `/harness-memory list [all]\|search\|add [global\|project]` | Durable memory, typed as fact / assumption / opinion |
| `/harness-review list\|run [id]` | Retrospective review queue, and running a reviewer over an archived session |
| `/harness-policy show\|set <level> <field> <value>` | Durable soft policy in three layers, resolved broadest-first |
| `/harness-identity show\|add\|remove` | Who the agent is across sessions and models. User-writable only |
| `/harness-goal list\|new\|status\|link\|check` | Goals above tasks, and relationships between projects. Advisory, never permissions |
| `/harness-delegate approve\|deny <contract> [exact-root]` | Resolve a blocked child read request |

Tools: `pi_harness_bash`, `harness_request_scope`, `harness_memory_search`,
`harness_note`, `harness_find_capability`, `harness_delegate`,
`harness_set_posture`.

## Capabilities are catalogued, not activated

The active tool set is computed from the catalog rather than inherited from
whatever loaded first. Scope-aware builtins and this package's own tools are
active; anything else is **unconfined** — the harness cannot resolve its
target, so it cannot honestly claim to confine it — and stays catalogued
until you grant a per-session exception:

```
/harness capability                                  # what exists, what is active
/harness capability grant some_tool needed for X     # this session only
```

The grant is never persisted. One in-conversation "yes" should not become a
durable authority expansion.

## State

`~/.pi/agent/pi-harness/` (override with `PI_HARNESS_HOME`), laid out per
`ARCHITECTURE2.md` section 28, plus per-session additions from section 32:

```text
sessions.json                          global session id -> project root
projects/<hash>/sessions/<id>.json     structured state, one file per session
projects/<hash>/audit.jsonl            append-only, SHA-256 hash chained
projects/<hash>/delegations.jsonl      append-only child lifecycle and crash/orphan state
reviews/<session-id>/001.json          one file per review generation
<project>/.pi/WORKSTATE.md             current recovery snapshot
<project>/.pi/workstates/<id>.md       per-session recovery copy
```

`WORKSTATE.md` is a recovery snapshot and explicitly **not** authoritative:
structured state and the observed environment both outrank it. Gitignore it.

## Audit integrity

Events are SHA-256 hash chained, and `audit.tip.json` records the expected
length and final hash. `/harness status` reports both. Editing a stored event
is detected at that exact line; deleting events off the end is detected by the
endpoint commitment, because a chain commits to order and content and to
nothing about length.

This is not tamper-proofing. Anything that can write the log can usually write
the tip beside it. It covers accidental truncation, crashes, and a model — the
last because the harness home sits outside every project scope, so no
scope-checked tool call can reach these files.

Records written before v0.2 carry no hash and are declared a
legacy-unverified prefix: the first chained event anchors to the digest of
that exact prefix, and an `audit_anchor` event marks the boundary in the log.
No hash is ever back-filled onto an old record — that would convert "these
were not protected" into a false claim that they were.

## Tests

```bash
npm install     # required: every tool is registered behind a typebox schema
npm test        # Node's built-in test runner; current count is in VALIDATION.md
npm run smoke   # live smoke inside a real pi process (needs pi + a reachable model)
```

`npm install` is not optional and not only for the tests. Tool registration
sits inside `if (TypeBoxType !== null)`, so without `typebox` the harness
loads, blocks the builtin shell, registers no sandboxed replacement for it,
and leaves the session with no shell. It now says so at session start
(`Harness: degraded`) rather than failing quietly, which is how the earlier
version of this file came to claim a passing clean-extract run that had in
fact never been run against a clean extract.

Tests are organised by acceptance invariant rather than by module, so a
failure names the rule that broke rather than the function.

Two scripts under `tests/smoke/` need a real environment rather than the test
runner: `harness-reviewer-corpus.mjs` measures the six reviewer acceptance
axes over every real Pi session on the machine and loads no model, and
`harness-delegate-smoke.mjs` and `harness-review-smoke.mjs` drive a live `pi`
process.

## Delegation boundary

The first design failed live and remains documented in `VALIDATION.md`: a
default nested Pi session had builtin `read`/`bash`, ambient extension tools,
skills, and project context, while the harness extension's `session_start`
handler was never initialized. A child contracted to a subdirectory read an
outside file. The contract was decorative.

v0.3 does not depend on inherited extension enforcement. It substitutes an
empty resource loader and gives the child exactly `scoped_read`,
`scoped_list`, and `request_read_scope`. The constructed runtime is attested
before the first prompt, before and after every tool call, and before the
handoff is accepted. Extra or missing tools and any ambient extension, skill,
prompt, or context file cause refusal/abort and discard the handoff.

Reads are authorized against the opened descriptor using `O_NOFOLLOW`,
`/proc/self/fd`, `fstat`, and same-descriptor consumption. A real race control
leaked hundreds of times while the pinned-descriptor reader leaked zero.

A scope request grants nothing and leaves a durable blocked job. Denial closes
it. Exact user approval starts a replacement child linked to the blocked
contract and decision, adding only the requested read root. Pi cannot pause
and resume the same nested session, so the harness does not claim it can.
Nested delegation, writes, shell, network, capability discovery, and policy
mutation are deliberately absent.

See `VALIDATION.md` for what has actually been executed — an adversarial pass
in which seven of fourteen constructed attacks succeeded on the first run and
are now closed, a cross-review pass in which four of five externally reported
defects reproduced, and the first live run of the retrospective evidence
contract.

That live evidence is worth stating precisely, because this file previously
said the contract "has not yet gated a live reviewer" and that was already
out of date. It has now gated three, and accepted all three: two model
families over a 52-line real session carrying 20 tool calls, a failed tool
call and a model change, plus the original short run. Complete read measured
over the Pi session file every time, and every item cited to a distinct real
Pi session entry.

See `BUILD_STATUS.md` for what is still asserted rather than shown: how the
gate behaves across models and long sessions, and the fact that the gate
cannot judge whether a real citation actually supports the claim attached to
it.
