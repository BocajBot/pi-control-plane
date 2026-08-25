/**
 * Pi Harness - runtime configuration and the storage layout (spec section 28).
 *
 * This module owns exactly one thing beyond defaults: the mapping from
 * (home, project root, model) to file paths. Keeping it in one place means
 * store.ts never joins a path itself, so the layout can move without a
 * search-and-replace across the harness - which matters because section 28
 * explicitly calls the layout provisional.
 *
 * Pure: path arithmetic and validation only. No mkdir, no reads. store.ts
 * does the I/O.
 */

import * as path from "node:path";

import {
  APPROVAL_POLICIES,
  AUTONOMY_MODES,
  HARNESS_SCHEMA_VERSION,
  isSupportedSchemaVersion,
  REASONING_MODES,
  type ApprovalPolicy,
  type AutonomyMode,
  type HarnessConfig,
  type ModelConfiguration,
  type ReasoningMode,
} from "./types.ts";
import { nowIso, projectKey, type Clock } from "./util.ts";

/** Override for tests and for running two harness instances side by side.
 * Read once at construction, never at each access, so a mid-session env
 * change cannot silently split state across two directories. */
export const HARNESS_HOME_ENV = "PI_HARNESS_HOME";

export interface HarnessPaths {
  /** `~/.pi/agent/pi-harness` unless overridden. */
  home: string;
  /** The project root this layout was built for. Carried so the store can
   * check that a project-local write actually lands inside it - a `.pi`
   * symlink otherwise redirects Core-owned recovery files anywhere on the
   * filesystem. */
  projectRoot: string;
  configFile: string;
  tasksFile: string;
  reviewQueueFile: string;
  memoryFile: string;
  /** Identity state (spec section 17): who Pi is, across every project. */
  identityFile: string;
  /** Goals above tasks, and links between projects (spec section 13). */
  goalsFile: string;
  projectLinksFile: string;
  /** Soft-policy layers. Global and device live at the harness home; the
   * project layer lives with the rest of that project's state. */
  globalPolicyFile: string;
  devicePolicyFile: string;
  modelsDir: string;
  reviewsDir: string;
  projectsDir: string;
  /** Global `sessionId -> projectRoot` index (spec section 32). Lives at the
   * harness home rather than under a project, because its whole purpose is
   * to answer the question before the project is known. */
  sessionsIndexFile: string;
  /** Per-project state directory for the project root this session is in. */
  projectDir: string;
  /**
   * Legacy single-snapshot session state (v0.1).
   *
   * Still read, never written. v0.2 writes one file per session under
   * `sessionsDir`; this path is kept so an interrupted v0.1 session is still
   * recoverable rather than orphaned by the upgrade.
   */
  sessionStateFile: string;
  /** Per-session structured state: `<projectDir>/sessions/<session-id>.json`. */
  sessionsDir: string;
  projectPolicyFile: string;
  auditFile: string;
  /** Endpoint commitment for `auditFile` - the length and last hash a
   * verifier expects to find. See `AuditTip`. */
  auditTipFile: string;
  decisionsFile: string;
  /** Append-only delegated-child lifecycle. Running records left by a dead
   * parent are reconciled to orphaned; no seamless child survival is
   * implied. */
  delegationsFile: string;
  /** One plain-text transcript per delegate run: `<projectDir>/delegation-transcripts/<contract-id>.log`. */
  delegationTranscriptsDir: string;
  /** Phase 4.3 write-only proposal channel. Human-reviewed drafts derived from
   * the evaluator; the runtime never reads it - a proposal becomes behavior
   * only when a human bridges it into AGENTS.md / config / memory. */
  improvementProposalsFile: string;
  incidentsFile: string;
  /** In-project recovery file (spec section 16). Normally gitignored. */
  workstateFile: string;
  /**
   * Per-session recovery copies: `<project>/.pi/workstates/<session-id>.md`.
   *
   * `WORKSTATE.md` answers "what was happening most recently"; this
   * directory answers "what was happening in session X". One file cannot do
   * both, because the first is overwritten by design.
   */
  workstatesDir: string;
  /**
   * Harness-owned fallback for project-local recovery files.
   *
   * Used when the in-project location cannot be written safely - a `.pi`
   * that resolves outside the project, for instance. Recovery metadata then
   * lands somewhere the harness controls rather than somewhere an attacker
   * chose, and rather than not being written at all.
   */
  recoveryFallbackDir: string;
  /** Per-session review generations: `reviews/<session-id>/`. */
  reviewGenerationsDir: string;
}

export function defaultHarnessHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HARNESS_HOME_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(home, ".pi", "agent", "pi-harness");
}

export function harnessPaths(
  home: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): HarnessPaths {
  const base = defaultHarnessHome(home, env);
  const projectDir = path.join(base, "projects", projectKey(projectRoot));
  return {
    home: base,
    projectRoot,
    configFile: path.join(base, "config.json"),
    tasksFile: path.join(base, "tasks.json"),
    reviewQueueFile: path.join(base, "review-queue.json"),
    memoryFile: path.join(base, "memory.jsonl"),
    identityFile: path.join(base, "identity.json"),
    goalsFile: path.join(base, "goals.json"),
    projectLinksFile: path.join(base, "project-links.json"),
    globalPolicyFile: path.join(base, "policy-global.json"),
    devicePolicyFile: path.join(base, "policy-device.json"),
    modelsDir: path.join(base, "models"),
    reviewsDir: path.join(base, "reviews"),
    projectsDir: path.join(base, "projects"),
    sessionsIndexFile: path.join(base, "sessions.json"),
    projectDir,
    sessionStateFile: path.join(projectDir, "session-state.json"),
    sessionsDir: path.join(projectDir, "sessions"),
    projectPolicyFile: path.join(projectDir, "policy-project.json"),
    auditFile: path.join(projectDir, "audit.jsonl"),
    auditTipFile: path.join(projectDir, "audit.tip.json"),
    decisionsFile: path.join(projectDir, "decisions.jsonl"),
    delegationsFile: path.join(projectDir, "delegations.jsonl"),
    delegationTranscriptsDir: path.join(projectDir, "delegation-transcripts"),
    improvementProposalsFile: path.join(projectDir, "improvement-proposals.jsonl"),
    incidentsFile: path.join(projectDir, "incidents.jsonl"),
    workstateFile: path.join(projectRoot, ".pi", "WORKSTATE.md"),
    workstatesDir: path.join(projectRoot, ".pi", "workstates"),
    recoveryFallbackDir: path.join(projectDir, "recovery"),
    reviewGenerationsDir: path.join(base, "reviews"),
  };
}

/**
 * Structured state for one session: `<projectDir>/sessions/<session-id>.json`.
 *
 * The id is slugged with the same function the model directories use. A
 * session id is harness-issued and already safe, but this path is also built
 * from ids that arrive from outside (a reviewer naming a session to re-read),
 * and a path helper that is only safe for trusted input is a path helper that
 * will eventually be called with untrusted input.
 */
export function sessionStateFileFor(paths: HarnessPaths, sessionId: string): string {
  return path.join(paths.sessionsDir, `${slugModelPart(sessionId)}.json`);
}

/** Per-session recovery copy: `<project>/.pi/workstates/<session-id>.md`. */
export function workstateFileFor(paths: HarnessPaths, sessionId: string): string {
  return path.join(paths.workstatesDir, `${slugModelPart(sessionId)}.md`);
}

/** Directory holding every review generation for one session. */
export function reviewDirFor(paths: HarnessPaths, sessionId: string): string {
  return path.join(paths.reviewGenerationsDir, slugModelPart(sessionId));
}

/**
 * One review generation: `reviews/<session-id>/001.json`.
 *
 * Zero-padded so a directory listing sorts chronologically, which is how a
 * human reads a sequence of reviews of the same session.
 */
export function reviewGenerationFile(
  paths: HarnessPaths,
  sessionId: string,
  generation: number,
): string {
  return path.join(reviewDirFor(paths, sessionId), `${String(generation).padStart(3, "0")}.json`);
}

/**
 * Directory holding a model's own instruction layer (spec section 6.4):
 * `models/<provider>__<model>/`.
 *
 * The separator is a double underscore because a model id routinely contains
 * `/` (`meta-llama/Llama-3.3-70B`) and single `_` (`qwen3_coder`). Slashes
 * are replaced rather than nested so one model is one directory - nesting
 * would make `guidance-proposals.jsonl` ambiguous between a provider and a
 * model whose name happens to contain a slash.
 */
export function modelDir(paths: HarnessPaths, model: ModelConfiguration): string {
  return path.join(paths.modelsDir, `${slugModelPart(model.provider)}__${slugModelPart(model.model)}`);
}

export function modelAgentsFile(paths: HarnessPaths, model: ModelConfiguration): string {
  return path.join(modelDir(paths, model), "AGENTS.md");
}

export function modelProposalsFile(paths: HarnessPaths, model: ModelConfiguration): string {
  return path.join(modelDir(paths, model), "guidance-proposals.jsonl");
}

export function reviewFile(paths: HarnessPaths, sessionId: string): string {
  return path.join(paths.reviewsDir, `${slugModelPart(sessionId)}.json`);
}

function slugModelPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Defaults. Note `defaultAutonomy: "guided"` and
 * `defaultApprovalPolicy: "mutations"` - spec section 2.5 makes guided the
 * default, and the matching approval posture is "ask before you change
 * anything", not "ask before anything at all".
 *
 * The sandbox mount lists start empty on purpose. A default of `/usr` etc.
 * would be a guess about the host; sandbox.ts filters to paths that exist,
 * but an unconfigured harness should refuse to run a shell rather than
 * quietly assemble a mount set nobody chose.
 */
export function defaultConfig(clock: Clock = () => new Date()): HarnessConfig {
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    preferredCoordinator: null,
    preferredReviewer: null,
    defaultReasoningMode: "balanced",
    defaultAutonomy: "guided",
    defaultApprovalPolicy: "mutations",
    // System toolchain, loader and resolver config, read-only. Without these
    // the sandboxed shell refuses outright (plan() rejects an empty mount set),
    // which used to push the coordinator toward heavier authority (delegation)
    // just to run a test - see GATE-FATIGUE-REDESIGN.md P4. $HOME is
    // deliberately absent: binding it would expose the credential paths the
    // sandbox otherwise only shadows. A runtime installed outside these
    // prefixes (nvm, asdf, Nix) is handled separately by the interpreter-prefix
    // mount in sandbox.ts, not by widening this list.
    sandboxReadOnlyPaths: ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"],
    sandboxShadowDirs: [],
    sandboxShadowFiles: [],
    updatedAt: nowIso(clock),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === "string")) return null;
  return value as string[];
}

export function validateModelConfiguration(value: unknown): ModelConfiguration | null {
  if (!isRecord(value)) return null;
  if (typeof value.provider !== "string" || value.provider.length === 0) return null;
  if (typeof value.model !== "string" || value.model.length === 0) return null;
  if (value.thinkingLevel !== undefined && typeof value.thinkingLevel !== "string") return null;
  const result: ModelConfiguration = { provider: value.provider, model: value.model };
  if (typeof value.thinkingLevel === "string") result.thinkingLevel = value.thinkingLevel;
  return result;
}

/**
 * Strict validation, same posture as validateSandboxState in the control
 * plane: anything unexpected yields null and the caller falls back to
 * `defaultConfig()`. Never a repaired guess - a partially understood config
 * is how a scope or approval default silently loosens.
 */
export function validateConfig(value: unknown): HarnessConfig | null {
  if (!isRecord(value)) return null;
  // A v0.1 config is readable: no field changed between v0.1 and v0.2, so
  // accepting it loses nothing, whereas rejecting it would silently reset a
  // user's preferred coordinator and approval default back to the built-ins.
  if (!isSupportedSchemaVersion(value.schemaVersion)) return null;

  const coordinator =
    value.preferredCoordinator === null ? null : validateModelConfiguration(value.preferredCoordinator);
  if (value.preferredCoordinator !== null && coordinator === null) return null;
  const reviewer =
    value.preferredReviewer === null ? null : validateModelConfiguration(value.preferredReviewer);
  if (value.preferredReviewer !== null && reviewer === null) return null;

  if (!REASONING_MODES.includes(value.defaultReasoningMode as ReasoningMode)) return null;
  if (!AUTONOMY_MODES.includes(value.defaultAutonomy as AutonomyMode)) return null;
  if (!APPROVAL_POLICIES.includes(value.defaultApprovalPolicy as ApprovalPolicy)) return null;

  const roPaths = stringArray(value.sandboxReadOnlyPaths);
  const shadowDirs = stringArray(value.sandboxShadowDirs);
  const shadowFiles = stringArray(value.sandboxShadowFiles);
  if (roPaths === null || shadowDirs === null || shadowFiles === null) return null;
  if (typeof value.updatedAt !== "string") return null;

  const knownKeys = new Set([
    "schemaVersion",
    "preferredCoordinator",
    "preferredReviewer",
    "defaultReasoningMode",
    "defaultAutonomy",
    "defaultApprovalPolicy",
    "sandboxReadOnlyPaths",
    "sandboxShadowDirs",
    "sandboxShadowFiles",
    "updatedAt",
  ]);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) return null;
  }

  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    preferredCoordinator: coordinator,
    preferredReviewer: reviewer,
    defaultReasoningMode: value.defaultReasoningMode as ReasoningMode,
    defaultAutonomy: value.defaultAutonomy as AutonomyMode,
    defaultApprovalPolicy: value.defaultApprovalPolicy as ApprovalPolicy,
    sandboxReadOnlyPaths: roPaths,
    sandboxShadowDirs: shadowDirs,
    sandboxShadowFiles: shadowFiles,
    updatedAt: value.updatedAt,
  };
}
