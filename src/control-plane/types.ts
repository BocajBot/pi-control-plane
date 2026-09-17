/**
 * Shared types and constants for the Pi Control Plane.
 *
 * This module is pure: no Pi imports, no I/O. Everything here can be used
 * from unit tests without launching Pi.
 */

export const PHASES = ["discuss", "plan", "execute", "verify"] as const;
export type Phase = (typeof PHASES)[number];

/**
 * "unattended" runs full autonomy with nobody watching in real time: every
 * allowed call under it is logged as a diagnostic entry (audit trail for
 * later review) - see extension entry, tool_call handler.
 *
 * "auto" sits between attended and restricted: ordinary edits inside the
 * project root stop asking, while everything a confirmation actually protects
 * against - shell, deletion, writes outside the root, credential paths,
 * harness tools - still asks. It is the level that makes a no-UI session
 * usable, because the calls it allows never needed a dialog in the first
 * place. It deliberately does NOT auto-approve what attended would have
 * asked about for a reason.
 */
export const AUTONOMY_LEVELS = ["read-only", "attended", "auto", "restricted", "unattended"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export const STATE_SCHEMA_VERSION = 2;
export const SNAPSHOT_SCHEMA_VERSION = 1;
/** Bumped to 2 for allowPathPrefixes (out-of-root allowlist). A policy file
 * saved under schema 1 is unknown-version -> null -> Read-only fallback,
 * same as any other invalid policy; this is deliberate, not a bug. */
export const POLICY_SCHEMA_VERSION = 2;
export const SCRATCHPAD_SCHEMA_VERSION = 1;
export const SANDBOX_SCHEMA_VERSION = 1;

/** Session entry customType used to persist control-plane state. */
export const STATE_ENTRY_TYPE = "pi-control-plane-state";
/** Session entry customType used for chat-visible command output. */
export const OUTPUT_ENTRY_TYPE = "pi-control-plane-output";
/** Session entry customType used for diagnostic events (e.g. blocked reads,
 * and every tool call allowed under Unattended autonomy). */
export const DIAGNOSTIC_ENTRY_TYPE = "pi-control-plane-diagnostic";
/** Session entry customType used to persist the scratchpad. Survives /compact
 * the same way state does: entries are excluded from LLM context and are
 * untouched by compaction, which only summarizes messages. */
export const SCRATCHPAD_ENTRY_TYPE = "pi-control-plane-scratchpad";
/** Session entry customType used to persist bwrap-sandbox state (on/off,
 * network). Its own entry type and schema version, restored the same
 * walk-backward way as state.ts and scratchpad.ts - deliberately not folded
 * into ControlPlaneState so this feature's schema can evolve independently
 * (see scratchpad.ts's header for the same reasoning). */
export const SANDBOX_ENTRY_TYPE = "pi-control-plane-sandbox";

export type SourceKind = "context-file" | "skill" | "tool" | "prompt-template";

export interface SnapshotItem {
  /** Stable toggle name, e.g. "file:/path/AGENTS.md", "skill:foo", "tool:bash". */
  name: string;
  kind: SourceKind;
  /** Short human-readable detail (description or path). Never raw content. */
  detail?: string;
  enabled: boolean;
  toggleable: boolean;
}

export interface ContextSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  timestamp: string;
  provider: string | null;
  model: string | null;
  contextWindow: number | null;
  tokens: number | null;
  percent: number | null;
  messageCount: number | null;
  messagesByRole: Record<string, number>;
  /** Context files, skills, and prompt templates. Sorted by name. */
  sources: SnapshotItem[];
  /** Active tool names. Sorted. */
  tools: string[];
  systemPromptLength: number | null;
  /** sha256 of the redacted system prompt. */
  systemPromptHash: string | null;
  providerPayloadLength: number | null;
  /** sha256 of the redacted provider payload JSON. */
  providerPayloadHash: string | null;
  phase: Phase;
  autonomy: Autonomy;
}

export interface ControlPlaneState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  phase: Phase;
  autonomy: Autonomy;
  previousContextSnapshot: ContextSnapshot | null;
  /** Source toggle map: toggle name -> enabled. Missing key means enabled. */
  sourceToggles: Record<string, boolean>;
  updatedAt: string;
}

/** Restricted-mode policy, loaded from policy/default-policy.json and validated. */
export interface RestrictedPolicy {
  schemaVersion: typeof POLICY_SCHEMA_VERSION;
  /** Exact basenames that are always denied (e.g. ".env", "id_rsa"). */
  denyPathBasenames: string[];
  /** Substrings of the canonical path that are always denied (e.g. "/.ssh/"). */
  denyPathSubstrings: string[];
  /** Whether the bash tool is permitted in Restricted mode. Default false. */
  allowBash: boolean;
  /**
   * Directories outside the project root that mutating tools may also target,
   * in addition to the root itself. Each entry is canonicalized (realpath) at
   * check time; an entry that does not exist on disk is skipped entirely
   * (never falls back to a literal-string match). Deny patterns still apply
   * inside an allowed prefix - this widens where writes may land, it never
   * narrows what is denied. Empty array reproduces pre-allowlist behavior
   * exactly (root-only).
   */
  allowPathPrefixes: string[];
}

export type ToolAction = "allow" | "block" | "confirm";

export type RiskCategory =
  | "read"
  | "file-write"
  | "file-edit"
  | "shell"
  | "harness-tool"
  | "unknown-tool";

export interface ToolDecision {
  action: ToolAction;
  /** Which layer produced the decision, e.g. "autonomy:read-only", "phase:discuss". */
  rule: string;
  /** Human-readable reason, safe to show to the user and the model. */
  reason: string;
  riskCategory: RiskCategory;
  /** True/false when a target path was resolved, null when not applicable. */
  insideRoot: boolean | null;
  /** Actionable hint: what change would permit the operation, if any. */
  hint?: string;
}

export interface SnapshotDiff {
  previousAt: string;
  currentAt: string;
  providerChange: { from: string | null; to: string | null } | null;
  modelChange: { from: string | null; to: string | null } | null;
  addedSources: string[];
  removedSources: string[];
  /** Sources present in both but with changed enabled state or detail. */
  changedSources: string[];
  addedTools: string[];
  removedTools: string[];
  addedSkills: string[];
  removedSkills: string[];
  messageCountDelta: number | null;
  tokenDelta: number | null;
  systemPromptHashChanged: boolean;
  providerPayloadHashChanged: boolean;
}

/** One structured working note. Text only - the model decides what to write;
 * the control plane never fabricates or summarizes content into a note. */
export interface ScratchpadNote {
  id: string;
  text: string;
  createdAt: string;
}

export interface ScratchpadState {
  schemaVersion: typeof SCRATCHPAD_SCHEMA_VERSION;
  notes: ScratchpadNote[];
  updatedAt: string;
}

export const RULES_SCHEMA_VERSION = 1;
export const RULES_ENTRY_TYPE = "pi-control-plane-rules";

/**
 * One remembered decision: a soft-policy rule that suppresses a future
 * attended confirmation. Scope-bound (only applies within the project it was
 * created in) and always an allow with user-actor provenance. It can only
 * convert an attended CONFIRM into an allow; it can never loosen a hard rule
 * (read-before-edit, scope-write denials, sensitive-read confirms), because
 * those resolve to a block earlier or are excluded at match time.
 */
export interface RememberedRule {
  id: string;
  /** The tool this rule allows (e.g. "edit", "write"). */
  tool: string;
  /** Canonical absolute target path the rule allows the tool to act on. */
  target: string;
  /** Project root in force when the rule was created; the rule only applies
   * while that same project root is in force. */
  scopeRoot: string;
  createdAt: string;
}

export interface RememberedRulesState {
  schemaVersion: typeof RULES_SCHEMA_VERSION;
  rules: RememberedRule[];
  updatedAt: string;
  /**
   * Honor remembered rules in a session with no confirmation UI.
   *
   * Default (absent or false) keeps the original invariant: a no-UI session
   * fails closed even where a rule matches, because a rule suppresses a
   * PROMPT and there is none to suppress. Turning it on is a deliberate user
   * decision - "apply the approvals I already gave, unattended" - and it is
   * the only way a non-interactive run can satisfy a confirm gate. Rules are
   * still user-created and scope-bound, so this widens WHEN existing
   * authority applies, never WHAT it covers.
   */
  applyWithoutUi?: boolean;
}

/**
 * Bwrap-sandbox toggle. `enabled` wraps every allowed `bash` call in a
 * bubblewrap (unprivileged Linux namespaces) invocation before it executes -
 * see sandbox.ts. This is real OS-level isolation, unlike the `/mode
 * sandboxed` alias (Restricted autonomy), which is Pi-level policy
 * interception only; the two are independent and can be combined.
 * `network` controls whether the sandboxed command can reach the network
 * (default false: unshared).
 */
export interface SandboxState {
  schemaVersion: typeof SANDBOX_SCHEMA_VERSION;
  enabled: boolean;
  network: boolean;
  updatedAt: string;
}
