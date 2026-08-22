# Pi Personal Agent Harness — Architecture Specification

Status: **Design frozen for MVP implementation**  
Version: **0.1**  
Purpose: Define the behavioral, state, authority, lifecycle, memory, audit, delegation, and recovery contracts for a persistent personal Pi agent harness.

---

## 1. Product thesis

Pi is the persistent agent; models are interchangeable workers.

The harness must preserve one coherent agent identity across model changes, sessions, projects, and eventually devices. Models provide reasoning. Pi Core provides continuity, authority, state, memory governance, auditability, and learning.

The system is local-first. A Pi instance runs on each device. Model providers may be local or remote. Non-model external services are opt-in and minimal by default.

The system should earn autonomy from observed user acceptance patterns rather than assuming sophisticated autonomy at installation.

---

## 2. Desired behavior

### 2.1 Identity

- Pi presents the same personality and baseline behavior across devices and sessions.
- Pi's identity is not the currently loaded model.
- Models may change as capabilities, costs, availability, and convenience change.
- A preferred coordinator model is used initially; task-sensitive routing may be learned later.

### 2.2 Capability

Pi should eventually be able to work with files, terminals, local applications, services, automation, research, software projects, systems administration, and other general-purpose tasks, but always inside an explicit authority envelope.

### 2.3 Initiative

Default behavior is proactive but approval-aware.

Pi should surface anything it thinks may be relevant, including minor observations, while visible verbosity is initially high. It should not silently take consequential actions merely because it noticed something.

### 2.4 Reasoning modes

Reasoning style and autonomy are independent controls.

Reasoning modes:

- **Constrained** — deterministic, requirement-bound, reproducible, minimal interpretation.
- **Balanced** — normal problem-solving while surfacing useful adjacent observations.
- **Exploratory** — challenge assumptions, propose foundational alternatives, pursue unconventional ideas.

Pi should infer the appropriate mode from the task and improve at doing so over time. The user can override it at any time.

### 2.5 Autonomy modes

- **Interactive** — frequent user involvement.
- **Guided** — Pi takes initiative but asks before important actions. This is the default.
- **Autonomous** — Pi carries work forward within scope and policy, stopping for risk, ambiguity, or approval boundaries.

### 2.6 Optimization objective

Pi balances speed, correctness, cost, compute, tokens, and unnecessary work according to the task. Correctness becomes dominant as consequences increase.

---

## 3. Scope philosophy

Pi infers the smallest reasonable working scope.

It may automatically expand only to the next logical boundary once from the initially inferred scope. Further expansion requires authorization according to policy.

Examples:

`file -> component -> project -> broader filesystem/service`

Scope is an authority object, not merely an instruction in a prompt.

A model may request scope expansion. Pi Core decides whether that expansion is automatically allowed, requires user approval, or is prohibited.

Genuine ambiguity in user intent must be clarified rather than guessed.

Ordinary implementation uncertainty may be handled according to scope, autonomy, consequence, and reversibility.

---

## 4. High-level architecture

```text
                         USER
                          |
                          v
                +------------------+
                | Coordinator Model|
                |  current brain   |
                +--------+---------+
                         | proposes
                         v
                 +---------------+
                 |    PI CORE    |
                 | control plane |
                 +-------+-------+
                         |
       +-----------------+------------------+
       |                 |                  |
       v                 v                  v
   POLICY/SCOPE       MEMORY             TOOLS
       |                 |                  |
       |                 |                  |
       +--------+    +---+----+       +-----+
                v    v        v       v
              TASKS       SUBAGENTS / ADVISORS
                              |
                              v
                      RETROSPECTIVE REVIEW
                              |
                       lessons / evidence
                              |
                              v
                            MEMORY

                    AUDIT is separate:

              actions/observations/state
                         |
                         v
                    AUDIT HISTORY
                         |
                         v
                 LEARNING / REVIEW
```

Audit records what happened. Learning interprets what happened. A wrong retrospective interpretation must never corrupt the original evidence.

---

## 5. Pi Core vs coordinator model

### Pi Core

Programmatic control plane responsible for deterministic behavior:

- scope enforcement
- permission checks
- policy hierarchy
- task state
- audit logging
- memory-write routing
- model/configuration tracking
- capability registration
- subagent authority contracts
- recovery state
- persistent state

### Coordinator model

Reasoning layer responsible for interpretation and judgment:

- understand user intent
- choose reasoning approach
- plan work
- decide whether to act, ask, consult, or delegate
- choose approved tools
- request scope expansion
- make task-level decisions
- create session checkpoints
- identify incidents
- recommend soft-policy changes

The coordinator may tune soft policy inside granted boundaries. It may not rewrite hard boundaries.

---

## 6. Model strategy

### 6.1 Default coordinator

Initially use one preferred coordinator model for behavioral consistency and causal attribution.

Switch when there is a clear reason:

- task is poorly matched to current model
- model becomes stuck
- another model is substantially cheaper or more convenient
- context-window requirements differ
- known model-specific weakness applies
- user explicitly requests a switch

Every switch is logged with reason, outgoing model/configuration, incoming model/configuration, and current task state.

### 6.2 Advisors

An advisor is a read-only consultation, not a coordinator replacement.

Either the user or coordinator may request an advisor.

Advisor output must include:

- conclusion
- evidence/reasoning summary
- assumptions
- unresolved questions
- recommended actions

### 6.3 Retrospective reviewers

A retrospective reviewer rereads an entire prior session and extracts:

- durable findings
- discoveries
- patterns
- mistakes
- user preferences
- model-specific behavior
- project lessons
- unresolved issues

Prefer a different model from the coordinator where practical, but this is not an absolute rule.

### 6.4 Model-specific learning

A failure attributed to Model A must not automatically constrain Model B.

Model-specific remediation belongs in a model-specific instruction layer:

`~/.pi/agent/pi-harness/models/<provider>__<model>/AGENTS.md`

Only that model's profile is loaded when that model is active.

Minor, well-supported, reversible profile updates may eventually be automatic. MVP stores reviewer proposals for human or later controlled promotion.

---

## 7. Subagents

Pi itself remains one consistent identity. Specialists are separate subagents.

Subagents primarily exist to isolate context and prevent side work from derailing or contaminating the main conversation.

Good delegation candidates:

- external research
- large codebase investigation
- independent verification
- specialist analysis
- tool construction
- lengthy side branches

Initially Pi should expose/propose delegation decisions. User accept/reject behavior becomes evidence. Stable patterns may later become learned soft policy.

Every subagent receives a delegation contract:

```text
Objective
Scope
Allowed capabilities
Autonomy level
Approval policy
Context package
Expected output
Escalation behavior
```

A subagent may not enlarge its own authority.

If blocked, it must notify the main conversation with the exact request rather than waiting silently.

Subagent handoff:

- conclusion
- evidence
- assumptions
- unresolved questions
- recommended changes/actions

MVP subagents are read-only until scoped write isolation is independently proven.

---

## 8. Tool philosophy

Pi should be capability-aware, not tool-saturated.

Always available:

- basic filesystem reasoning capabilities
- state/checkpoint tools
- capability search
- scope request
- advisor/delegation entrypoints

Specialized capabilities remain out of active model context until relevant.

When a capability is missing:

1. Search the capability catalog.
2. Evaluate existing tools.
3. Decide whether an existing tool is sufficient.
4. If not, propose a new tool.
5. Develop the new tool outside the active target project, preferably in an isolated subagent/workspace.
6. Test and review it.
7. Register it as a separate authority transition.

Creating a tool does not authorize or install it automatically.

External services/accounts beyond model providers are opt-in and added only for concrete use cases.

---

## 9. Shell boundary

Arbitrary shell access cannot be honestly described as hard-scoped merely because a model is told to remain in a project.

Therefore MVP policy is:

- Pi's unrestricted built-in `bash` is removed from the active tool set and blocked fail-safe.
- `pi_harness_bash` is the permitted shell path.
- `pi_harness_bash` requires an OS-level sandbox (`bubblewrap` on the initial Linux target).
- If the sandbox is unavailable, the tool refuses execution rather than falling back to an unenforced shell.
- User data outside the scope root is not mounted into the sandbox.
- system runtime binaries/libraries may be mounted read-only so commands can execute; this runtime surface is not treated as project data authority.
- network is unshared by default and enabled only when scope policy explicitly grants it.

This is intentionally conservative. A future cross-platform sandbox abstraction is deferred.

---

## 10. Memory architecture

### 10.1 Raw history

Complete session/audit records are preserved as canonical evidence.

Older raw data may be compressed into compact archives, but must remain addressable and expandable.

### 10.2 Session memory

The active coordinator may write session-level notes freely:

- checkpoint
- discovery
- assumption
- decision reference
- incident reference
- unresolved question
- relevant files
- next action

Session memory is provisional and may be wrong.

### 10.3 Retrospective notes

After sessions, a reviewer distills important information into compact, searchable notes with citations/backlinks to exact session entries.

### 10.4 Long-term memory

Only:

- explicit user direction
- retrospective reviewer promotion

may add durable global memory.

The active coordinator cannot directly promote its own observations into global memory.

### 10.5 Hierarchy and retention

Long-term memory has broad parent categories with more specific subcategories.

Parent categories define default retention/trust behavior. Subcategories inherit those rules unless overridden.

Detailed retention taxonomy is intentionally deferred.

### 10.6 Epistemic type

Memory must distinguish:

- fact
- assumption
- opinion/judgment

### 10.7 Freshness and supersession

When information changes, new memory supersedes old memory rather than deleting history.

```text
OLD ENTRY
   |
   +-- superseded by --> NEW ENTRY
                           |
                           +-- supported by source evidence
```

What used to be true may itself be useful evidence later.

---

## 11. Mistake-learning loop

Mistakes are learning events, not cleanup events.

A mistake can be corrected, but the incident record remains.

Minor incident record includes at minimum:

- model/provider
- effort/thinking level
- relevant configuration
- task context
- reasoning mode
- scope
- what happened
- how it was detected
- correction
- outcome

The retrospective reviewer then:

1. reads the incident in full session context
2. identifies likely causal object
3. distinguishes model vs user/workflow vs tool vs environment vs policy vs mixed vs unknown
4. checks Pi's own history for similar incidents
5. may research external reports for the same model/problem
6. identifies candidate mitigations
7. considers regression risk
8. applies or proposes remediation only at the causal scope

User/workflow contribution must be surfaced directly with evidence and a concrete recommendation rather than silently compensated for elsewhere.

The goal is to make repeated mistakes progressively less likely, not to pretend repetition is impossible.

---

## 12. Decisions

Important decisions are first-class records rather than prose buried in conversation.

Each records:

- statement
- rationale
- alternatives considered
- why alternatives were rejected
- evidence
- author/session

Decision types:

- **durable**
- **temporary**

Temporary decisions require an expiration, revisit date, or trigger condition.

Reopening a durable decision creates a new decision record; history is not rewritten.

---

## 13. Goals and project relationships

Pi maintains broader goals and priorities above individual tasks/projects.

Higher-level goals may influence recommendations and expose conflicts, but they do not silently override explicit current user instructions.

Pi understands relationships between projects such as:

- shared dependencies
- shared goals
- shared tools
- inherited decisions

Project relationships do not automatically create authority across project boundaries.

---

## 14. Task queue

Only explicitly created tasks enter the persistent queue.

Conversation fragments, ideas, or unfinished thoughts do not silently become obligations.

A task carries:

- objective
- project
- scope
- autonomy
- approval policy
- execution conditions
- status
- origin session

Queued task execution obeys its own policy. Some tasks may execute unattended. Others may research/prepare only or stop for approval.

A task does not become more autonomous because the user is absent.

---

## 15. Auditability and observability

Initial presentation is intentionally verbose.

Pi should expose:

- actions
- why actions were chosen
- scope interpretation
- scope changes
- model selection/switches
- advisor use
- delegation decisions
- tool loading
- assumptions
- autonomous decisions

Visible verbosity is adjustable later, but the underlying raw record remains.

Audit history is append-oriented.

A correction adds an event; it does not rewrite prior evidence.

---

## 16. Working recovery file

Every active project gets a human-readable recovery file:

`.pi/WORKSTATE.md`

It is a recovery snapshot, not the authoritative database.

Contents:

```text
Current task
Current scope
Coordinator model/configuration
Reasoning/autonomy/approval mode
Last verified state
Important findings
Active assumptions
Decisions
Incidents
Unresolved questions
Relevant files
Next intended action
Session/audit references
```

Rules:

- update at meaningful checkpoints
- update before compaction
- update before session close
- normally gitignore it
- structured state and observed real environment outrank it
- use it as emergency recovery if structured state is damaged/unavailable

Resume behavior is always:

`reconstruct -> verify -> continue`

---

## 17. State domains

Pi does not have one giant undifferentiated memory. Durable state is separated by authority/lifetime.

### Identity state

Stable behavior, preferences, operating principles.

### Device state

Machine-local capabilities, paths, models, hardware, restrictions.

### Project state

Architecture, constraints, goals, relationships, decisions, project policy.

### Session state

Current task, scope, assumptions, checkpoints, discoveries, incidents, coordinator/configuration, unresolved questions, next action.

### Long-term memory

Curated source-linked knowledge.

### Policy state

Scope, autonomy, approvals, hard/soft policy, learned delegation preferences.

### Capability state

Models, tools, integrations, specialist profiles, strengths/weaknesses, model-specific instructions.

### Audit/history state

Raw sessions, actions, commands, model changes, decisions, incidents, reviews, configuration changes, memory promotions.

Tasks remain distinct from memory.

---

## 18. Core state contracts

### SessionState

```text
session id/file
project root
device id
start/end/update time
coordinator model/configuration
reasoning mode
autonomy
approval policy
scope
current task
last verified state
findings
assumptions
unresolved questions
relevant files
next action
decision references
incident references
checkpoint count
```

### ScopeState

```text
root
allowed roots
automatic expansion enabled
automatic expansion budget
network grant
unsafe builtin bash grant (default false)
granted by
```

### TaskRecord

```text
id
objective
status
project
scope
autonomy
approval policy
created/updated
created by
origin session
```

### DecisionRecord

```text
id
session
kind
statement
rationale
alternatives
rejection reasons
evidence
revisit condition
supersedes
created at
```

### IncidentRecord

```text
id
session/task
description
severity
detected by
model/configuration
observed effect
suspected cause
correction
outcome
evidence
created at
```

### MemoryEntry

```text
id
category/subcategory
fact/assumption/opinion
content
source references
created by
created at
status
supersedes
```

### ReviewQueueItem

```text
id
session id/file
project
status
created at
reviewer model
error
```

### AuditEvent

```text
id
timestamp
session
actor
actor model
event type
request
result
scope
metadata
```

---

## 19. Information flow

```text
User message
    |
    v
Interpret intent
    |
    v
Establish current state
    |
    v
Determine scope + autonomy + reasoning mode
    |
    v
Retrieve relevant memory
    |
    v
Decide: act / ask / delegate / consult
    |
    v
Pi Core authorization
    |
    v
Execute action
    |
    v
Observe result
    |
    v
Update session state + audit + WORKSTATE
    |
    v
Respond to user
    |
    v
Session close -> queued retrospective review
```

Observation and inference remain separate.

Example:

`Observation: test exited 0.`

is not equivalent to:

`Inference: feature is correct.`

Validation must measure the claimed property.

---

## 20. Authority architecture

### User

Ultimate authority.

May:

- define/change hard boundaries
- override coordinator decisions
- change scope/autonomy/approval
- choose models
- promote memory directly
- revoke tools
- terminate subagents
- override learned behavior

### Pi Core

Exclusive enforcement authority over:

- hard scope
- hard permissions
- policy inheritance
- tool authorization
- subagent authority boundaries
- audit persistence
- task state
- model/config tracking
- memory-write routing
- capability registration
- recovery state

### Coordinator

May act broadly inside its authority envelope but may not:

- rewrite hard policy
- self-promote global memory
- erase audit history
- silently broaden scope
- grant subagents greater authority than itself
- silently remove its model-specific corrective rules

### Advisor

Read/reason/recommend only by default.

### Subagent

Authority is an explicit subset delegated by parent.

### Reviewer

Has learning authority but little operational authority.

May:

- read full session records
- create retrospective notes
- promote supported long-term memory
- supersede stale memory
- propose model-specific guidance
- eventually apply bounded reversible model-specific corrections

May not:

- rewrite raw audit/session history
- mutate active project files
- alter hard policy
- convert speculation into fact

### Tools

No independent authority.

Effective authority is the intersection of caller authority, tool capability, scope, and policy.

---

## 21. Hard vs soft policy

### Hard policy

Programmatically enforced and not self-modifiable by models.

Examples:

- model cannot enlarge own hard scope
- reviewer cannot rewrite audit history
- subagent cannot exceed delegated scope
- coordinator cannot directly promote global memory
- tool cannot acquire authority caller lacks

### Soft policy

Behavioral defaults that can be learned/tuned.

Examples:

- delegate external research by default
- use Model B for long-context retrospective review
- prefer constrained mode in a given project
- automatically run tests after code edits
- consult advisor when architecture confidence is low

---

## 22. Policy inheritance

```text
GLOBAL
  |
DEVICE
  |
PROJECT
  |
TASK
  |
SUBAGENT
```

Children inherit parents.

A child may tighten a rule.

A child may not weaken a hard parent restriction.

---

## 23. Learning authority

Learning progression:

```text
Observation
   |
Pattern
   |
Learned soft preference
```

Example:

`User approved this delegation.`

is one observation.

`User approved 14 comparable delegations and rejected none.`

may justify a learned preference.

Learned preferences remain reversible and should be narrowed/retired when contradictory evidence appears.

---

## 24. Non-self-modifiable constitutional rules

No model/reviewer may independently alter:

- hard user authority boundary
- hard filesystem/security scope rules
- audit immutability rules
- global-memory promotion authority
- reviewer authority limits
- subagent inheritance rules
- core approval enforcement
- credential/security handling policy

Changes require explicit user-authorized administrative action.

---

## 25. Lifecycle

### Startup

```text
load hard global policy
identify device
load identity/device state
discover models/core capabilities
check interrupted work
ready
```

### Session start

```text
create/restore session
select coordinator
load baseline identity
infer project/task
retrieve minimal relevant state
establish scope/policy
```

### Enter project

```text
load project state/policy/decisions/memory
read WORKSTATE
compare to observed environment
```

### Normal work loop

```text
reason
retrieve if needed
find capability if needed
consult/delegate if useful
propose action
Pi Core authorizes
action executes
observation recorded
state/audit/checkpoint updated
repeat
```

### Model switch

```text
record reason
checkpoint
record outgoing model/config
select new model
load model-specific guidance
provide minimal reconstructed state
continue under unchanged authority
```

### Incident

```text
detect
record immediately
assess consequence
correct if policy permits
verify
continue or stop for approval
```

### Session close

```text
final checkpoint
update WORKSTATE
persist explicit tasks
close session state
archive raw audit reference
queue retrospective review
```

Interactive close should not wait for retrospective review.

### Retrospective review

```text
select reviewer
read entire archived session
extract findings/patterns/incidents/memory candidates/model guidance
compare existing memory
promote/supersede permitted memory
store model-specific proposals
mark review complete
```

### Crash recovery

```text
restart
load structured state
read WORKSTATE
inspect actual environment
read latest audit
reconcile
identify last confirmed action / uncertain in-flight action
continue only from verified state
```

Disagreement among records becomes explicit uncertainty, not a guess.

### Context compaction

Before compaction:

- flush checkpoint
- update WORKSTATE
- persist decisions/incidents/task state

Conversation compaction can therefore never destroy the only copy of important state.

---

## 26. MVP implementation boundary

### Included

- Pi extension control plane
- project detection
- explicit session state
- scope enforcement for filesystem tools
- symlink-escape detection
- one-step automatic scope expansion
- user-approved broader scope expansion
- unrestricted built-in bash denial
- sandboxed shell entrypoint
- `WORKSTATE.md`
- append-oriented audit log
- explicit task creation
- session checkpoints
- decision records
- incident records
- preferred coordinator tracking
- model-switch/thinking-level audit
- model-specific instruction loading
- advisor invocation
- read-only bounded subagent invocation
- capability search
- retrospective review queue
- full-session read-only reviewer tool
- reviewer memory promotion with exact session-entry references
- reviewer model-guidance proposals

### Deferred

- automatic task-sensitive coordinator routing
- sophisticated learned delegation
- automatic model-profile mutation
- mature memory retention/expiry inheritance
- cross-device synchronization
- external account integrations
- autonomous tool creation/registration
- aggressive audit compression/archive manager
- cross-platform hard shell sandbox
- rich management UI
- autonomous policy-learning engine
- write-capable subagents until write isolation is proven

---

## 27. Acceptance invariants

### Authority

- **A1** User authority is supreme within system constraints.
- **A2** Models cannot enlarge their own hard authority.
- **A3** Delegated authority cannot exceed parent authority.
- **A4** Tools have no independent authority.
- **A5** Hard policy is not modifiable by ordinary model reasoning.

### Scope

- **S1** Begin with smallest reasonably inferred scope.
- **S2** Only one automatic next-boundary expansion is granted from inferred scope.
- **S3** Broader expansion requires policy authorization.
- **S4** Scope changes are auditable.
- **S5** Model/subagent change does not reset scope.
- **S6** Symlink traversal must not bypass filesystem scope checks.

### Memory

- **M1** Active coordinator cannot directly promote arbitrary observations to global memory.
- **M2** Session memory is explicitly provisional.
- **M3** Fact/assumption/opinion remain distinguishable.
- **M4** Supersession does not erase history.
- **M5** Durable memories retain provenance where source exists.
- **M6** Reviewer interpretation cannot alter source history.

### Audit

- **AU1** Audit is append-oriented.
- **AU2** Autonomous consequential actions have attributable provenance.
- **AU3** Model switches are recorded.
- **AU4** Significant configuration changes are recorded.
- **AU5** Compressed archives remain addressable.

### Recovery

- **R1** Session can be reconstructed without conversation context alone.
- **R2** WORKSTATE cannot override observed real state.
- **R3** Resume verifies environment before continuing.
- **R4** Uncertain in-flight operations remain uncertain.
- **R5** Compaction cannot discard the only durable copy of important state.

### Models

- **MO1** Pi identity is independent of active model.
- **MO2** Model-specific remediation remains model-specific unless broader evidence exists.
- **MO3** Model switch does not alter authority.
- **MO4** Reviewer model/configuration is recorded.
- **MO5** Advisor does not silently become coordinator.

### Subagents

- **SA1** Every subagent has explicit delegation contract.
- **SA2** Subagents receive minimum necessary context by default.
- **SA3** Blocked subagent surfaces request to parent/main conversation.
- **SA4** Handoffs are evidence/recommendations until incorporated.
- **SA5** Subagent cannot mutate parent scope/policy.

### Decisions

- **D1** Important decisions include rationale.
- **D2** Rejected alternatives remain recoverable.
- **D3** Temporary decisions require revisit condition.
- **D4** Reopening durable decision creates a new record.

### Incidents / learning

- **I1** Fixing an error does not delete incident record.
- **I2** Observation and inferred cause remain separate.
- **I3** Model and user/workflow causes are not conflated.
- **I4** Prevention is scoped to attributed cause.
- **I5** Learned behavior remains reversible.
- **I6** Repeated mistakes trigger investigation, not endless universal prompt growth.

### Tasks

- **T1** Only explicitly created tasks persist.
- **T2** Tasks retain original authority envelope.
- **T3** Execution stops at approval boundaries.
- **T4** Claimed completion is distinct from validated completion.

### Tools

- **TO1** Capability existence does not imply prompt exposure.
- **TO2** Specialized tools are loaded only when needed.
- **TO3** Tool creation does not imply registration/authorization.
- **TO4** Tool development occurs outside active target project by default.
- **TO5** Registration is an explicit authority transition.

### Epistemic

- **E1** Observation and inference remain separable.
- **E2** Validation measures the claimed property.
- **E3** Ambiguous intent causes clarification.
- **E4** Ordinary uncertainty may be managed according to scope/autonomy/consequence/reversibility.

### Meta-invariant

Anything Pi claims to know, remember, have done, be allowed to do, or have learned should have an identifiable source of authority or evidence.

---

## 28. Initial storage layout

MVP uses simple local files deliberately.

```text
~/.pi/agent/pi-harness/
├── config.json
├── tasks.json
├── review-queue.json
├── memory.jsonl
├── models/
│   └── <provider>__<model>/
│       ├── AGENTS.md
│       └── guidance-proposals.jsonl
├── reviews/
│   └── <session-id>.json
└── projects/
    └── <project-hash>/
        ├── session-state.json
        ├── audit.jsonl
        ├── decisions.jsonl
        └── incidents.jsonl

<project>/
└── .pi/
    └── WORKSTATE.md
```

This layout is not a permanent database commitment. It makes evidence and recovery auditable during the first build.

---

## 29. Current implementation mapping

The harness is built as a second extension inside the existing
`pi-control-plane` package, so it ships through the package already listed in
`~/.pi/agent/settings.json` rather than as a separate install. Paths therefore
differ from the flat `src/core/` sketch this section originally carried; the
module boundaries are the ones that sketch described.

```text
extensions/pi-harness.ts     Pi extension / lifecycle / tools / enforcement
src/harness/agents.ts        advisor, bounded subagent, retrospective reviewer
src/harness/types.ts         state contracts
src/harness/state.ts         session init, checkpoints, recovery reconcile
src/harness/store.ts         local durable state + append-only records
src/harness/scope.ts         canonical path and symlink-safe scope checks
src/harness/policy.ts        hard policy decisions
src/harness/sandbox.ts       Linux bubblewrap shell boundary
src/harness/workstate.ts     WORKSTATE renderer
src/harness/audit.ts         audit-event construction
src/harness/project.ts       project-root inference
src/harness/config.ts        runtime configuration + storage layout
src/harness/util.ts          ids/timestamps/device/project keys
src/harness/memory.ts        promotion, supersession, active view
src/harness/records.ts       decision and incident records
src/harness/tasks.ts         the explicit task queue
src/harness/identity.ts      identity state (sections 1, 2.1, 17)
src/harness/goals.ts         goals above tasks, project relationships (13)
```

`memory.ts`, `records.ts` and `tasks.ts` are separate modules rather than part
of `store.ts` because each owns a refusal — an uncited promotion, a temporary
decision with no revisit condition, a validation with no evidence — and a rule
enforced inside a persistence layer is a rule that gets bypassed the first time
someone writes a second persistence path.

Policy state (section 17) lives in `policy.ts` alongside the rules it feeds,
stored as one `SoftPolicyRecord` per level and resolved broadest-first at
session start.

Tests are organized by acceptance invariant rather than by module:
`tests/harness-scope.test.ts` (S1-S6), `harness-policy.test.ts` (A1-A5,
sections 21-22), `harness-records.test.ts` (M, D, I, T rules),
`harness-agents.test.ts` (SA rules), `harness-state.test.ts` (AU and R rules),
`harness-continuity.test.ts` (policy state, goals, identity), and
`harness-extension.test.ts` (the real entry against a fake Pi API).

---

## 30. Build sequencing after v0.1

Recommended maturity progression:

```text
M0 Core state + audit
M1 Scope/policy enforcement
M2 Recovery + WORKSTATE
M3 Checkpoints/decisions/incidents
M4 Advisor + model tracking
M5 Read-only bounded subagents
M6 Explicit task queue
M7 Retrospective review + memory promotion
M8 Model-specific learning proposals
M9 Runtime hardening / integration tests
M10 Learned routing/delegation
M11 Cross-device synchronization
```

The current package attempts M0–M8 in one prototype, but only deterministic core behavior is unit-tested in the build environment. Runtime Pi integration must be smoke-tested on a machine with Pi installed.

### Status as built (v0.1)

M0–M6 are implemented and covered by invariant tests. M7–M8 are implemented as
far as they can be without a live model: the review queue, the reviewer prompt
and parse, memory promotion with citation enforcement, and guidance proposals
filed per model all exist and are tested, but no reviewer has actually been
run.

Everything in the section 26 "Included" list is present. Two qualifications
belong here rather than in a commit message:

- **Verified live, except delegation.** `tests/smoke/harness-smoke.mjs` drives
  a real pi process (pi 0.84.1, llama-swap) and passes 17/17: the extension
  loads, `/harness` commands work, the storage layout appears at
  `PI_HARNESS_HOME`, session start is audited, the builtin shell is gone from
  the model's live tool list while `pi_harness_bash` is reachable in its
  place, a write outside the scope root is denied *after the control plane
  approved it*, the denial lands in the append-only audit log, and session
  close writes `.pi/WORKSTATE.md`.

  `tests/smoke/harness-review-smoke.mjs` then closes the learning loop for the
  first time: a working session produces evidence and queues a review, a later
  session runs `/harness-review run`, and a real reviewer model reads the
  archived audit log and returns findings, patterns, a mistake, memory
  candidates and a model-guidance proposal. Memory is promoted with citations,
  the proposal is stored unapplied, and `review_complete` is audited.

  Running it found a defect nothing else could: `AgentSession.prompt()` returns
  `Promise<void>`, but both nested-agent call sites awaited it and read `.text`
  off the result. Every delegate and every reviewer therefore returned an empty
  string, and an empty parse looked exactly like "the model found nothing". The
  unit tests could not catch this - they inject a fake runner that returns
  text, so they tested the contract the extension failed to implement. Output
  is now collected by subscribing to the nested session, with a branch read as
  fallback, and the reviewer's raw reply is stored alongside the parsed
  proposals so "found nothing" stays distinguishable from "did not parse".

  A second defect followed from the first working: the reviewer echoed the
  prompt's own instruction line back as a memory candidate, citing the literal
  placeholder, and it was promoted as durable fact. M5 now requires a citation
  to parse as a real record id (`idKind()`), not merely to be a non-empty
  string.

  Still unexecuted: `harness_delegate`. It shares the fixed nested-prompt path
  with the reviewer, so the mechanism is now exercised, but no advisor or
  subagent has been run.

- **Sections 13 and 17 are now built.** Policy state persists as global,
  device and project layers and is resolved at session start, so a tightened
  soft policy survives a restart - previously it did not, which made section
  23's "learned preference" unreachable in principle. Identity persists and is
  injected into the system prompt each turn, and only the user can write it.
  Goals and project relationships persist, reach the prompt as advisory
  context, and are structurally incapable of changing an authorization
  outcome: `conflictingGoals()` returns conflicts to show, and `ProjectLink`
  carries no roots or capabilities for an authorization path to read.

  Building them surfaced a live defect in the existing code: soft-policy tool
  denials were compared against `AuthorizationRequest.target`, which for a
  write is the file path, so denying a tool by name never fired for any tool
  with a path argument. `toolName` is now a separate field. The unit test that
  claimed to cover this passed only because it set `target: "write"` directly.

- **Extension ordering is load bearing.** Pi short-circuits `tool_call` on the
  first blocking handler, and the control plane is registered first. Calls it
  blocks never reach the harness and so are missing from the harness audit
  log; calls it allows are still independently checked by the harness. The
  composition is fail-closed, but the harness log records what the harness
  saw, not every attempt.
- **The tool-call gate resolves a target from a fixed set of argument keys.**
  An unrecognized tool is classified as mutating, so it is gated, prompted for
  and audited rather than treated as a read; but if its target sits under a
  key outside that set, the path itself is never scope-checked. The residual
  S6 gap is an exotic-argument mutating tool that the user approves at the
  prompt.

- **Delegate isolation depends on an environment marker, not on Pi.** Pi
  reloads this package's extensions for a nested session, so a delegate runs a
  second in-process instance of the harness. That instance is told it is a
  delegate through `PI_HARNESS_DELEGATE_CONTRACT`, and adopts the contract's
  scope and actor instead of inferring its own. This is enforced and tested,
  but it rests on Pi continuing to construct nested sessions in-process. If Pi
  ever runs them out-of-process without inheriting the environment, the child
  would fall back to inferring a full-project scope, and SA3 would quietly
  stop holding — so this is a coupling to re-check on Pi upgrades.

Per section 31, the next maturation signal is not more features. It is
evidence that these invariants survive real sessions, model switches,
interrupted work, and scope pressure — which requires running the thing.

---

## 31. Maturity diagnosis

This is a **controlled adaptive-agent architecture**, not yet a mature self-learning agent.

The design intentionally prioritizes trustworthy authority, state provenance, recovery, and inspectability before automatic routing, memory decay, policy learning, tool creation, or cross-device synchronization.

The correct next maturation signal is not “more features.” It is successful evidence that the core invariants survive real Pi sessions, model switches, interrupted sessions, scope pressure, advisor/subagent use, and retrospective review without silently losing provenance or authority boundaries.
