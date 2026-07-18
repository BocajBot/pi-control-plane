/**
 * Shared types and constants for the Pi Control Plane.
 *
 * This module is pure: no Pi imports, no I/O. Everything here can be used
 * from unit tests without launching Pi.
 */

export const PHASES = ["discuss", "plan", "execute", "verify"] as const;
export type Phase = (typeof PHASES)[number];

export const AUTONOMY_LEVELS = ["read-only", "attended", "restricted"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export const STATE_SCHEMA_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const POLICY_SCHEMA_VERSION = 1;

/** Session entry customType used to persist control-plane state. */
export const STATE_ENTRY_TYPE = "pi-control-plane-state";
/** Session entry customType used for chat-visible command output. */
export const OUTPUT_ENTRY_TYPE = "pi-control-plane-output";
/** Session entry customType used for diagnostic events (e.g. blocked interpret tool calls). */
export const DIAGNOSTIC_ENTRY_TYPE = "pi-control-plane-diagnostic";

export interface TaskBrief {
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

export interface PendingInterpretation {
  /** Redacted, size-limited raw model response, retained for display. */
  raw: string;
  /** Parsed brief. Null when parsing failed entirely. */
  brief: TaskBrief | null;
  /** True only when every required section was present. */
  valid: boolean;
  missingSections: string[];
  createdAt: string;
}

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
  hasAcceptedTask: boolean;
}

export interface InterpretGuard {
  active: boolean;
  savedPhase: Phase;
  savedAutonomy: Autonomy;
  /** The raw task request being interpreted. */
  taskRequest: string;
  startedAt: string;
}

export interface ControlPlaneState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  phase: Phase;
  autonomy: Autonomy;
  acceptedTask: TaskBrief | null;
  pendingInterpretation: PendingInterpretation | null;
  previousContextSnapshot: ContextSnapshot | null;
  /** Source toggle map: toggle name -> enabled. Missing key means enabled. */
  sourceToggles: Record<string, boolean>;
  interpretGuard: InterpretGuard | null;
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
}

export type ToolAction = "allow" | "block" | "confirm";

export type RiskCategory =
  | "read"
  | "file-write"
  | "file-edit"
  | "shell"
  | "unknown-tool";

export interface ToolDecision {
  action: ToolAction;
  /** Which layer produced the decision, e.g. "interpretation-guard", "phase:discuss". */
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
