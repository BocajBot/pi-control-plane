/**
 * Pi Harness - state contracts (spec section 18) and the enumerations the
 * enforcement modules key off.
 *
 * Pure: no Pi imports, no I/O. Mirrors the layering rule already established
 * by src/control-plane/types.ts, so every contract here is constructible and
 * assertable from a unit test with no Pi process running.
 *
 * Every persisted record carries `schemaVersion`. The validators in store.ts
 * reject an unknown version outright rather than migrating in place: a
 * half-understood record in an evidence file is worse than a rejected one,
 * because invariant AU1 (audit is append-oriented) means we can never
 * rewrite it back into a known shape afterwards.
 */

/**
 * Version written by this build. v0.2 adds fields to ScopeState, MemoryEntry
 * and AuditEvent, so a record written now is shaped differently from one
 * written by v0.1.
 */
export const HARNESS_SCHEMA_VERSION = 2;

/**
 * Versions this build will *read*.
 *
 * v0.1 records are not rejected. Rejecting them would discard evidence to
 * satisfy a schema, and section 32's audit-chain rule depends on the old
 * records still being there: the first chained event anchors to the digest of
 * the exact legacy prefix, which cannot be computed from records the reader
 * refuses to load. Readers fill the fields v0.1 did not have with explicitly
 * conservative defaults - see `upgrade*` in the modules that own each record.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

export function isSupportedSchemaVersion(value: unknown): boolean {
  return typeof value === "number" && SUPPORTED_SCHEMA_VERSIONS.includes(value);
}

/* ------------------------------------------------------------------ *
 * Modes (spec sections 2.4, 2.5)
 * ------------------------------------------------------------------ */

/** Reasoning style. Independent of autonomy by design (spec section 2.4):
 * a constrained reasoner may still be fully autonomous, and an exploratory
 * one may still need approval for every write. */
export const REASONING_MODES = ["constrained", "balanced", "exploratory"] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

/** How often Pi involves the user. "guided" is the spec default. */
export const AUTONOMY_MODES = ["interactive", "guided", "autonomous"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/** What requires an explicit approval before it happens. Ordered
 * most-restrictive first; policy.ts relies on the index for comparison, so
 * do not reorder without updating `atLeastAsStrict()`. */
export const APPROVAL_POLICIES = ["all-actions", "mutations", "consequential", "none"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/** Where a policy value came from (spec section 22). Ordered
 * broadest-first; a child may tighten a parent but never weaken it. */
export const POLICY_LEVELS = ["global", "device", "project", "task", "subagent"] as const;
export type PolicyLevel = (typeof POLICY_LEVELS)[number];

/** Who is acting. Authority differs per actor (spec section 20), so every
 * audit event and every authorization request carries one. */
export const ACTORS = ["user", "core", "coordinator", "advisor", "subagent", "reviewer", "operator"] as const;
export type Actor = (typeof ACTORS)[number];

/* ------------------------------------------------------------------ *
 * Scope (spec section 18 ScopeState, invariants S1-S6)
 * ------------------------------------------------------------------ */

export interface ScopeState {
  schemaVersion: number;
  /** Canonical absolute path. The narrowest scope inferred for current work. */
  root: string;
  /** Canonical absolute paths that are in scope in addition to `root`.
   * Always includes `root` itself once normalized by scope.ts. */
  allowedRoots: string[];
  /** Whether the single automatic next-boundary expansion (S2) is offered
   * at all. A project may switch this off to force explicit approval. */
  automaticExpansionEnabled: boolean;
  /** Remaining automatic expansions. Starts at 1 and is decremented, never
   * refilled by anything short of a user-authorized scope reset - that is
   * what makes S2 "only one" rather than "one at a time, forever". */
  automaticExpansionBudget: number;
  /** Sandboxed shell may unshare-net=false only when this is true. */
  networkGrant: boolean;
  /** Escape hatch for Pi's unrestricted builtin bash (spec section 9).
   * Default false and never set by a model - only by explicit user action. */
  unsafeBuiltinBashGrant: boolean;
  /**
   * Outermost path an *automatic* expansion may ever reach (spec section 32).
   *
   * The budget answers "how many automatic steps are left"; the ceiling
   * answers "how far out may those steps ever go". Both are needed because
   * narrowing is authority-reducing and therefore allowed automatically: a
   * scope that narrowed to a subdirectory would otherwise be able to walk
   * back out one parent at a time, each step individually legal under S2,
   * ending broader than the scope the user actually authorized.
   *
   * Leaving the ceiling is an explicit user-authorized transition, never an
   * automatic one. `approveExpansion` is the only function that raises it.
   */
  autoExpansionCeiling: string;
  /** Actor that granted the current shape of this scope. */
  grantedBy: Actor;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Session (spec section 18 SessionState)
 * ------------------------------------------------------------------ */

export interface ModelConfiguration {
  provider: string;
  model: string;
  /** Pi's thinking level, when the provider exposes one. */
  thinkingLevel?: string;
}

export interface SessionState {
  schemaVersion: number;
  id: string;
  /** Path of the Pi session file this harness session is attached to, when
   * known. Kept so a retrospective reviewer can find the raw evidence. */
  sessionFile: string | null;
  projectRoot: string;
  deviceId: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  coordinator: ModelConfiguration | null;
  reasoningMode: ReasoningMode;
  autonomy: AutonomyMode;
  approvalPolicy: ApprovalPolicy;
  scope: ScopeState;
  currentTaskId: string | null;
  /** Last state the harness actually verified against the environment, as
   * opposed to believes. Recovery continues only from this (invariant R3). */
  lastVerifiedState: string | null;
  findings: string[];
  /** Provisional by construction (invariant M2). */
  assumptions: string[];
  unresolvedQuestions: string[];
  relevantFiles: string[];
  nextAction: string | null;
  decisionIds: string[];
  incidentIds: string[];
  checkpointCount: number;
}

/* ------------------------------------------------------------------ *
 * Tasks (spec section 14, invariants T1-T4)
 * ------------------------------------------------------------------ */

export const TASK_STATUSES = [
  "queued",
  "active",
  "blocked",
  "awaiting-approval",
  "done",
  "abandoned",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskRecord {
  schemaVersion: number;
  id: string;
  objective: string;
  status: TaskStatus;
  project: string;
  /** Frozen authority envelope from creation time (invariant T2). A task
   * does not become more permissive because the user walked away. */
  scope: ScopeState;
  autonomy: AutonomyMode;
  approvalPolicy: ApprovalPolicy;
  /** Free-text preconditions checked before unattended execution. */
  executionConditions: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
  originSession: string;
  /** Set only by an actual verification pass. `status === "done"` means
   * claimed; this means measured (invariant T4). */
  validatedAt: string | null;
}

/* ------------------------------------------------------------------ *
 * Decisions (spec section 12, invariants D1-D4)
 * ------------------------------------------------------------------ */

export const DECISION_KINDS = ["durable", "temporary"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface DecisionRecord {
  schemaVersion: number;
  id: string;
  session: string;
  kind: DecisionKind;
  statement: string;
  rationale: string;
  /** Kept even when rejected, so D2 holds: the road not taken stays
   * recoverable instead of being summarized away. */
  alternatives: string[];
  rejectionReasons: string[];
  evidence: string[];
  /** Required for `kind === "temporary"` (invariant D3); null otherwise. */
  revisitCondition: string | null;
  /** Id of the decision this one replaces. Reopening a durable decision
   * creates a new record pointing back (invariant D4) - it never edits the
   * old one. */
  supersedes: string | null;
  createdAt: string;
  createdBy: Actor;
}

/* ------------------------------------------------------------------ *
 * Incidents (spec section 11, invariants I1-I6)
 * ------------------------------------------------------------------ */

export const INCIDENT_SEVERITIES = ["minor", "moderate", "major"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** Causal attribution categories (spec section 11 step 3). "unknown" is a
 * first-class answer, not a placeholder to be filled in with a guess. */
export const INCIDENT_CAUSES = [
  "model",
  "user-workflow",
  "tool",
  "environment",
  "policy",
  "mixed",
  "unknown",
] as const;
export type IncidentCause = (typeof INCIDENT_CAUSES)[number];

export interface IncidentRecord {
  schemaVersion: number;
  id: string;
  session: string;
  taskId: string | null;
  description: string;
  severity: IncidentSeverity;
  detectedBy: Actor;
  /** Model in play when it happened. Required for MO2: a failure attributed
   * to one model must not silently constrain another. */
  model: ModelConfiguration | null;
  reasoningMode: ReasoningMode;
  observedEffect: string;
  /** Deliberately separate from `observedEffect` (invariant I2): what
   * happened and why it happened are different epistemic objects. */
  suspectedCause: IncidentCause;
  suspectedCauseDetail: string | null;
  correction: string | null;
  outcome: string | null;
  evidence: string[];
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Memory (spec section 10, invariants M1-M6)
 * ------------------------------------------------------------------ */

/** The epistemic type is mandatory (invariant M3). There is no "untyped"
 * memory: writing something down forces a claim about what kind of claim
 * it is. */
export const MEMORY_EPISTEMIC_TYPES = ["fact", "assumption", "opinion"] as const;
export type MemoryEpistemicType = (typeof MEMORY_EPISTEMIC_TYPES)[number];

export const MEMORY_STATUSES = ["active", "superseded", "retired"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/**
 * Whether a durable memory applies everywhere or only inside one project
 * (spec section 32).
 *
 * v0.1 had one undifferentiated memory file, so a lesson learned in one
 * project was retrieved while working in an unrelated one. That is not a
 * retrieval-ranking problem, it is a scope problem: "the build is broken
 * until you run codegen" is true of exactly one repository.
 */
export const MEMORY_SCOPES = ["global", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface MemoryEntry {
  schemaVersion: number;
  id: string;
  category: string;
  subcategory: string | null;
  epistemicType: MemoryEpistemicType;
  content: string;
  /** Session-entry or audit-event references. Required for durable memory
   * where a source exists (invariant M5). */
  sourceReferences: string[];
  /** Only "user" and "reviewer" may create durable memory (invariant M1);
   * memory.ts enforces this rather than trusting the caller. */
  createdBy: Actor;
  createdAt: string;
  status: MemoryStatus;
  /** Points at the entry this one replaces. The replaced entry is marked
   * superseded, never deleted (invariant M4). */
  supersedes: string | null;
  /** Global, or bound to one project (spec section 32). */
  scope: MemoryScope;
  /**
   * Project root this entry belongs to when `scope === "project"`; null when
   * global. Stored as the canonical root rather than the hashed key so a
   * human reading memory.jsonl can tell what it refers to.
   */
  project: string | null;
}

/* ------------------------------------------------------------------ *
 * Review queue (spec section 6.3)
 * ------------------------------------------------------------------ */

export const REVIEW_STATUSES = ["pending", "running", "complete", "failed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface ReviewQueueItem {
  schemaVersion: number;
  id: string;
  sessionId: string;
  sessionFile: string | null;
  project: string;
  status: ReviewStatus;
  createdAt: string;
  /** Recorded for invariant MO4 - which model produced this reading of
   * history is itself evidence. */
  reviewerModel: ModelConfiguration | null;
  error: string | null;
}

/* ------------------------------------------------------------------ *
 * Audit (spec section 18 AuditEvent, invariants AU1-AU5)
 * ------------------------------------------------------------------ */

export const AUDIT_EVENT_TYPES = [
  "session_start",
  "session_close",
  "checkpoint",
  "scope_set",
  "scope_expand_auto",
  "scope_expand_approved",
  "scope_expand_denied",
  "authorization",
  "tool_call",
  "shell_exec",
  "model_switch",
  "thinking_level_change",
  "config_change",
  "policy_load",
  "policy_change",
  "goal_change",
  "identity_change",
  "task_create",
  "task_status",
  "decision_record",
  "decision_telemetry",
  "proposal_created",
  "incident_record",
  "memory_write",
  "memory_promote",
  "memory_supersede",
  "delegation",
  "advisor",
  "review_queue",
  "review_complete",
  "review_rejected",
  "recovery",
  "audit_anchor",
  "posture_change",
  "capability_grant",
  "capability_block",
  "scope_narrow",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEvent {
  schemaVersion: number;
  id: string;
  timestamp: string;
  session: string;
  actor: Actor;
  /** Null for `actor === "user"` and `actor === "core"`, which are not
   * models. Present for every model-driven event so AU2 holds. */
  actorModel: ModelConfiguration | null;
  eventType: AuditEventType;
  /** What was asked for, already redacted by the caller. */
  request: string;
  /** What happened. Never edited after the fact - a correction is a new
   * event (invariant AU1). */
  result: string;
  /** Scope in force at the time, as a compact string, so an audit line is
   * readable without joining against session state. */
  scope: string;
  metadata: Record<string, unknown>;
  /**
   * SHA-256 of the preceding chained event's `hash`, or - for the first
   * chained event in a file - the digest of the entire legacy prefix that
   * came before it (spec section 32).
   *
   * Null on every v0.1 record. That is not a gap to be filled in later: a
   * hash written onto a record after the fact proves nothing about when the
   * record was written, and back-filling one would convert "we did not
   * protect these" into a false claim that we did.
   */
  prevHash: string | null;
  /** SHA-256 over this event's canonical form including `prevHash`. Null on
   * v0.1 records, for the same reason. */
  hash: string | null;
}

/**
 * The outcome of verifying an audit file's hash chain.
 *
 * `legacyPrefixLength` is reported rather than hidden: a file that is 400
 * unverifiable v0.1 lines followed by 12 chained ones is a different
 * evidentiary object from 412 chained lines, and a verifier that returned
 * only `ok: true` would erase that difference.
 */
export interface AuditChainVerification {
  ok: boolean;
  legacyPrefixLength: number;
  /** Digest the first chained event anchors to. Null when there is no
   * legacy prefix and no chained event. */
  legacyPrefixDigest: string | null;
  verifiedCount: number;
  /** Index of the first event whose hash did not match, if any. */
  brokenAt: number | null;
  reason: string;
  /**
   * Whether the log agrees with the separately recorded tip.
   *
   * A hash chain commits to the *order and content* of the records it
   * contains and to nothing about how many there should be, so deleting
   * whole events off the end leaves a shorter chain that still verifies
   * perfectly. The tip file is the missing length-and-endpoint commitment.
   *
   * Undefined when no tip has been recorded yet (a log written entirely by
   * v0.1, or the very first append), which is a different state from
   * `false` and must not be reported as tampering.
   */
  tipConsistent?: boolean;
  tipReason?: string;
}

/**
 * The separately stored endpoint commitment for an audit log.
 *
 * Deliberately a second file. It does not make the log tamper-proof - an
 * attacker who can write `audit.jsonl` can usually write `audit.tip.json`
 * beside it - but it raises "delete the last two events" from a silent,
 * undetectable edit to one that requires updating a second artifact, and it
 * catches every *accidental* truncation outright.
 */
export interface AuditTip {
  schemaVersion: number;
  /** How many records the log had when this tip was written. */
  count: number;
  /** The last record's hash, or null when the log held only legacy records. */
  lastHash: string | null;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Delegation (spec section 7, invariants SA1-SA5)
 * ------------------------------------------------------------------ */

export const DELEGATE_KINDS = ["advisor", "subagent", "reviewer", "operator"] as const;
export type DelegateKind = (typeof DELEGATE_KINDS)[number];

export interface DelegationContract {
  schemaVersion: number;
  id: string;
  kind: DelegateKind;
  objective: string;
  /** Subset of the parent's scope. agents.ts refuses to build a contract
   * whose scope exceeds the parent's (invariant SA3). */
  scope: ScopeState;
  allowedCapabilities: string[];
  autonomy: AutonomyMode;
  approvalPolicy: ApprovalPolicy;
  /** Minimum necessary context by default (invariant SA2). */
  contextPackage: string[];
  expectedOutput: string;
  escalationBehavior: string;
  parentSession: string;
  parentActor: Actor;
  createdAt: string;
}

/** Every delegate returns this shape. It is evidence and recommendation
 * until the parent incorporates it (invariant SA4) - nothing here is
 * applied by the act of returning it. */
export interface Handoff {
  conclusion: string;
  evidence: string[];
  assumptions: string[];
  unresolvedQuestions: string[];
  recommendedActions: string[];
  /** Set when the delegate stopped because it needed authority it did not
   * have. Carries the exact request to surface to the parent (SA3). */
  blockedRequest: string | null;
}

/** Append-only lifecycle for one constructed child runtime. This is not a
 * scheduler: nested Pi sessions live in the parent process and cannot
 * survive it. The record exists so a crash turns an unclosed attempt into an
 * explicit orphan instead of a fictional resumable worker. */
export const DELEGATION_JOB_STATUSES = [
  "running",
  "attestation-refused",
  "blocked",
  "completed",
  "aborted",
  "denied",
  "orphaned",
] as const;
export type DelegationJobStatus = (typeof DELEGATION_JOB_STATUSES)[number];

export interface DelegationJobRecord {
  schemaVersion: number;
  /** Stable attempt id; currently the delegation contract id. */
  id: string;
  contractId: string;
  /** Contract whose blocked request this attempt resumes, if any. */
  resumesContract: string | null;
  /** User-authored approval record permitting the exact added root. */
  approvalDecisionId: string | null;
  parentSession: string;
  parentActor: Actor;
  kind: DelegateKind;
  objective: string;
  readRoots: string[];
  autonomy: AutonomyMode;
  approvalPolicy: ApprovalPolicy;
  capabilities: string[];
  status: DelegationJobStatus;
  pendingReadRoot: string | null;
  detail: string;
  ownerPid: number;
  at: string;
  /**
   * Repo-state anchor (HEAD sha) captured by the harness execution layer at
   * delegation start - never by the model. Phase 4.2 external-evidence seam: a
   * file_diff reader diffs `repoAnchor .. eval-time` over the contract roots, so
   * a change is attributable to a baseline the agent did not author. Null on
   * records written before this field existed, or when HEAD could not be read;
   * the reader drops the signal rather than diffing against a guessed baseline.
   */
  repoAnchor: string | null;
}

/* ------------------------------------------------------------------ *
 * Config (spec section 28)
 * ------------------------------------------------------------------ */

export interface HarnessConfig {
  schemaVersion: number;
  /** Preferred coordinator, for behavioral consistency (spec section 6.1). */
  preferredCoordinator: ModelConfiguration | null;
  /** Preferred retrospective reviewer. Spec section 6.3 prefers a different
   * model from the coordinator where practical. */
  preferredReviewer: ModelConfiguration | null;
  defaultReasoningMode: ReasoningMode;
  defaultAutonomy: AutonomyMode;
  defaultApprovalPolicy: ApprovalPolicy;
  /** Read-only mounts for the sandboxed shell (spec section 9). */
  sandboxReadOnlyPaths: string[];
  sandboxShadowDirs: string[];
  sandboxShadowFiles: string[];
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Identity state (spec section 17)
 * ------------------------------------------------------------------ */

/**
 * The "same Pi across sessions and models" half of the product thesis
 * (section 1). Deliberately three plain lists rather than a rich schema: this
 * is the layer a human writes by hand, and every field a model could argue
 * itself into rewriting is a field that erodes.
 *
 * Written by the user only - see identity.ts. A reviewer that believes
 * identity should change proposes it as memory; it does not edit this.
 */
export interface IdentityState {
  schemaVersion: number;
  /** Operating principles. How Pi works, regardless of task. */
  principles: string[];
  /** Stable user preferences that outlive a project. */
  preferences: string[];
  /** Baseline behavior notes: tone, verbosity, initiative. */
  behaviors: string[];
  updatedAt: string;
  updatedBy: Actor;
}

/* ------------------------------------------------------------------ *
 * Persisted policy state (spec sections 17, 21, 22)
 * ------------------------------------------------------------------ */

/**
 * A soft policy as stored on disk at one level of the inheritance chain.
 *
 * The in-memory `SoftPolicy` (policy.ts) is the resolved value; this is one
 * contributing layer, tagged with who wrote it and when. Keeping them
 * separate types is what stops a resolved policy - already merged across
 * three levels - from being written back to a single level and silently
 * flattening the hierarchy.
 */
export interface SoftPolicyRecord {
  schemaVersion: number;
  level: PolicyLevel;
  delegateExternalResearch: boolean;
  runTestsAfterEdits: boolean;
  consultAdvisorOnLowConfidence: boolean;
  preferredReasoningModeHint: string | null;
  additionalDeniedTools: string[];
  updatedAt: string;
  updatedBy: Actor;
}

/* ------------------------------------------------------------------ *
 * Goals and project relationships (spec section 13)
 * ------------------------------------------------------------------ */

export const GOAL_HORIZONS = ["now", "near", "long"] as const;
export type GoalHorizon = (typeof GOAL_HORIZONS)[number];

export const GOAL_STATUSES = ["active", "met", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * A goal sits above tasks: it informs what Pi recommends, and it is never an
 * authorization input. See goals.ts for why that separation is structural
 * rather than a convention.
 */
export interface GoalRecord {
  schemaVersion: number;
  id: string;
  statement: string;
  horizon: GoalHorizon;
  /** 1 (highest) to 5. Only used for ordering what gets surfaced first. */
  priority: number;
  /** Project roots this goal applies to. Empty means all projects. */
  projects: string[];
  /**
   * Phrases that, if they appear in a task objective, mean the task is in
   * tension with this goal. Explicit and user-authored on purpose: inferring
   * conflicts from a goal's prose would produce confident nonsense, and a
   * surfaced conflict is only useful if it is legible.
   */
  conflictsWith: string[];
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
}

export const PROJECT_LINK_KINDS = [
  "shared-dependency",
  "shared-goal",
  "shared-tool",
  "inherited-decision",
] as const;
export type ProjectLinkKind = (typeof PROJECT_LINK_KINDS)[number];

/**
 * A relationship between two projects.
 *
 * Section 13 is explicit that these do not create authority across project
 * boundaries, so this record carries no scope, no roots, and nothing else an
 * authorization path could read even by mistake.
 */
export interface ProjectLink {
  schemaVersion: number;
  from: string;
  to: string;
  kind: ProjectLinkKind;
  detail: string;
  createdAt: string;
  createdBy: Actor;
}

/* ------------------------------------------------------------------ *
 * Capability authority (spec sections 8, 32; invariants TO1-TO5)
 * ------------------------------------------------------------------ */

/**
 * How much the harness can actually say about what a tool does.
 *
 * The three values are epistemic states, not risk ratings:
 *
 * - `scope-aware`  a builtin whose target the harness resolves and
 *                  scope-checks before the call runs.
 * - `harness`      a tool this package registered, whose enforcement is
 *                  this package's own code.
 * - `unconfined`   anything else. Another extension's tool is opaque: the
 *                  harness cannot see its arguments' meaning, cannot resolve
 *                  a target, and therefore cannot honestly claim it is
 *                  confined. Labelling it "unconfined" is the truthful
 *                  description, and section 32 requires it be audited that
 *                  way rather than described as sandboxed.
 */
export const TOOL_CONFINEMENTS = ["scope-aware", "harness", "unconfined"] as const;
export type ToolConfinement = (typeof TOOL_CONFINEMENTS)[number];

/**
 * One entry in the capability catalog.
 *
 * TO1: catalog membership is not prompt exposure. A tool being registered
 * with Pi means it exists; it does not mean the coordinator can see or call
 * it. The active set is computed from this catalog plus explicit exceptions.
 */
export interface CapabilityEntry {
  name: string;
  description: string;
  confinement: ToolConfinement;
  /** True when the tool is in the coordinator's active set right now. */
  active: boolean;
  /** Set when an unconfined tool is active because the user granted an
   * exception this session. */
  exceptionReason: string | null;
}

/**
 * A user's per-session decision to activate one unconfined tool.
 *
 * Deliberately not persisted anywhere. A grant that survived into the next
 * session would be a durable authority expansion created by a single
 * in-conversation "yes", and section 32 says per-session. The audit log
 * records that it happened; the grant itself dies with the process.
 */
export interface CapabilityException {
  tool: string;
  grantedBy: Actor;
  grantedAt: string;
  reason: string;
}

/* ------------------------------------------------------------------ *
 * Posture authority (spec section 32)
 * ------------------------------------------------------------------ */

/** The three posture dimensions a `/harness-mode` change can touch. */
export const POSTURE_FIELDS = ["reasoning", "autonomy", "approval"] as const;
export type PostureField = (typeof POSTURE_FIELDS)[number];

/**
 * Classification of a proposed posture change.
 *
 * `neutral` is reasoning style, which carries no authority. `tighten` reduces
 * what the coordinator may do unattended and is therefore self-serviceable.
 * `loosen` is an authority expansion - it is the same act as enlarging scope,
 * just expressed as "ask me less often" - and A2 makes it the user's call.
 */
export const POSTURE_DIRECTIONS = ["neutral", "tighten", "loosen"] as const;
export type PostureDirection = (typeof POSTURE_DIRECTIONS)[number];

/* ------------------------------------------------------------------ *
 * Session index and per-session recovery (spec section 32)
 * ------------------------------------------------------------------ */

/**
 * One row of the global `sessionId -> projectRoot` index.
 *
 * v0.1 kept a single mutable `session-state.json` per project, so the second
 * session in a project overwrote the first and a reviewer asked to read an
 * older session had nothing to open. The index exists so a session can be
 * found from its id alone, without knowing which project it belonged to.
 */
export interface SessionIndexEntry {
  schemaVersion: number;
  /** The session id. Named `id` so the shared versioned-record validator
   * applies unchanged. */
  id: string;
  projectRoot: string;
  startedAt: string;
  endedAt: string | null;
}

/* ------------------------------------------------------------------ *
 * Retrospective evidence contract (spec section 32)
 * ------------------------------------------------------------------ */

/**
 * Why a reviewer's output was accepted or rejected.
 *
 * All three conditions are recorded separately rather than collapsed into a
 * boolean, because they fail for different reasons and the remedy differs: a
 * short read is an environment problem, an unparseable shape is a prompt
 * problem, and a missing citation is the reviewer asserting something it did
 * not get from the session.
 */
export interface ReviewAcceptance {
  accepted: boolean;
  /** Precondition: the reviewer actually produced a non-blank reply. An empty
   * or truncated-to-nothing reply parses to zero proposals and would otherwise
   * satisfy every other condition vacuously, silently recording "the reviewer
   * said nothing" as "the reviewer found nothing" - the two facts section 19
   * insists are distinct. See checkReviewEvidence. */
  reviewProduced: boolean;
  /** Condition 1: every line of the raw session file was retrieved through
   * the fixed reader, and the reviewer saw that full text. */
  readComplete: boolean;
  /** Condition 2: the parsed output satisfies the runtime shape check. */
  shapeValid: boolean;
  /** Condition 3: every item cites at least one entry id that actually
   * occurs in this session's evidence. */
  citationsValid: boolean;
  /** Lines dropped for failing condition 3, kept verbatim so a human can see
   * what the reviewer tried to assert without a source. */
  rejectedItems: string[];
  linesExpected: number;
  linesRead: number;
  /**
   * Every surviving item cites the same single entry, and there was more
   * than one item.
   *
   * This is a *warning, not a rejection*, and the distinction is the honest
   * one: the gate can check that a citation points at an entry from this
   * session, and it cannot check that the entry supports the claim. A model
   * that attaches one real id to eight unrelated assertions passes every
   * mechanical condition. Rejecting on this pattern would also reject the
   * legitimate case of a short session where one event really is the source
   * of everything, so it is surfaced for a human instead of enforced.
   */
  uniformCitation: boolean;
  reason: string;
}

/**
 * One stored reviewer run.
 *
 * A resumed session can be reviewed more than once. Each run is a separate
 * generation rather than an overwrite: the second reviewer's reading of a
 * longer session does not make the first reading untrue, and overwriting it
 * would destroy the only record of what was concluded at the time.
 */
export interface ReviewGeneration {
  schemaVersion: number;
  id: string;
  sessionId: string;
  /** 1-based, monotonically increasing per session. */
  generation: number;
  reviewerModel: ModelConfiguration | null;
  createdAt: string;
  acceptance: ReviewAcceptance;
  /** Parsed proposals, shaped by agents.ts `ReviewProposals`. Held as an
   * opaque record here so this module stays free of prompt-parsing types. */
  proposals: Record<string, unknown>;
  /** The reviewer's untouched reply. Stored so "found nothing" stays
   * distinguishable from "did not parse". */
  rawReply: string;
}
