# Pi Personal Agent Harness — Architecture Specification

Status: **Design frozen; v0.2 integration-hardening implementation complete pending live Pi acceptance**  
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

```text
src/index.ts              Pi extension / lifecycle / tools / enforcement
src/agents.ts             advisor, bounded subagent, retrospective reviewer
src/types.ts              state contracts
src/core/state.ts         session initialization
src/core/store.ts         local durable state + append-only records
src/core/scope.ts         canonical path and symlink-safe scope checks
src/core/policy.ts        hard policy decisions
src/core/sandbox.ts       Linux bubblewrap shell boundary
src/core/workstate.ts     WORKSTATE renderer
src/core/audit.ts         audit-event construction
src/core/project.ts       project-root inference
src/core/config.ts        runtime configuration
src/core/util.ts          ids/timestamps/device/project keys
```

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

v0.2 implements and hardens M0–M9 at the source/control-plane level. Deterministic behavior is unit-tested here; live Pi integration remains the acceptance gate because the current build environment cannot install/run the required Pi runtime line.

---

## 31. Maturity diagnosis

This is a **controlled adaptive-agent architecture**, not yet a mature self-learning agent.

The design intentionally prioritizes trustworthy authority, state provenance, recovery, and inspectability before automatic routing, memory decay, policy learning, tool creation, or cross-device synchronization.

The correct next maturation signal is not “more features.” It is successful evidence that the core invariants survive real Pi sessions, model switches, interrupted sessions, scope pressure, advisor/subagent use, and retrospective review without silently losing provenance or authority boundaries.


---

## 32. v0.2 integration-hardening implementation delta

v0.2 preserves the behavioral and authority architecture above while tightening several instruments that v0.1 left too implicit.

### Recovery representation

Structured session state is now per-session rather than one mutable project snapshot. A global session index maps `sessionId -> projectRoot`. The project-local recovery representation has two layers:

```text
.pi/WORKSTATE.md                 current session snapshot
.pi/workstates/<session-id>.md  per-session recovery copy
```

The Markdown files remain subordinate to structured state and newly observed environment state.

### Automatic scope ceiling

`ScopeState` now carries an explicit `autoExpansionCeiling`. Narrowing scope is authority-reducing and may happen automatically. A narrowed scope may expand one parent step only while that parent remains inside the ceiling. Leaving the ceiling is an explicit user-authorized transition.

### Capability authority

Registered tools are catalog entries, not automatically active capabilities. By default the coordinator sees only scope-aware built-ins and harness tools. Opaque external extension tools require an explicit per-session user exception and are labeled/audited as unconfined rather than falsely described as sandboxed.

### Posture authority

The coordinator may change reasoning style and may tighten its own autonomy/approval posture. Increasing autonomy or reducing confirmation requirements is an authority expansion and therefore requires user approval.

### Retrospective evidence contract

The reviewer is accepted only if:

1. every raw session JSONL line was actually retrieved through the fixed session reader,
2. its structured output passes runtime shape validation, and
3. every finding, pattern, unresolved item, incident, memory candidate, and model-guidance proposal cites at least one real source entry ID from that session.

Repeated reviews of a resumed session are stored as separate generations rather than overwriting historical reviewer output.

### Memory scope

Long-term entries are explicitly `global` or `project`. Default retrieval returns global entries plus entries belonging to the current project. Project memories from unrelated projects are excluded unless a later cross-project relationship mechanism explicitly requests them.

### Audit chain

v0.2 audit events are SHA-256 hash chained. Existing v0.1 records remain a declared legacy-unverified prefix; the first new event anchors to the exact legacy prefix digest. This avoids the false claim that old events were cryptographically protected when originally written.

See `VALIDATION.md` for executed evidence and `BUILD_STATUS.md` for remaining provisional integration claims.

## 33. v0.2.1 cross-review clarifications

A separate implementation reviewed the v0.2 artifact. Section 32 stands as written; the items below are places where it turned out to be readable in a way that permitted a wrong implementation, and are stated here rather than edited into section 32 so the change is visible.

### Condition 1 names an artifact

"Every raw session JSONL line" means Pi's session file, at the path Pi reports through `getSessionFile()` — not the harness audit log. v0.2 measured coverage over `audit.jsonl` and passed condition 1 while never opening the session file; deleting the file changed neither the count nor the verdict. The two are different artifacts answering different questions, and only one of them contains the conversation.

Consequences, all of them fail-closed:

- A review queue row with no recorded session file is **un-reviewable**, not trivially complete. Rows queued by v0.1, and sessions Pi ran without a file, are refused with that reason.
- The denominator is the physical non-empty line count of the file, taken from raw text before anything parses. A line that could not be parsed widens the gap rather than leaving the denominator, so a damaged or truncated session fails the condition instead of certifying a review of a prefix.
- The harness audit for the same session is shown to the reviewer as complementary evidence and is deliberately **not** part of the denominator. Two artifacts, one coverage claim each.
- Entries are never dropped from the transcript for size. An over-long body is abbreviated with the elision stated inline, because dropping an entry would make the coverage claim false while leaving it true-looking.

### Condition 3 spans two id namespaces

Pi mints session entry ids as bare hex; the harness mints `<prefix>_<body>`. A citation is valid if it names an id occurring in *this session*, in either namespace: a Pi session entry, or a harness audit event, decision, or incident belonging to the session — all of which are in the transcript the reviewer was given. Restricting the syntax to the harness namespace does not make the gate stricter, it makes it broken: it rejects the only ids a reviewer of a real session can cite.

### An unreadable state file is not an absent one

Section 22's layered soft policy resolves an absent layer to the permissive default. That must not extend to a layer that exists and cannot be parsed: the safe default for absent is the dangerous default for unreadable. An unreadable layer is reported as unresolved, gates mutating and consequential actions to `needs-approval` for non-user actors, and is quarantined rather than deleted — the bytes are evidence of what someone wrote.

### The project state directory is a path the project can lie about

`.pi` inside a project is attacker-influenceable: a symlink there redirects Core-owned recovery writes wherever it points. Core-owned writes resolve their parent directory before writing and divert to a harness-owned fallback when it leaves the project, recording the diversion. Diverting is not "defended by recoverability" — the write still lands somewhere durable and the compromise is reported.

### Durable state is owner-only

Harness directories are `0700` and files `0600`. The audit log, memory, and session state are the evidence base for every claim this system makes; readable-by-default is not a threat model, it is an oversight.

### A dependency the tools cannot load is a loud failure

Every tool is registered behind a TypeBox schema. Without `typebox` the harness registers no tools, keeps blocking the builtin shell, and leaves the session with no shell at all. That state is now announced at session start and audited. Discovered by testing the isolated artifact from a genuinely clean extract, where six tests failed that passed in the repository.

## 34. v0.3 explicit delegated-child boundary

Live execution falsified the assumption that a nested `createAgentSession()`
would inherit an initialized harness enforcement layer. Pi 0.84.1 loads
ambient extensions and their tools into a default child, but does not dispatch
the lifecycle that initializes this harness. Delegated authority must not
depend on the parent extension loading inside the child.

The MVP child is constructed with an empty resource loader and an exact
allowlist containing only inline read capabilities. Its actual runtime is
attested before the first prompt, around every tool invocation, and before the
handoff is accepted. Unexpected or missing tools and any ambient extension,
skill, prompt template, or context file cause refusal/abort; the model does
not decide whether drift is material.

Read authorization binds to the opened object: open with no final symlink,
canonicalize and inspect the open descriptor, verify its real object lies
inside an approved root, and consume that same descriptor. Reopening a checked
pathname is not an implementation of this contract.

Scope escalation is read-only. A request grants nothing and leaves a durable
blocked job. Denial is terminal. Approval names the exact requested root and
authorizes a new contract linked to the blocked contract and user decision.
The replacement must preserve the blocked objective, original read roots,
posture, and capabilities exactly; only the approved read root may be added.
Pi 0.84.1 cannot pause and resume the same nested session, so "resume" means a
provenance-linked replacement child, never seamless continuation. A running
child lost with its parent is reconciled to `orphaned` and requires explicit
restart. Nested delegation remains unsupported and absent from the child tool
surface.
