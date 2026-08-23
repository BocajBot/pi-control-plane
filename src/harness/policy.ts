/**
 * Pi Harness - hard policy, soft policy, inheritance, and the authorization
 * decision itself (spec sections 20-24; invariants A1-A5, TO1-TO5).
 *
 * This is the module that makes the difference between an agent that is told
 * to stay in scope and one that is held in scope. Everything here is
 * deterministic and pure: no model output reaches a decision, only the
 * request's shape. A model may argue with the outcome; it cannot participate
 * in producing it.
 *
 * Two things are worth stating explicitly because they are easy to erode:
 *
 * 1. `authorize()` is deny-by-default. Every path that is not an explicit
 *    allow returns a denial, including the paths that "cannot happen" -
 *    an unrecognized actor, an unrecognized action. A5 does not survive a
 *    permissive fallthrough.
 *
 * 2. The capability matrix is keyed on actor, not on trust. There is no
 *    "trusted coordinator" flag anywhere. A2 says a model cannot enlarge its
 *    own authority; a flag a model could talk the harness into setting is
 *    exactly that enlargement, so the flag does not exist.
 */

import {
  APPROVAL_POLICIES,
  AUTONOMY_MODES,
  HARNESS_SCHEMA_VERSION,
  POLICY_LEVELS,
  type Actor,
  type ApprovalPolicy,
  type AutonomyMode,
  type PolicyLevel,
  type PostureDirection,
  type PostureField,
  type ScopeState,
  type SoftPolicyRecord,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * Constitutional rules (spec section 24)
 * ------------------------------------------------------------------ */

/**
 * Rules no model or reviewer may alter through ordinary operation. This list
 * is data so it can be *displayed* to the user and asserted against in
 * tests; it is not data in the sense of being editable at runtime. Nothing
 * in the harness writes to it, and `authorize()` refuses every request whose
 * action is "policy-change" at hard level regardless of what it contains.
 */
export const CONSTITUTIONAL_RULES = [
  "user authority boundary is not model-modifiable",
  "filesystem and security scope rules are not model-modifiable",
  "audit history is append-oriented and immutable",
  "global-memory promotion authority is user or reviewer only",
  "reviewer authority is limited to learning, not operation",
  "subagent authority is a subset of its parent's",
  "approval enforcement is performed by Pi Core, not by the model",
  "credential and security handling policy is not model-modifiable",
] as const;

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * Every distinguishable authority-bearing operation. Kept coarse on purpose:
 * a long tail of fine-grained actions is a long tail of places for a
 * permissive default to hide.
 */
export const ACTIONS = [
  "read",
  "mutate",
  "shell",
  "scope-expand",
  "memory-write-session",
  "memory-promote-global",
  "memory-supersede",
  "audit-append",
  "audit-rewrite",
  "delegate",
  "tool-register",
  "config-change",
  "policy-change-soft",
  "policy-change-hard",
  "task-create",
  "task-status",
  "model-switch",
  "posture-tighten",
  "posture-loosen",
] as const;
export type Action = (typeof ACTIONS)[number];

/** Actions that change something outside the harness's own bookkeeping.
 * Used by the approval-policy comparison below. */
const MUTATING_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "mutate",
  "shell",
  "tool-register",
  "config-change",
]);

/** Actions whose consequences are hard to reverse or reach beyond the
 * current task. `approvalPolicy: "consequential"` gates exactly these. */
const CONSEQUENTIAL_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "shell",
  "scope-expand",
  "memory-promote-global",
  "tool-register",
  "config-change",
  "policy-change-soft",
  "posture-loosen",
]);

/* ------------------------------------------------------------------ *
 * Capability matrix (spec section 20)
 * ------------------------------------------------------------------ */

/**
 * What each actor may *ever* do, before scope, approval, or autonomy are
 * considered. A "false" here is a hard boundary: no approval unlocks it,
 * because the thing that would have to change is the actor's constitutional
 * role rather than a permission.
 *
 * Read as a table of A1-A5:
 *  - user has everything except audit-rewrite (AU1 binds the user too: the
 *    user may delete the file outside the harness, but the harness offers no
 *    operation that rewrites history).
 *  - coordinator cannot promote global memory (M1) or rewrite audit (AU1) or
 *    touch hard policy (A5).
 *  - advisor is read/reason/recommend only (MO5).
 *  - subagent gets a strict subset, and is read-only in MVP (spec section 7).
 *  - reviewer has learning authority and almost no operational authority.
 */
const CAPABILITIES: Record<Actor, ReadonlySet<Action>> = {
  user: new Set<Action>([
    "read",
    "mutate",
    "shell",
    "scope-expand",
    "memory-write-session",
    "memory-promote-global",
    "memory-supersede",
    "audit-append",
    "delegate",
    "tool-register",
    "config-change",
    "policy-change-soft",
    "policy-change-hard",
    "task-create",
    "task-status",
    "model-switch",
    "posture-tighten",
    "posture-loosen",
  ]),
  core: new Set<Action>([
    "read",
    "audit-append",
    "memory-write-session",
    "task-status",
    "scope-expand",
  ]),
  coordinator: new Set<Action>([
    "read",
    "mutate",
    "shell",
    "scope-expand",
    "memory-write-session",
    "audit-append",
    "delegate",
    "task-create",
    "task-status",
    "model-switch",
    "policy-change-soft",
    // The coordinator may restrict itself freely, and may *ask* to be
    // restricted less. Holding the capability is what lets the request reach
    // the approval gate below; it is not what decides it.
    "posture-tighten",
    "posture-loosen",
  ]),
  advisor: new Set<Action>(["read"]),
  // MVP: read-only until scoped write isolation is independently proven
  // (spec section 26 "deferred"). Adding "mutate" here is the single edit
  // that would turn write-capable subagents on, and it must not happen
  // before that proof exists.
  subagent: new Set<Action>(["read", "delegate"]),
  reviewer: new Set<Action>([
    "read",
    "memory-promote-global",
    "memory-supersede",
    "memory-write-session",
    "audit-append",
  ]),
  // An exec-capable delegate. A strict subset of the coordinator (which holds
  // read/shell/delegate and more), so A3/SA1 - a delegate's authority is a
  // subset of its parent's - holds at the capability-matrix axis too. This
  // entry is the legible source of truth for "an operator may run commands".
  // Enforcement of a *specific* operator's exec still happens on the isolated
  // child path (bwrap sandbox bound to the operator's own narrowed scope root,
  // plus attestChild/attestCalls), which does not route through authorize();
  // this matrix entry is defense-in-depth for any path that does, and the place
  // an auditor reads to see that operators exec while advisors/subagents do not.
  // It grants no "mutate": an operator writes only inside its sandbox scope,
  // never through the coordinator-path mutate capability.
  operator: new Set<Action>(["read", "delegate", "shell"]),
};

/* ------------------------------------------------------------------ *
 * Soft policy (spec section 21)
 * ------------------------------------------------------------------ */

/**
 * Behavioral defaults, tunable by the coordinator inside its envelope and
 * learnable over time (spec section 23). Distinguished from hard policy by
 * one property: nothing here can widen authority. Every field is either a
 * preference about *how* to work or a self-imposed extra restriction.
 */
export interface SoftPolicy {
  level: PolicyLevel;
  delegateExternalResearch: boolean;
  runTestsAfterEdits: boolean;
  consultAdvisorOnLowConfidence: boolean;
  preferredReasoningModeHint: string | null;
  /** Extra tool names this level refuses beyond the hard rules. Additive
   * only - see `inheritSoftPolicy`. */
  additionalDeniedTools: string[];
  /**
   * Persisted layers that exist but could not be read.
   *
   * Missing state and corrupt state are different facts, and collapsing them
   * onto the same default is how a restriction disappears. A policy file that
   * is absent means "this level never set anything", and the defaults are the
   * right answer. A policy file that is present and unparseable means "this
   * level set something and we do not know what" - and the one thing that
   * cannot be inferred from it is that the something was permissive.
   *
   * Measured before this existed: persist `additionalDeniedTools: ["write"]`,
   * confirm the write is denied, corrupt the file, reload - and the write is
   * allowed, with nothing reported anywhere.
   *
   * Named layers rather than a boolean so the message can say which file to
   * go and look at.
   */
  unresolvedLayers: string[];
}

export function defaultSoftPolicy(level: PolicyLevel = "global"): SoftPolicy {
  return {
    level,
    delegateExternalResearch: true,
    runTestsAfterEdits: true,
    consultAdvisorOnLowConfidence: false,
    preferredReasoningModeHint: null,
    additionalDeniedTools: [],
    unresolvedLayers: [],
  };
}

/* ------------------------------------------------------------------ *
 * Persistence (spec section 17 "policy state")
 * ------------------------------------------------------------------ */

/**
 * Convert a resolved policy into one storable layer.
 *
 * `SoftPolicy` is the *resolved* value - already merged down the chain -
 * while `SoftPolicyRecord` is one contributing level. Writing a resolved
 * policy back to a single level would flatten global, device and project
 * into whichever level happened to be saved, so the two stay separate types
 * and the conversion is explicit at both ends.
 */
export function toSoftPolicyRecord(
  soft: SoftPolicy,
  level: PolicyLevel,
  updatedBy: Actor,
  updatedAt: string,
): SoftPolicyRecord {
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    level,
    delegateExternalResearch: soft.delegateExternalResearch,
    runTestsAfterEdits: soft.runTestsAfterEdits,
    consultAdvisorOnLowConfidence: soft.consultAdvisorOnLowConfidence,
    preferredReasoningModeHint: soft.preferredReasoningModeHint,
    additionalDeniedTools: [...soft.additionalDeniedTools].sort(),
    updatedAt,
    updatedBy,
  };
}

export function fromSoftPolicyRecord(record: SoftPolicyRecord): SoftPolicy {
  return {
    level: record.level,
    delegateExternalResearch: record.delegateExternalResearch,
    runTestsAfterEdits: record.runTestsAfterEdits,
    consultAdvisorOnLowConfidence: record.consultAdvisorOnLowConfidence,
    preferredReasoningModeHint: record.preferredReasoningModeHint,
    additionalDeniedTools: [...record.additionalDeniedTools],
  };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict validation. An unreadable policy layer is skipped entirely rather
 * than partially applied: a half-loaded policy is how a denied tool quietly
 * becomes an allowed one. */
export function validateSoftPolicyRecord(value: unknown): SoftPolicyRecord | null {
  if (!isRecordObject(value)) return null;
  if (value.schemaVersion !== HARNESS_SCHEMA_VERSION) return null;
  if (!POLICY_LEVELS.includes(value.level as PolicyLevel)) return null;
  for (const flag of [
    "delegateExternalResearch",
    "runTestsAfterEdits",
    "consultAdvisorOnLowConfidence",
  ]) {
    if (typeof value[flag] !== "boolean") return null;
  }
  if (value.preferredReasoningModeHint !== null && typeof value.preferredReasoningModeHint !== "string") {
    return null;
  }
  if (
    !Array.isArray(value.additionalDeniedTools) ||
    !value.additionalDeniedTools.every((tool) => typeof tool === "string")
  ) {
    return null;
  }
  if (typeof value.updatedAt !== "string" || typeof value.updatedBy !== "string") return null;
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    level: value.level as PolicyLevel,
    delegateExternalResearch: value.delegateExternalResearch as boolean,
    runTestsAfterEdits: value.runTestsAfterEdits as boolean,
    consultAdvisorOnLowConfidence: value.consultAdvisorOnLowConfidence as boolean,
    preferredReasoningModeHint: (value.preferredReasoningModeHint as string | null) ?? null,
    additionalDeniedTools: value.additionalDeniedTools as string[],
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy as Actor,
  };
}

/**
 * Resolve a stored chain into the policy a session actually runs under.
 *
 * Layers are applied broadest-first through `inheritSoftPolicy`, so each one
 * can only tighten what the previous left. Records arriving out of order are
 * sorted rather than trusted: a project layer applied before the global one
 * would let the global layer act as a child and relax it (section 22).
 */
export function resolveSoftPolicy(
  records: SoftPolicyRecord[],
  unresolvedLayers: string[] = [],
): SoftPolicy {
  const ordered = [...records].sort(
    (a, b) => POLICY_LEVELS.indexOf(a.level) - POLICY_LEVELS.indexOf(b.level),
  );
  let resolved = defaultSoftPolicy("global");
  for (const record of ordered) {
    resolved = inheritSoftPolicy(resolved, fromSoftPolicyRecord(record));
  }
  return { ...resolved, unresolvedLayers: [...new Set(unresolvedLayers)].sort() };
}

export type SoftPolicyEdit =
  | { ok: true; record: SoftPolicyRecord }
  | { ok: false; reason: string; rule: string };

/**
 * Apply one field change to a stored layer, on behalf of an actor.
 *
 * The coordinator holds `policy-change-soft` (see the capability matrix) but
 * only in the tightening direction: it may add a tool denial or switch on an
 * extra check, and it may not relax one the user set. Loosening is a user
 * action. Without this asymmetry "soft policy is tunable by the model" would
 * be a hole underneath section 22 rather than a layer inside it.
 */
export function editSoftPolicy(
  current: SoftPolicyRecord,
  actor: Actor,
  field: string,
  rawValue: string,
  updatedAt: string,
): SoftPolicyEdit {
  const next: SoftPolicyRecord = {
    ...current,
    additionalDeniedTools: [...current.additionalDeniedTools],
    updatedAt,
    updatedBy: actor,
  };
  const boolValue = rawValue === "true" || rawValue === "on" || rawValue === "yes";
  const relaxing = (was: boolean, now: boolean) => was && !now;

  switch (field) {
    case "delegateExternalResearch":
      next.delegateExternalResearch = boolValue;
      break;
    case "runTestsAfterEdits":
      if (actor !== "user" && relaxing(current.runTestsAfterEdits, boolValue)) {
        return { ok: false, reason: `actor "${actor}" may tighten soft policy, not relax it`, rule: "section 22" };
      }
      next.runTestsAfterEdits = boolValue;
      break;
    case "consultAdvisorOnLowConfidence":
      if (actor !== "user" && relaxing(current.consultAdvisorOnLowConfidence, boolValue)) {
        return { ok: false, reason: `actor "${actor}" may tighten soft policy, not relax it`, rule: "section 22" };
      }
      next.consultAdvisorOnLowConfidence = boolValue;
      break;
    case "preferredReasoningModeHint":
      next.preferredReasoningModeHint = rawValue.trim().length > 0 ? rawValue.trim() : null;
      break;
    case "denyTool":
      if (!next.additionalDeniedTools.includes(rawValue)) next.additionalDeniedTools.push(rawValue);
      next.additionalDeniedTools.sort();
      break;
    case "allowTool":
      // Removing a denial is a relaxation, so it is the user's alone.
      if (actor !== "user") {
        return { ok: false, reason: `actor "${actor}" cannot remove a tool denial`, rule: "section 22" };
      }
      next.additionalDeniedTools = next.additionalDeniedTools.filter((tool) => tool !== rawValue);
      break;
    default:
      return { ok: false, reason: `unknown soft-policy field "${field}"`, rule: "section 21" };
  }
  return { ok: true, record: next };
}

export function formatSoftPolicy(soft: SoftPolicy, sources: PolicyLevel[]): string {
  return [
    `resolved from: ${sources.length > 0 ? sources.join(" -> ") : "defaults only"}`,
    `delegateExternalResearch: ${soft.delegateExternalResearch}`,
    `runTestsAfterEdits: ${soft.runTestsAfterEdits}`,
    `consultAdvisorOnLowConfidence: ${soft.consultAdvisorOnLowConfidence}`,
    `preferredReasoningModeHint: ${soft.preferredReasoningModeHint ?? "(none)"}`,
    `additionalDeniedTools: ${soft.additionalDeniedTools.join(", ") || "(none)"}`,
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Inheritance (spec section 22)
 * ------------------------------------------------------------------ */

/** Index into APPROVAL_POLICIES, which is ordered most-restrictive first. */
function approvalRank(policy: ApprovalPolicy): number {
  return APPROVAL_POLICIES.indexOf(policy);
}

/** True when `child` is at least as strict as `parent`. */
export function atLeastAsStrict(child: ApprovalPolicy, parent: ApprovalPolicy): boolean {
  return approvalRank(child) <= approvalRank(parent);
}

const AUTONOMY_RANK: Record<AutonomyMode, number> = {
  interactive: 0,
  guided: 1,
  autonomous: 2,
};

/**
 * Resolve a child's requested approval policy against its parent.
 *
 * A child may tighten and may not weaken. The clamp is silent by design at
 * this layer - the caller audits the request and the result, so a downgrade
 * attempt is visible in the audit trail rather than in an exception nobody
 * catches.
 */
export function inheritApprovalPolicy(
  parent: ApprovalPolicy,
  requested: ApprovalPolicy,
): ApprovalPolicy {
  return atLeastAsStrict(requested, parent) ? requested : parent;
}

export function inheritAutonomy(parent: AutonomyMode, requested: AutonomyMode): AutonomyMode {
  return AUTONOMY_RANK[requested] <= AUTONOMY_RANK[parent] ? requested : parent;
}

/**
 * Merge a child soft policy onto its parent.
 *
 * Every boolean is combined so that the restrictive value wins, and denied
 * tools are unioned. There is deliberately no field whose child value can
 * relax the parent: that would make soft policy a hole in section 22 rather
 * than a layer beneath it.
 */
export function inheritSoftPolicy(parent: SoftPolicy, child: Partial<SoftPolicy>): SoftPolicy {
  return {
    level: child.level ?? parent.level,
    delegateExternalResearch: child.delegateExternalResearch ?? parent.delegateExternalResearch,
    runTestsAfterEdits: (child.runTestsAfterEdits ?? parent.runTestsAfterEdits) || parent.runTestsAfterEdits,
    consultAdvisorOnLowConfidence:
      (child.consultAdvisorOnLowConfidence ?? parent.consultAdvisorOnLowConfidence) ||
      parent.consultAdvisorOnLowConfidence,
    preferredReasoningModeHint:
      child.preferredReasoningModeHint ?? parent.preferredReasoningModeHint,
    additionalDeniedTools: [
      ...new Set([...parent.additionalDeniedTools, ...(child.additionalDeniedTools ?? [])]),
    ].sort(),
    // Unions, and is never cleared by a child: an unreadable layer stays
    // unreadable no matter what a narrower level says about itself.
    unresolvedLayers: [
      ...new Set([...(parent.unresolvedLayers ?? []), ...(child.unresolvedLayers ?? [])]),
    ].sort(),
  };
}

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

export interface AuthorizationRequest {
  actor: Actor;
  action: Action;
  /** Canonical path for filesystem actions; a tool or memory id otherwise.
   * Null for actions with no target (e.g. model-switch). */
  target: string | null;
  /**
   * The tool being invoked, when the request comes from a tool call.
   *
   * Separate from `target` because they are different things and conflating
   * them broke a rule silently: `additionalDeniedTools` lists *tool names*,
   * but for any tool with a path argument `target` is the path, so a denial
   * of "write" was compared against "/p/a.ts" and never matched. Soft tool
   * denials were inert for exactly the tools worth denying.
   */
  toolName?: string | null;
  /** Already canonicalized and scope-checked by scope.ts. Passing the raw
   * boolean rather than the path keeps this module free of filesystem
   * concerns - and free of the temptation to re-derive a scope check with
   * subtly different rules. */
  targetInScope: boolean | null;
  scope: ScopeState;
  autonomy: AutonomyMode;
  approvalPolicy: ApprovalPolicy;
  soft: SoftPolicy;
  /** True when the user has already approved this exact operation. */
  userApproved: boolean;
}

export type AuthorizationVerdict = "allow" | "needs-approval" | "deny";

export interface AuthorizationDecision {
  verdict: AuthorizationVerdict;
  reason: string;
  /** Which invariant or rule produced the outcome. Written into the audit
   * event so a denial can be explained months later without re-deriving it. */
  rule: string;
}

function deny(reason: string, rule: string): AuthorizationDecision {
  return { verdict: "deny", reason, rule };
}

function allow(reason: string, rule: string): AuthorizationDecision {
  return { verdict: "allow", reason, rule };
}

function ask(reason: string, rule: string): AuthorizationDecision {
  return { verdict: "needs-approval", reason, rule };
}

/**
 * The single authorization entry point.
 *
 * Order of checks matters and is not arbitrary - each stage can only ever
 * make the outcome stricter than the one before it:
 *
 *   1. constitutional refusals   (nothing unlocks these)
 *   2. actor capability          (A1-A4)
 *   3. scope                     (S1-S6)
 *   4. soft-policy tool denials  (self-imposed, still binding)
 *   5. approval policy           (what needs a human yes)
 *   6. autonomy                  (how often a human is in the loop)
 */
export function authorize(request: AuthorizationRequest): AuthorizationDecision {
  const { actor, action } = request;

  // 1. Constitutional. Checked before capability so that even the user, who
  // holds every capability, cannot reach these through an ordinary request -
  // section 24 requires an explicit administrative action outside this path.
  if (action === "audit-rewrite") {
    return deny("audit history is append-oriented", "AU1");
  }
  if (action === "policy-change-hard" && actor !== "user") {
    return deny("hard policy is not model-modifiable", "A5");
  }

  // 2. Capability.
  const capabilities = CAPABILITIES[actor];
  if (capabilities === undefined) {
    return deny(`unknown actor: ${actor}`, "deny-by-default");
  }
  if (!capabilities.has(action)) {
    return deny(`actor "${actor}" has no authority for "${action}"`, "A2/A3");
  }

  // 3. Scope. Only meaningful when the request names a filesystem target;
  // `targetInScope: null` means "not a path", not "unchecked".
  if (request.targetInScope === false) {
    if (action === "scope-expand") {
      // Expanding scope is by definition a request about something outside
      // it - handled by scope.ts, which decides auto/approval/refuse.
    } else {
      return deny(`target outside scope: ${request.target ?? "(unnamed)"}`, "S3/S6");
    }
  }

  // 4. Self-imposed tool denials.
  const deniableName = request.toolName ?? request.target;
  if (
    deniableName !== null &&
    deniableName !== undefined &&
    (action === "shell" || action === "mutate" || action === "read") &&
    request.soft.additionalDeniedTools.includes(deniableName)
  ) {
    return deny(`denied by soft policy at ${request.soft.level} level`, "section 22");
  }

  // 4b. A policy layer exists but could not be read.
  //
  // The restrictions it carried are unknown, so the only safe reading is that
  // there were some. Approval rather than refusal: the user can still work,
  // and every consequential act goes past a human until the layer is repaired
  // or explicitly replaced. With no UI to ask, `authorize`'s caller fails
  // closed, which is the correct end of the trade.
  //
  // Not applied to the user: the person who has to repair the file must be
  // able to act in order to repair it.
  if (
    (request.soft.unresolvedLayers?.length ?? 0) > 0 &&
    actor !== "user" &&
    !request.userApproved &&
    (MUTATING_ACTIONS.has(action) || CONSEQUENTIAL_ACTIONS.has(action))
  ) {
    return ask(
      `policy layer(s) ${request.soft.unresolvedLayers.join(", ")} exist but could not be read; their restrictions are unknown, so "${action}" needs the user until they are repaired`,
      "section 22 / fail-closed",
    );
  }

  // 5. Shell has its own floor regardless of approval posture: the
  // unsandboxed builtin is refused unless the user granted it explicitly on
  // the scope object (spec section 9). Nothing a model says reaches this.
  if (action === "shell" && !request.scope.unsafeBuiltinBashGrant && request.target === "bash") {
    return deny("unrestricted builtin bash is blocked; use the sandboxed shell", "section 9");
  }

  if (request.userApproved) {
    return allow("explicitly approved by the user", "A1");
  }

  // 5b. Posture (spec section 32).
  //
  // Loosening posture is an authority expansion. "Ask me less often" and
  // "let me act unattended" are the same act as enlarging scope, expressed
  // in a vocabulary that does not sound like it - which is precisely why it
  // needs its own rule rather than being left to the approval policy. Note
  // this fires even under `approvalPolicy: "none"`: a posture of "never ask"
  // must not be self-extending, or the first loosening would authorize every
  // later one.
  if (action === "posture-loosen" && actor !== "user") {
    return ask(
      "loosening autonomy or approval is an authority expansion and needs the user",
      "A2 / section 32",
    );
  }

  // 6. Approval policy.
  switch (request.approvalPolicy) {
    case "all-actions":
      if (actor !== "user") return ask("approval policy requires approval for all actions", "section 21");
      break;
    case "mutations":
      if (MUTATING_ACTIONS.has(action) || action === "scope-expand" || action === "memory-promote-global") {
        return ask(`approval policy requires approval for "${action}"`, "section 21");
      }
      break;
    case "consequential":
      if (CONSEQUENTIAL_ACTIONS.has(action)) {
        return ask(`approval policy requires approval for consequential "${action}"`, "section 21");
      }
      break;
    case "none":
      break;
    default:
      return deny("unrecognized approval policy", "deny-by-default");
  }

  // 7. Autonomy. Interactive means a human stays in the loop for anything
  // that changes state, even where the approval policy would not demand it.
  if (request.autonomy === "interactive" && MUTATING_ACTIONS.has(action) && actor !== "user") {
    return ask("interactive autonomy keeps the user in the loop for changes", "section 2.5");
  }

  return allow(`permitted for ${actor}`, "capability + scope + policy");
}

/**
 * Whether a queued task may run right now without a human present.
 *
 * Separate from `authorize()` because it answers a different question, and
 * conflating them is exactly how "the user is asleep" turns into extra
 * authority. Spec section 14: a task does not become more autonomous because
 * the user is absent - so absence is not even an input here.
 */
export function mayRunUnattended(
  taskAutonomy: AutonomyMode,
  taskApproval: ApprovalPolicy,
  unmetConditions: string[],
): { allowed: boolean; reason: string } {
  if (unmetConditions.length > 0) {
    return { allowed: false, reason: `unmet execution conditions: ${unmetConditions.join("; ")}` };
  }
  if (taskAutonomy !== "autonomous") {
    return { allowed: false, reason: `task autonomy is "${taskAutonomy}", not "autonomous"` };
  }
  if (taskApproval === "all-actions" || taskApproval === "mutations") {
    return { allowed: false, reason: `task approval policy "${taskApproval}" needs a human` };
  }
  return { allowed: true, reason: "task carries its own unattended envelope" };
}

/* ------------------------------------------------------------------ *
 * Posture authority (spec section 32)
 * ------------------------------------------------------------------ */

/**
 * Which way a proposed posture change moves authority.
 *
 * The classification is mechanical rather than a judgment call, and it has
 * to be: "am I allowed to change this" is being answered about a change the
 * coordinator itself proposed, so any step that depends on the coordinator's
 * description of its own request is not a check.
 *
 * Reasoning style is `neutral` because it carries no authority at all - a
 * constrained reasoner and an exploratory one may do exactly the same set of
 * things (spec section 2.4 makes the two controls independent, and this is
 * where that independence is cashed out).
 */
export function classifyPostureChange(
  field: PostureField,
  from: string,
  to: string,
): PostureDirection {
  if (from === to) return "neutral";
  if (field === "reasoning") return "neutral";

  // Both orderings run most-restrictive-first, so a higher index is always
  // less restrictive. This is the same index discipline `atLeastAsStrict`
  // relies on; reordering either constant breaks both, which is why both
  // constants carry a warning at their definition.
  const order: readonly string[] = field === "autonomy" ? AUTONOMY_MODES : APPROVAL_POLICIES;
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  // An unrecognized value is treated as a loosening rather than as neutral.
  // Deny-by-default applied to a classifier: the failure mode of guessing
  // "neutral" here is an unreviewed authority expansion, and the failure mode
  // of guessing "loosen" is one unnecessary approval prompt.
  if (fromIndex < 0 || toIndex < 0) return "loosen";
  return toIndex > fromIndex ? "loosen" : "tighten";
}

/**
 * The authorization action a posture change should be checked as.
 *
 * Returns null for a neutral change, meaning there is nothing to authorize -
 * not that it is automatically permitted. Callers must treat null as "skip
 * the check", which is only correct because `neutral` is exactly the set of
 * changes that alter no authority.
 */
export function postureAction(direction: PostureDirection): Action | null {
  if (direction === "loosen") return "posture-loosen";
  if (direction === "tighten") return "posture-tighten";
  return null;
}

/** The capability set for an actor, for display by `/harness authority`.
 * Returned as a sorted copy so a caller cannot mutate the matrix. */
export function capabilitiesOf(actor: Actor): Action[] {
  const set = CAPABILITIES[actor];
  return set ? [...set].sort() : [];
}
