/**
 * Pi Personal Agent Harness - extension entry point.
 *
 * Wiring only. Every decision this file appears to make is made in
 * ../src/harness/, which is pure and unit-tested without Pi; this file
 * translates between Pi's event surface and those modules. That split is the
 * same one extensions/control-plane.ts already follows, and it is what lets
 * the acceptance invariants in ARCHITECTURE.md section 27 be tested at all.
 *
 * Relationship to the control plane extension: they are siblings in one pi
 * package and they do not share state. The control plane governs a single
 * session's context and task interpretation; the harness governs authority,
 * durable state, and continuity across sessions.
 *
 * How they compose on a tool call is worth stating precisely, because the
 * obvious guess is wrong. Pi runs `tool_call` handlers in registration order
 * and short-circuits on the first block
 * (dist/core/extensions/runner.js: `if (result.block) return result`). The
 * control plane is registered first, so:
 *
 *   - Anything the control plane blocks never reaches the harness, and is
 *     therefore absent from the harness audit log. The call did not happen,
 *     so this is safe, but the harness log is a record of what the harness
 *     saw, not of everything that was attempted.
 *   - Anything the control plane allows *does* reach the harness, which then
 *     applies scope and authority independently. This is verified live:
 *     tests/smoke/harness-smoke.mjs approves a write at the control plane's
 *     confirmation prompt and the harness still denies it for being outside
 *     the scope root.
 *
 * So the composition is fail-closed in the direction that matters - neither
 * extension can grant what the other denies - but the ordering is load
 * bearing, not incidental.
 *
 * Runtime status (ARCHITECTURE.md section 30): the deterministic core is
 * unit-tested, the wiring is covered against a fake Pi, and the paths above
 * are smoke-tested inside a real pi process. `harness_delegate` and
 * `/harness-review run` remain the exception - they call createAgentSession
 * and have not been executed against a live model.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import {
  buildContract,
  checkReviewEvidence,
  nextReviewGeneration,
  parseHandoff,
  parseReviewProposals,
  renderContractPrompt,
  renderReviewPrompt,
  stripEchoedPrompt,
  validateReviewProposals,
  type DelegateKind,
  type ParentAuthority,
} from "../src/harness/agents.ts";
import {
  buildCatalog,
  classifyTool,
  defaultActiveTools,
  describeCatalog,
  describeConfinement,
  grantException,
  HARNESS_TOOLS,
} from "../src/harness/capability.ts";
import { formatAuditEvent, makeAuditEvent, type AuditContext } from "../src/harness/audit.ts";
import {
  attestCalls,
  attestChild,
  buildDelegateTools,
  isolatedDelegateResourceLoader,
  type DelegateExecRuntime,
  type DelegateRuntimeContract,
  type DelegateRuntimeLog,
} from "../src/harness/delegate-runtime.ts";
import { readPiSession, renderSessionTranscript } from "../src/harness/session-reader.ts";
import {
  defaultConfig,
  harnessPaths,
  modelAgentsFile,
  modelDir,
  modelProposalsFile,
  type HarnessPaths,
} from "../src/harness/config.ts";
import {
  activeMemory,
  formatMemoryEntry,
  promote,
  retrievableMemory,
  searchMemory,
} from "../src/harness/memory.ts";
import {
  conflictingGoals,
  formatGoal,
  formatLink,
  goalsForProject,
  makeGoal,
  makeProjectLink,
  relatedProjects,
  renderGoalBlock,
  setGoalStatus,
  upsertGoal,
  upsertLink,
} from "../src/harness/goals.ts";
import {
  addIdentityLine,
  removeIdentityLine,
  renderIdentityBlock,
  type IdentityField,
} from "../src/harness/identity.ts";
import {
  authorize,
  capabilitiesOf,
  classifyPostureChange,
  inheritApprovalPolicy,
  inheritAutonomy,
  CONSTITUTIONAL_RULES,
  defaultSoftPolicy,
  editSoftPolicy,
  formatSoftPolicy,
  postureAction,
  resolveSoftPolicy,
  toSoftPolicyRecord,
  type Action,
} from "../src/harness/policy.ts";
import { inferProjectRoot } from "../src/harness/project.ts";
import { formatIncident, makeDecision, makeIncident } from "../src/harness/records.ts";
import { buildDecisionTelemetry, type DecisionTelemetryInput } from "../src/harness/decision-telemetry.ts";
import { evaluate, type EvaluationReport, type DecisionClaim } from "../src/harness/decision-evaluation.ts";
import { toEvidence, chainTrust, extractExecutionRecords } from "../src/harness/decision-evaluation-adapter.ts";
import { readFileDiffEvidence, readExitCodeEvidence } from "../src/harness/external-evidence.ts";
import {
  generateProposals,
  selectNewProposals,
  classifyStaleness,
  type ImprovementProposal,
} from "../src/harness/decision-proposal.ts";
import {
  approvalStatement,
  latestDelegationJobs,
  makeDelegationJob,
  matchingUserApproval,
  orphanedDelegationJobs,
  transitionDelegationJob,
} from "../src/harness/delegation-jobs.ts";
import {
  builtinBashBlocked,
  plan as planSandbox,
  withoutBuiltinBash,
} from "../src/harness/sandbox.ts";
import {
  approveExpansion,
  checkPath,
  createScope,
  describeScope,
  requestExpansion,
  type PathOps,
} from "../src/harness/scope.ts";
import {
  addNote,
  checkpoint,
  closeSession,
  createSession,
  reconcile,
  sessionIndexEntry,
  switchCoordinator,
} from "../src/harness/state.ts";
import { HarnessStore } from "../src/harness/store.ts";
import { createTask, formatTask, queuedFor, transition, upsert } from "../src/harness/tasks.ts";
import {
  APPROVAL_POLICIES,
  AUTONOMY_MODES,
  HARNESS_SCHEMA_VERSION,
  POSTURE_FIELDS,
  REASONING_MODES,
  type ApprovalPolicy,
  type AuditEventType,
  type AutonomyMode,
  type CapabilityException,
  type PostureField,
  type HarnessConfig,
  type ModelConfiguration,
  type GoalHorizon,
  type IdentityState,
  type ProjectLinkKind,
  type ReviewQueueItem,
  type SessionState,
} from "../src/harness/types.ts";
import { makeId, nowIso } from "../src/harness/util.ts";
import { renderWorkstate } from "../src/harness/workstate.ts";

const OUTPUT_ENTRY_TYPE = "pi-harness-output";
const DIAGNOSTIC_ENTRY_TYPE = "pi-harness-diagnostic";

/** How many audit lines the recovery file and `/harness audit` show. The
 * full log stays on disk; this is a display bound, not a retention one. */
const AUDIT_TAIL = 20;

/**
 * Tool classification.
 *
 * The list that matters is READ_TOOLS, not a list of mutating ones. An
 * allowlist of known-harmless tools with everything else treated as mutating
 * is the only version that survives a tool this file has never heard of -
 * from another extension, an MCP server, or a future Pi built-in. The
 * inverse (a denylist of mutating names, everything else a read) silently
 * waves through exactly the tools nobody thought about, which is the
 * permissive fallthrough policy.ts's own header says A5 does not survive.
 *
 * This matches src/control-plane/tool-policy.ts, which classifies an
 * unrecognized tool as "unknown" and denies it categorically.
 */
const READ_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "local_web_search",
  "transcribe_audio",
  "harness_memory_search",
  "harness_find_capability",
  "harness_note",
  "harness_request_scope",
]);
const SHELL_TOOLS = new Set(["bash", "pi_harness_bash"]);

/**
 * Argument keys a tool may use to name a filesystem target.
 *
 * Pi's own tools use `path`, but a tool that uses any of these instead would
 * otherwise reach `authorize()` with `targetInScope: null`, which skips the
 * scope check entirely rather than failing it.
 */
const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file", "dir", "directory"];

function extractPath(input: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Contract handed to a delegate through the environment.
 *
 * Pi's `createAgentSession` builds a fresh resource loader when it is not
 * given one, which reloads this package's extensions - so a delegate runs a
 * *second in-process instance of this file*. Left alone, that instance
 * infers its own project root, grants itself a fresh full-project scope, and
 * authorizes as "coordinator", which would make the delegation contract
 * advisory prose rather than an enforced boundary (SA3/SA5).
 *
 * The marker below is how the child instance learns it is a child. It is
 * read once at session start and the parent clears it immediately after the
 * nested session is constructed.
 */
const DELEGATE_ENV = "PI_HARNESS_DELEGATE_CONTRACT";

/** The delegated child's read-only tool surface. Hand-written, because an
 * unlisted tool must not be able to appear here by accident - this list is
 * what the pre-prompt attestation compares the real runtime against. */
const DELEGATE_TOOL_NAMES = ["scoped_read", "scoped_list", "request_read_scope"];

/** The exact tool surface for a given delegate kind. Only an `operator` gets
 * `scoped_exec`, and it is appended here rather than in the shared constant so
 * advisor/subagent/reviewer cannot acquire it - attestChild's set-equality
 * check would reject the tool if it ever appeared on a non-operator child. */
const delegateToolNames = (kind: DelegateKind): string[] =>
  kind === "operator" ? [...DELEGATE_TOOL_NAMES, "scoped_exec"] : DELEGATE_TOOL_NAMES.slice();

interface DelegateMarker {
  contractId: string;
  kind: DelegateKind;
  allowedRoots: string[];
  root: string;
  parentSession: string;
  /**
   * The contract's posture.
   *
   * Carried because scope is not the only axis of authority, and the child
   * session is built from *config defaults* otherwise. A parent that had
   * tightened itself to interactive/all-actions would delegate a child that
   * booted at the configured guided/mutations - looser than its parent, which
   * is precisely what A3 and SA5 forbid. Scope was subset-checked and posture
   * was not, so the hole was on the axis nobody was looking at.
   */
  autonomy: AutonomyMode;
  approvalPolicy: ApprovalPolicy;
}

export default async function piHarnessExtension(pi: ExtensionAPI) {
  // Pi-provided modules are imported dynamically so this entry can also be
  // loaded outside Pi (by the test harness). Same pattern, and same
  // explicit degradation, as extensions/control-plane.ts.
  let TypeBoxType: Record<string, (...args: never[]) => unknown> | null = null;
  try {
    const typebox = (await import("typebox")) as unknown as { Type: typeof TypeBoxType };
    TypeBoxType = typebox.Type;
  } catch {
    TypeBoxType = null;
  }

  let createAgentSession:
    | ((options: Record<string, unknown>) => Promise<{ session: unknown }>)
    | null = null;
  // `createExtensionRuntime` is Pi's own factory for the object its extension
  // runner assigns onto. The isolated delegate needs a real one even though
  // it loads no extensions: a hand-rolled stub is missing fields the runner
  // writes to, and the session construction throws.
  let createExtensionRuntime: (() => unknown) | null = null;
  try {
    const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      createAgentSession: typeof createAgentSession;
      createExtensionRuntime?: () => unknown;
    };
    createAgentSession = sdk.createAgentSession ?? null;
    createExtensionRuntime = sdk.createExtensionRuntime ?? null;
  } catch {
    createAgentSession = null;
    createExtensionRuntime = null;
  }

  /**
   * A ResourceLoader that loads nothing.
   *
   * Without this a nested session inherits every globally discovered
   * extension, every skill, the project's AGENTS.md and a 15KB system
   * prompt - measured, not assumed. Two separate problems: the ambient tools
   * are authority the contract never granted, and the ambient context is the
   * contamination a subagent exists to avoid.
   */
  const isolatedResourceLoader = (): unknown => {
    return isolatedDelegateResourceLoader(createExtensionRuntime!);
  };

  /* ---------------------------------------------------------------- *
   * Session-local state
   * ---------------------------------------------------------------- */

  let store: HarnessStore | null = null;
  let paths: HarnessPaths | null = null;
  let config: HarnessConfig = defaultConfig();
  let session: SessionState | null = null;
  let soft = defaultSoftPolicy("project");
  /** Which actor this instance's tool calls are authorized as. "coordinator"
   * for a normal session; the delegate's kind when this instance *is* a
   * delegate (see DELEGATE_ENV). */
  let actingAs: AuditContext["actor"] = "coordinator";
  /** Set when this instance is running inside a delegate session. Such an
   * instance must not write the parent's recovery file or queue a review:
   * it is not the session those describe. */
  let delegateMarker: DelegateMarker | null = null;
  /** Identity, goals and project links: durable across sessions, loaded once
   * at session start (spec section 25 "load baseline identity"). */
  let identity: IdentityState | null = null;
  /** Cached bwrap probe. The binary does not appear or disappear mid-session,
   * and spawnSync is not free. */
  let bwrapCache: boolean | null = null;
  /**
   * Per-session capability exceptions (spec section 32).
   *
   * Held in memory and nowhere else. A grant that survived into the next
   * session would be a durable authority expansion created by one
   * in-conversation "yes"; the audit log records that it happened, and the
   * grant itself dies with the process.
   */
  const capabilityExceptions = new Map<string, CapabilityException>();

  const pathOps: PathOps = {
    realpath: (p) => fs.realpathSync(p),
    exists: (p) => fs.existsSync(p),
  };

  const emit = (title: string, lines: string[]) => {
    pi.appendEntry(OUTPUT_ENTRY_TYPE, { title, lines });
  };

  /**
   * Run a prompt on a nested agent session and return what it said.
   *
   * `AgentSession.prompt()` returns `Promise<void>` - it does not hand back
   * the reply. The first version of this code awaited it and read `.text`
   * off the result, which is always undefined, so every delegate and every
   * reviewer silently returned an empty string. The unit tests could not
   * catch it: they inject a fake runner that returns text, so they were
   * testing the contract this file failed to implement.
   *
   * Output is collected by subscribing before prompting, with a read of the
   * session branch as a fallback in case the event shape differs.
   */
  const runNestedPrompt = async (agentSession: unknown, promptText: string): Promise<string> => {
    const sess = agentSession as {
      prompt(text: string): Promise<void>;
      subscribe?: (listener: (event: unknown) => void) => () => void;
      sessionManager?: { getBranch?: () => unknown[] };
    };
    const collected: string[] = [];
    const textOf = (message: unknown): string => {
      const content = (message as { content?: unknown })?.content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((part) => (part as { type?: string })?.type === "text")
        .map((part) => (part as { text?: string }).text ?? "")
        .join("");
    };

    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe =
        sess.subscribe?.((event) => {
          const e = event as { type?: string; message?: unknown };
          if (e?.type !== "message_end") return;
          // Assistant messages only. `message_end` fires for the prompt too,
          // and without this filter the returned "reply" was the prompt
          // followed by the answer.
          //
          // Found on the first live run of the review gate, and it is worse
          // than a cosmetic mess: the reviewer prompt lists its own section
          // headers ("FINDINGS: durable facts established during the
          // session"), so the parser read 8 of those back as proposals,
          // manufactured 24 phantom items, and rejected the review for
          // citing nothing - while the model's actual answer, further down
          // the same string, was well-formed. A defect that turns a good
          // review into a rejection is invisible in exactly the way a
          // rejection is supposed to be informative.
          const role = (e.message as { role?: string } | undefined)?.role;
          if (role !== undefined && role !== "assistant") return;
          const text = textOf(e.message);
          if (text.trim().length > 0) collected.push(text);
        }) ?? null;
    } catch {
      unsubscribe = null;
    }

    try {
      await sess.prompt(promptText);
    } finally {
      try {
        unsubscribe?.();
      } catch {
        /* already gone */
      }
    }

    // Strip the prompt if the model restated it. The role filter above stops
    // this session from producing it; a model that recites its instructions
    // produces it anyway, and the parser cannot tell the difference.
    if (collected.length > 0) return stripEchoedPrompt(collected.join("\n"), promptText);

    // Fallback: walk the nested session's own branch for the last assistant
    // message. Belt and braces - if the event shape changes, this still
    // yields the reply rather than an empty string that reads as "the model
    // had nothing to say".
    try {
      const entries = sess.sessionManager?.getBranch?.() ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { message?: { role?: string } };
        const message = entry?.message ?? (entry as unknown as { role?: string });
        if ((message as { role?: string })?.role !== "assistant") continue;
        const text = textOf(message);
        if (text.trim().length > 0) return stripEchoedPrompt(text, promptText);
      }
    } catch {
      /* fall through to empty */
    }
    return "";
  };

  const bwrapAvailable = (): boolean => {
    if (bwrapCache !== null) return bwrapCache;
    try {
      bwrapCache = spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
      bwrapCache = false;
    }
    return bwrapCache;
  };

  /**
   * The path Pi is writing this session's JSONL to.
   *
   * This is the artifact section 6.3 tells the retrospective reviewer to
   * reread and the one section 32 condition 1 measures coverage over, so it
   * is captured while the session manager is definitely alive. Everything
   * about it is optional at the type level because a nested or headless
   * session may have no file at all - and a null here has to stay null
   * rather than becoming a guessed path, since a guess would be indis-
   * tinguishable from a real one at review time.
   */
  const piSessionFile = (ctx: ExtensionContext | ExtensionCommandContext): string | null => {
    try {
      const manager = (ctx as unknown as {
        sessionManager?: { getSessionFile?: () => string | undefined };
      }).sessionManager;
      const file = manager?.getSessionFile?.();
      return typeof file === "string" && file.length > 0 ? file : null;
    } catch {
      return null;
    }
  };

  const currentModel = (ctx: ExtensionContext | ExtensionCommandContext): ModelConfiguration | null => {
    const model = (ctx as unknown as { model?: { provider?: string; id?: string } }).model;
    if (!model?.id) return null;
    let thinkingLevel: string | undefined;
    try {
      thinkingLevel = pi.getThinkingLevel() as unknown as string;
    } catch {
      thinkingLevel = undefined;
    }
    return {
      provider: model.provider ?? "unknown",
      model: model.id,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  };

  /** HEAD sha of the repo at a point in time, captured by the harness (never by
   * a model). Phase 4.2 external-evidence baseline anchor. Null when the tree is
   * not a git repo or HEAD cannot be read. */
  const gitHeadSha = (cwd: string): string | null => {
    try {
      const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
      if (r.status !== 0) return null;
      const sha = r.stdout.trim();
      return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  };

  /** Changed paths between `anchor` and the working tree, restricted to `roots`.
   * Empty array = nothing changed; null = could not diff (bad anchor / git
   * failure). Read-only; the external-evidence reader injects this. */
  const gitDiffSince = (cwd: string, anchor: string, roots: readonly string[]): string[] | null => {
    try {
      const r = spawnSync("git", ["diff", "--name-only", anchor, "--", ...roots], { cwd, encoding: "utf8" });
      if (r.status !== 0) return null;
      return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return null;
    }
  };

  const auditContext = (actor: AuditContext["actor"], model: ModelConfiguration | null): AuditContext => ({
    session: session?.id ?? "(no session)",
    actor,
    actorModel: model,
    scope: session?.scope ?? null,
  });

  /** Append one audit event. Every state-changing path in this file goes
   * through here; there is no second way to write the log, and no way at
   * all to amend it (AU1). */
  const audit = (
    actor: AuditContext["actor"],
    model: ModelConfiguration | null,
    eventType: AuditEventType,
    request: string,
    result: string,
    metadata: Record<string, unknown> = {},
  ): void => {
    if (store === null) return;
    store.appendAudit(makeAuditEvent(auditContext(actor, model), { eventType, request, result, metadata }));
  };

  /**
   * Phase 4.1 decision telemetry (evidence layer, not a control plane).
   *
   * Records the CLASS of an important decision and its outcome as a bounded,
   * tamper-evident `decision_telemetry` audit event. It is called strictly
   * AFTER a decision has been made: it never gates a verdict, never widens a
   * capability, and writes only through the same append-only `audit()` path,
   * so it opens no parallel store. `buildDecisionTelemetry` drops any decision
   * that is not one of the important classes (migration risk 1) and copies
   * only the contract fields (no reasoning traces), so a bad call site records
   * nothing rather than recording the wrong thing.
   */
  const recordDecision = (
    actor: AuditContext["actor"],
    model: ModelConfiguration | null,
    input: DecisionTelemetryInput,
  ): void => {
    const decision = buildDecisionTelemetry(input);
    if (decision === null) return;
    audit(actor, model, "decision_telemetry", `${decision.action}: ${decision.category}`, decision.outcome.status, {
      decision,
    });
  };

  const persistSession = (): void => {
    if (store === null || session === null) return;
    // Same reasoning as writeWorkstate: a delegate shares the project state
    // directory, and `session-state.json` is a single current value. A
    // delegate persisting itself there would replace the parent's resume
    // point with its own, which is the one file recovery depends on (R1).
    // The delegate's activity is still fully recorded - in the audit log,
    // which is append-only and therefore safe to share.
    if (delegateMarker !== null) return;
    // v0.2 (section 32): state is per-session, and the index is what makes a
    // session findable by id from outside the project. v0.1 wrote one
    // mutable `session-state.json` per project, so the second session in a
    // project overwrote the first and a reviewer asked to reread an older
    // one had nothing to open.
    store.writeSessionStateFor(session);
    store.upsertSessionIndex(sessionIndexEntry(session));
  };

  /** Write the recovery snapshot. Called at checkpoints, before compaction,
   * and at session close - the three moments spec section 16 names. */
  const writeWorkstate = (): void => {
    if (store === null || session === null) return;
    // A delegate's instance shares the project directory but is not the
    // session WORKSTATE describes. Writing it here would replace the
    // parent's recovery snapshot with a bounded subagent's view of the
    // world - precisely the state a human reaches for when things have gone
    // wrong (spec section 16).
    if (delegateMarker !== null) return;
    const tasks = store.readTasks();
    const current = session.currentTaskId
      ? (tasks.find((task) => task.id === session!.currentTaskId) ?? null)
      : null;
    const markdown = renderWorkstate({
      session,
      currentTask: current,
      decisions: store.readDecisions().records.filter((d) => d.session === session!.id),
      incidents: store.readIncidents().records.filter((i) => i.session === session!.id),
      recentAudit: store.readRecentAudit(AUDIT_TAIL),
    });
    // Two layers (section 32). WORKSTATE.md answers "what was happening most
    // recently" and is overwritten by design; the per-session copy answers
    // "what was happening in session X", which the first file structurally
    // cannot also answer.
    store.writeWorkstate(markdown);
    store.writeWorkstateFor(session.id, markdown);
  };

  /**
   * The tool catalog, with this package's own tools unioned in.
   *
   * `fromPi` is reported separately and is load bearing: if Pi's catalog is
   * unreadable, the union would be *only* the harness tools, and applying it
   * would deactivate every builtin. A capability rule that can silently
   * remove the model's ability to read a file is worse than no rule.
   */
  const catalogTools = (): { tools: { name: string; description?: string }[]; fromPi: boolean } => {
    let tools: { name: string; description?: string }[] = [];
    let fromPi = false;
    try {
      const all = pi.getAllTools() as unknown as { name: string; description?: string }[];
      if (Array.isArray(all) && all.length > 0) {
        tools = [...all];
        fromPi = true;
      }
    } catch {
      fromPi = false;
    }
    for (const name of HARNESS_TOOLS) {
      if (!tools.some((tool) => tool.name === name)) tools.push({ name, description: "harness tool" });
    }
    return { tools, fromPi };
  };

  /**
   * Recompute and apply the active tool set (sections 8, 9, 32).
   *
   * Computed from the catalog rather than filtered from the current active
   * set: filtering would preserve whatever another extension had already
   * switched on, so an extension that activates its own opaque tool at load
   * time would thereby grant itself the exception section 32 requires.
   */
  const applyActiveTools = (): void => {
    if (session === null) return;
    const { tools, fromPi } = catalogTools();
    if (!fromPi) return;
    try {
      const computed = defaultActiveTools(tools, capabilityExceptions);
      pi.setActiveTools(builtinBashBlocked(session.scope) ? withoutBuiltinBash(computed) : computed);
    } catch {
      // A Pi build that does not permit changing the active set still gets
      // the tool_call enforcement; only the ergonomics are lost.
    }
  };

  /** One-line audit-chain state for `/harness status` (section 32). */
  const describeAuditChain = (): string => {
    if (store === null) return "(no store)";
    const result = store.verifyAudit();
    const legacy =
      result.legacyPrefixLength > 0
        ? `, ${result.legacyPrefixLength} legacy-unverified record(s) before the anchor`
        : "";
    // The endpoint commitment is reported separately from the chain, and a
    // failure of it is stated in full rather than folded into one word.
    // "someone deleted the last two events" and "this record was edited" call
    // for different responses, and a single BROKEN would collapse them.
    const tip = result.tipConsistent === false ? ` -- ENDPOINT MISMATCH: ${result.tipReason}` : "";
    return result.ok
      ? `verified: ${result.verifiedCount} chained event(s)${legacy}${tip}`
      : `BROKEN at event ${result.brokenAt}: ${result.reason}${legacy}${tip}`;
  };

  const POSTURE_VALUES: Record<PostureField, readonly string[]> = {
    reasoning: REASONING_MODES,
    autonomy: AUTONOMY_MODES,
    approval: APPROVAL_POLICIES,
  };

  /**
   * Apply a posture change on behalf of `actor` (spec section 32).
   *
   * One implementation for both entry points - the `/harness-mode` command
   * and the coordinator's tool - because the difference between them is the
   * actor, and that is exactly the input the authorization turns on. Two
   * implementations would be two places for the direction rule to drift, and
   * the one that drifted would be the one a model can reach.
   *
   * Loosening (more autonomy, fewer confirmations) is an authority
   * expansion: `authorize()` returns needs-approval for every actor but the
   * user, even under `approvalPolicy: "none"`.
   */
  const applyPosture = async (
    actor: AuditContext["actor"],
    rawField: string,
    rawValue: string,
    ctx: ExtensionContext | ExtensionCommandContext | null,
    model: ModelConfiguration | null,
  ): Promise<{ ok: boolean; message: string }> => {
    const state = session;
    if (state === null) return { ok: false, message: "Harness session is not initialized." };
    if (!POSTURE_FIELDS.includes(rawField as PostureField)) {
      return { ok: false, message: `Unknown posture field "${rawField}". Expected one of: ${POSTURE_FIELDS.join(", ")}.` };
    }
    const field = rawField as PostureField;
    // Validated against the enum rather than cast into it. Without this an
    // unrecognized value was written straight into session state, and a
    // posture of "banana" is not a restriction - it is an approval policy
    // that matches no case and falls through.
    if (!POSTURE_VALUES[field].includes(rawValue)) {
      return { ok: false, message: `Invalid ${field} value "${rawValue}". Expected one of: ${POSTURE_VALUES[field].join(", ")}.` };
    }

    const current =
      field === "reasoning" ? state.reasoningMode : field === "autonomy" ? state.autonomy : state.approvalPolicy;
    const direction = classifyPostureChange(field, current, rawValue);
    const action = postureAction(direction);

    if (action !== null) {
      const decision = authorize({
        actor,
        action,
        target: `${field}=${rawValue}`,
        toolName: null,
        targetInScope: null,
        scope: state.scope,
        autonomy: state.autonomy,
        approvalPolicy: state.approvalPolicy,
        soft,
        userApproved: actor === "user",
      });
      if (decision.verdict === "deny") {
        audit(actor, model, "posture_change", `${field}=${rawValue} (${direction})`, `denied: ${decision.reason}`, {
          rule: decision.rule,
        });
        return { ok: false, message: `Refused: ${decision.reason} (${decision.rule}).` };
      }
      if (decision.verdict === "needs-approval") {
        const hasUi = ctx !== null && (ctx as ExtensionContext).hasUI === true;
        const approved =
          hasUi &&
          (await (ctx as ExtensionContext).ui.confirm(`Change ${field} to ${rawValue}?`, [
            `Current: ${current}`,
            `Requested by: ${actor}`,
            `This ${direction}s the harness posture.`,
            "",
            decision.reason,
          ].join("\n")));
        if (!approved) {
          audit(actor, model, "posture_change", `${field}=${rawValue} (${direction})`, "not approved", {
            rule: decision.rule,
          });
          return {
            ok: false,
            message: hasUi
              ? `Not approved: ${decision.reason} (${decision.rule}).`
              : `${decision.reason} (${decision.rule}). No confirmation UI is available; failing closed.`,
          };
        }
      }
    }

    if (field === "reasoning") session = { ...state, reasoningMode: rawValue as SessionState["reasoningMode"] };
    else if (field === "autonomy") session = { ...state, autonomy: rawValue as AutonomyMode };
    else session = { ...state, approvalPolicy: rawValue as ApprovalPolicy };
    persistSession();
    audit(actor, model, "posture_change", `${field}: ${current} -> ${rawValue}`, `applied (${direction})`);
    return { ok: true, message: `${field} set to ${rawValue} (${direction}).` };
  };

  /* ---------------------------------------------------------------- *
   * Session start (spec section 25)
   * ---------------------------------------------------------------- */

  pi.on("session_start", async (_event, ctx) => {
    const home = os.homedir();
    const inference = inferProjectRoot(ctx.cwd, home, {
      exists: (p) => fs.existsSync(p),
      isDirectory: (p) => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
    });

    paths = harnessPaths(home, inference.root);
    store = new HarnessStore(paths);
    store.init();
    config = store.readConfig();
    // Policy state is durable (spec section 17). Resolving the stored chain
    // broadest-first is what makes a tightened policy outlive the session
    // that set it - without this, every session silently reverted to the
    // built-in defaults and section 23's "learned preference" was
    // unreachable in principle.
    // Absent and corrupt are different facts. A layer that exists and cannot
    // be parsed had restrictions in it, and the one thing that cannot be
    // inferred is that they were permissive - so its level is carried into
    // the resolved policy and `authorize()` requires the user for anything
    // consequential until it is repaired.
    const policyState = store.readSoftPolicyState();
    const policyChain = policyState.records;
    soft = resolveSoftPolicy(policyChain, policyState.unresolved);
    identity = store.readIdentity();
    if (policyChain.length > 0) {
      audit("core", null, "policy_load", policyChain.map((r) => r.level).join(" -> "), "resolved");
    }
    if (policyState.unresolved.length > 0) {
      const quarantined: string[] = [];
      for (const level of policyState.unresolved as ("global" | "device" | "project")[]) {
        const moved = store.quarantineSoftPolicy(level, nowIso());
        if (moved !== null) quarantined.push(moved);
      }
      audit(
        "core",
        null,
        "policy_load",
        policyState.unresolved.join(", "),
        "unreadable; restrictions unknown, so consequential actions now require the user",
        { quarantined },
      );
      emit("Harness: policy could not be read", [
        `Unreadable policy layer(s): ${policyState.unresolved.join(", ")}`,
        "",
        "These files existed but did not parse. Whatever restrictions they carried are",
        "unknown, and the harness will not assume they were permissive: until they are",
        "repaired, anything mutating or consequential needs your approval.",
        ...(quarantined.length > 0
          ? ["", "Moved aside for inspection (not deleted):", ...quarantined.map((q) => `  ${q}`)]
          : []),
        "",
        "Repair with /harness-policy set <level> <field> <value>, or restore the file.",
      ]);
    }

    // Check for interrupted work *before* creating the new session, so the
    // report describes the previous one (spec section 25 startup).
    const previous = store.readLatestSessionState();
    const auditRead = store.readAudit();
    const report = reconcile(
      previous,
      {
        projectRootExists: fs.existsSync(inference.root),
        missingScopeRoots: (previous?.scope.allowedRoots ?? []).filter((root) => !fs.existsSync(root)),
        auditTruncated: auditRead.truncatedTail,
      },
      auditRead.records.slice(-AUDIT_TAIL),
    );

    // Is this instance a delegate's? If so it adopts the contract's scope,
    // actor and posture rather than inferring its own (SA3/SA5).
    //
    // The important case is the *unparseable* one. Ignoring a malformed
    // marker was the original behaviour and it is fail-open: an ignored
    // marker means the instance carries on as the coordinator, with a freshly
    // inferred full-project scope - strictly more authority than any contract
    // would have given it. So the mere presence of the variable is treated as
    // proof that this process is a delegate; only its *contents* are in
    // doubt. A marker that does not parse therefore yields the most
    // restricted delegate this harness can express, never the least.
    let markerPresent = false;
    let markerMalformed = false;
    try {
      const raw = process.env[DELEGATE_ENV];
      if (typeof raw === "string" && raw.length > 0) {
        markerPresent = true;
        const parsed = JSON.parse(raw) as DelegateMarker;
        if (
          typeof parsed?.contractId === "string" &&
          typeof parsed?.root === "string" &&
          Array.isArray(parsed.allowedRoots) &&
          parsed.allowedRoots.every((root) => typeof root === "string") &&
          (parsed.kind === "advisor" || parsed.kind === "subagent" || parsed.kind === "reviewer" || parsed.kind === "operator") &&
          AUTONOMY_MODES.includes(parsed.autonomy) &&
          APPROVAL_POLICIES.includes(parsed.approvalPolicy)
        ) {
          delegateMarker = parsed;
          actingAs = parsed.kind;
        } else {
          markerMalformed = true;
        }
      }
    } catch {
      markerMalformed = markerPresent;
      delegateMarker = null;
    }
    if (markerPresent && delegateMarker === null) {
      // Degrade to the floor, not to the ceiling: a read-only advisor scoped
      // to the working directory, interactive, approval for everything.
      delegateMarker = {
        contractId: "(unparseable)",
        kind: "advisor",
        allowedRoots: [ctx.cwd],
        root: ctx.cwd,
        parentSession: "(unknown)",
        autonomy: "interactive",
        approvalPolicy: "all-actions",
      };
      actingAs = "advisor";
      markerMalformed = true;
    }

    const inferredScope = createScope(inference.root, "user");
    const scope =
      delegateMarker === null
        ? inferredScope
        : {
            ...inferredScope,
            root: delegateMarker.root,
            allowedRoots: [...delegateMarker.allowedRoots],
            // A delegate never carries an automatic expansion: that is the
            // parent's budget, and spending it here would manufacture
            // authority the parent had already used or withheld.
            automaticExpansionEnabled: false,
            automaticExpansionBudget: 0,
            networkGrant: false,
            grantedBy: "core" as const,
          };

    // A delegate's posture is the contract's, clamped against the configured
    // default so neither source can loosen the other: `inherit*` returns the
    // stricter of the two in each direction. Without this the child booted at
    // the config default and could be looser than the parent that spawned it
    // (A3, SA5) - the scope axis was subset-checked, the posture axis was not.
    const autonomy =
      delegateMarker === null
        ? config.defaultAutonomy
        : inheritAutonomy(config.defaultAutonomy, delegateMarker.autonomy);
    const approvalPolicy =
      delegateMarker === null
        ? config.defaultApprovalPolicy
        : inheritApprovalPolicy(config.defaultApprovalPolicy, delegateMarker.approvalPolicy);

    session = createSession({
      projectRoot: inference.root,
      deviceId: previous?.deviceId ?? makeId("session"),
      // S1: start at the smallest reasonable scope, which is the project.
      scope,
      reasoningMode: config.defaultReasoningMode,
      autonomy,
      approvalPolicy,
      coordinator: currentModel(ctx) ?? config.preferredCoordinator,
      // Where Pi is writing this session's JSONL. Recorded at start rather
      // than at close because it is what the retrospective reviewer must
      // reread (sections 6.3, 32 condition 1), and by shutdown the manager
      // may be gone. v0.2 left this null and the reviewer measured coverage
      // over the harness audit log instead - the wrong artifact entirely.
      sessionFile: piSessionFile(ctx),
    });
    persistSession();

    if (markerMalformed) {
      audit(
        "core",
        null,
        "delegation",
        "delegate contract marker",
        "unparseable; degraded to a read-only advisor scoped to the working directory",
      );
    }

    // Section 32: the legacy prefix is *declared*, not assumed.
    //
    // v0.1 records were written with no hash, so nothing about them can be
    // verified after the fact - and back-filling hashes would convert "these
    // were not protected" into a false claim that they were. Instead the
    // first chained event anchors to the digest of the exact legacy prefix,
    // and this event states in the log where that boundary is. A reader who
    // only ever sees the audit file can then tell which records carry
    // integrity evidence and which merely exist.
    {
      const chain = store.verifyAudit();
      if (chain.legacyPrefixLength > 0 && chain.verifiedCount === 0) {
        audit(
          "core",
          null,
          "audit_anchor",
          `${chain.legacyPrefixLength} legacy record(s)`,
          "records before this line predate hash chaining and are unverifiable; the chain starts here",
          { legacyPrefixLength: chain.legacyPrefixLength, legacyPrefixDigest: chain.legacyPrefixDigest },
        );
      }
    }

    audit("core", null, "session_start", `cwd=${ctx.cwd}`, `project=${inference.root} (${inference.reason})`, {
      marker: inference.marker,
    });

    // Every harness tool is registered inside `if (TypeBoxType !== null)`,
    // because a tool needs a parameter schema. So a missing `typebox` does
    // not degrade the harness a little - it registers *no* tools at all,
    // while the tool_call gate keeps blocking the builtin shell. The model
    // is then left with no shell and no scope tool and nothing said why.
    //
    // Found by testing the isolated artifact from a genuinely clean extract:
    // six tests failed there and passed in the repository, and the only
    // difference was an uninstalled dependency. Silent is the problem; the
    // fix is to say so, in the log and on screen.
    if (TypeBoxType === null) {
      const lines = [
        "typebox could not be imported, so NO harness tools were registered.",
        "The builtin shell is still blocked and pi_harness_bash does not exist,",
        "which leaves this session with no shell at all.",
        "Run `npm install` in the harness package to fix it.",
      ];
      audit("core", null, "session_start", "typebox unavailable", lines[0]);
      emit("Harness: degraded", lines);
    }

    // Sections 8, 9 and 32: the active tool set is *computed* from the
    // catalog, not inherited from whatever loaded first.
    //
    // Filtering the current active set would preserve whatever another
    // extension had already switched on - so an extension that activates its
    // own opaque tool at load time would thereby grant itself the exception
    // section 32 exists to require. Computing from the catalog instead means
    // the default answer for a tool this harness cannot reason about is "not
    // active", and the user has to say otherwise.
    //
    // Still ergonomics rather than enforcement: the tool_call handler checks
    // confinement independently, so another extension restoring the tool set
    // does not reopen the path.
    {
      const { tools, fromPi } = catalogTools();
      applyActiveTools();
      if (fromPi) {
        const withheld = buildCatalog(tools, capabilityExceptions).filter((entry) => !entry.active);
        if (withheld.length > 0) {
          // Audited, and named, rather than silently absent. A capability the
          // user believes they have and does not is a worse failure than one
          // they were told about.
          audit(
            "core",
            null,
            "capability_block",
            withheld.map((entry) => entry.name).join(", "),
            "catalogued but not active; unconfined tools need a per-session user exception",
          );
          emit("Harness: capabilities withheld", [
            ...withheld.map((entry) => `${entry.name} [${entry.confinement}]`),
            "",
            "These are catalogued but not in the model's active set (section 32).",
            "Grant one for this session with: /harness capability grant <tool> <reason>",
          ]);
        }
      }
    }

    // Section 6.4: load only the active model's instruction layer.
    const model = session.coordinator;
    if (model && paths) {
      const instructions = store.readModelInstructions(modelAgentsFile(paths, model));
      if (instructions !== null) {
        audit("core", null, "config_change", `load model guidance for ${model.model}`, `${instructions.length} bytes`);
      }
    }

    if (previous !== null && (report.conflicts.length > 0 || report.uncertain.length > 0)) {
      audit("core", null, "recovery", "reconcile previous session", report.canContinue ? "clean" : "needs attention", {
        conflicts: report.conflicts,
        uncertain: report.uncertain,
      });
      emit("Harness: interrupted work detected", [
        `Previous session: ${previous.id}`,
        `Resume point: ${report.resumeFrom ?? "(nothing verified)"}`,
        ...report.conflicts.map((c) => `CONFLICT: ${c}`),
        ...report.uncertain.map((u) => `UNCERTAIN: ${u}`),
        "",
        "Verify against the actual environment before continuing. Run /harness recover for detail.",
      ]);
    }
  });

  /* ---------------------------------------------------------------- *
   * Baseline identity and standing goals in the prompt
   * ---------------------------------------------------------------- */

  /**
   * Append identity and goals to the system prompt each turn.
   *
   * This is the mechanism behind "Pi presents the same personality and
   * baseline behavior across sessions and models" (section 2.1). Storing
   * identity without injecting it would make it a file nobody reads.
   *
   * Appended rather than substituted, and appended per turn rather than
   * mutated once, so it survives a model switch and a compaction without
   * either being a special case. Renders nothing when both are empty.
   */
  pi.on("before_agent_start", async (event) => {
    if (session === null) return;
    const blocks: string[] = [];
    if (identity !== null) {
      const block = renderIdentityBlock(identity);
      if (block.length > 0) blocks.push(block);
    }
    if (store !== null) {
      const goalBlock = renderGoalBlock(
        store.readGoals(),
        store.readProjectLinks(),
        session.projectRoot,
      );
      if (goalBlock.length > 0) blocks.push(goalBlock);
    }
    if (blocks.length === 0) return;
    const base = (event as unknown as { systemPrompt?: string }).systemPrompt ?? "";
    return { systemPrompt: `${base}\n\n${blocks.join("\n\n")}` };
  });

  /* ---------------------------------------------------------------- *
   * Authorization on every tool call
   * ---------------------------------------------------------------- */

  /**
   * Map a Pi tool name onto a harness action.
   *
   * Unrecognized tools are treated as mutating, not as reads. That is the
   * conservative direction: an unknown tool that only reads gets an approval
   * prompt it did not strictly need, whereas an unknown tool that writes
   * would otherwise skip the scope check, the approval gate, and the audit
   * entry all at once.
   */
  const toolAction = (toolName: string): Action => {
    if (SHELL_TOOLS.has(toolName)) return "shell";
    if (READ_TOOLS.has(toolName)) return "read";
    return "mutate";
  };

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (session === null) return;

    const input = event.input as Record<string, unknown>;
    const rawPath = extractPath(input);
    const action = toolAction(event.toolName);

    // Section 9, enforced independently of the active tool set.
    if (event.toolName === "bash" && builtinBashBlocked(session.scope)) {
      audit(actingAs, currentModel(ctx), "shell_exec", "builtin bash", "blocked");
      return {
        block: true,
        reason:
          "[harness] The unrestricted builtin bash is blocked (ARCHITECTURE.md section 9). Use pi_harness_bash, which runs under an OS-level sandbox.",
      };
    }

    // Section 32: an opaque tool from another extension cannot honestly be
    // called confined. The harness does not know what its arguments mean, so
    // it cannot resolve a target, so it cannot scope-check one. The rule is
    // therefore not "check it harder" but "the user decides, per session,
    // with the word unconfined in front of them".
    const confinement = classifyTool(event.toolName);
    if (confinement === "unconfined" && !capabilityExceptions.has(event.toolName)) {
      const label = `${event.toolName} (${describeConfinement(event.toolName, capabilityExceptions)})`;
      // A delegate may not buy itself authority the parent did not delegate,
      // and an approval prompt is a purchase (SA5). It is refused outright
      // rather than escalated.
      if (delegateMarker !== null) {
        audit(actingAs, currentModel(ctx), "capability_block", label, "denied: a delegate cannot request an exception");
        return {
          block: true,
          reason: `[harness] ${event.toolName} is an unconfined tool and a delegate cannot be granted a capability exception (SA5 / section 32).`,
        };
      }
      if (!ctx.hasUI) {
        audit(actingAs, currentModel(ctx), "capability_block", label, "blocked (no UI)");
        return {
          block: true,
          reason: `[harness] ${event.toolName} is not a scope-aware or harness tool, so the harness cannot confine it (section 32). No confirmation UI is available; failing closed.`,
        };
      }
      const approved = await ctx.ui.confirm(
        `Activate ${event.toolName} for this session?`,
        [
          "This tool is UNCONFINED: it comes from outside the harness, so the",
          "harness cannot resolve its target or check it against the scope.",
          "It is not sandboxed, and the harness cannot make it so.",
          "",
          `Scope in force: ${describeScope(session.scope)}`,
          "",
          "Granting applies to this session only and is recorded in the audit log.",
        ].join("\n"),
      );
      const outcome = approved
        ? grantException(event.toolName, "user", "granted at the tool-call prompt", () => new Date())
        : ({ ok: false, reason: "declined at the prompt", rule: "section 32" } as const);
      if (!outcome.ok) {
        audit(actingAs, currentModel(ctx), "capability_block", label, `denied: ${outcome.reason}`);
        return { block: true, reason: `[harness] ${outcome.reason} (${outcome.rule}).` };
      }
      capabilityExceptions.set(event.toolName, outcome.exception);
      audit("user", null, "capability_grant", label, "granted for this session only");
    }

    const check = rawPath === null ? null : checkPath(rawPath, session.scope, ctx.cwd, pathOps);

    const decision = authorize({
      // A delegate's instance authorizes as its own kind, so the capability
      // matrix that applies is the subagent's or advisor's, not the
      // coordinator's (SA3).
      actor: actingAs,
      action,
      target: rawPath ?? event.toolName,
      toolName: event.toolName,
      targetInScope: check === null ? null : check.allowed,
      scope: session.scope,
      autonomy: session.autonomy,
      approvalPolicy: session.approvalPolicy,
      soft,
      userApproved: false,
    });

    if (decision.verdict === "allow") {
      // Reads are not audited individually: the volume would drown the
      // signal, and a read is not the risk this gate exists for. The scope
      // check above still ran.
      if (action !== "read") {
        audit(actingAs, currentModel(ctx), "tool_call", `${event.toolName} ${rawPath ?? ""}`.trim(), "allowed", {
          rule: decision.rule,
        });
      }
      return;
    }

    if (decision.verdict === "needs-approval") {
      if (!ctx.hasUI) {
        audit(actingAs, currentModel(ctx), "authorization", `${event.toolName} ${rawPath ?? ""}`.trim(), "blocked (no UI)");
        return {
          block: true,
          reason: `[harness] ${decision.reason} (${decision.rule}). No confirmation UI is available; failing closed.`,
        };
      }
      const approved = await ctx.ui.confirm(
        `Allow ${event.toolName}?`,
        [
          `Action: ${action}`,
          rawPath !== null ? `Target: ${check?.canonical ?? rawPath}` : null,
          `Scope: ${describeScope(session.scope)}`,
          `Rule: ${decision.rule}`,
          "",
          decision.reason,
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      );
      audit(
        "coordinator",
        currentModel(ctx),
        "authorization",
        `${event.toolName} ${rawPath ?? ""}`.trim(),
        approved ? "approved by user" : "denied by user",
        { rule: decision.rule },
      );
      if (approved) return;
      return { block: true, reason: `[harness] Denied at the approval prompt (${decision.rule}).` };
    }

    audit(actingAs, currentModel(ctx), "authorization", `${event.toolName} ${rawPath ?? ""}`.trim(), `denied: ${decision.reason}`, {
      rule: decision.rule,
    });
    return { block: true, reason: `[harness] ${decision.reason} (${decision.rule}).` };
  });

  /* ---------------------------------------------------------------- *
   * Model switches, compaction, shutdown
   * ---------------------------------------------------------------- */

  pi.on("model_select", async (event, ctx) => {
    if (session === null) return;
    const outgoing = session.coordinator;
    const incoming = currentModel(ctx) ?? {
      provider: "unknown",
      model: String((event as unknown as { model?: { id?: string } }).model?.id ?? "unknown"),
    };
    // MO3/S5: authority is untouched by the switch; switchCoordinator cannot
    // express a change to it.
    session = switchCoordinator(session, incoming);
    persistSession();
    audit(
      "user",
      null,
      "model_switch",
      `${outgoing ? `${outgoing.provider}/${outgoing.model}` : "(none)"} -> ${incoming.provider}/${incoming.model}`,
      "authority unchanged",
      { task: session.currentTaskId, scope: describeScope(session.scope) },
    );
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    if (session === null) return;
    const model = currentModel(ctx);
    audit("user", null, "thinking_level_change", model?.thinkingLevel ?? "(unknown)", "recorded");
  });

  // R5: nothing important may exist only in the conversation when it is
  // summarized away.
  pi.on("session_before_compact", async () => {
    if (session === null) return;
    session = checkpoint(session, session.lastVerifiedState);
    persistSession();
    writeWorkstate();
    audit("core", null, "checkpoint", "before compaction", "state and WORKSTATE flushed");
  });

  pi.on("session_shutdown", async () => {
    if (session === null || store === null) return;

    // A delegate ending is not the parent's session ending. It records that
    // it finished and stops there: it must not overwrite the parent's
    // session state, and it must not queue a retrospective review of itself
    // as though it were a session someone had.
    if (delegateMarker !== null) {
      audit(actingAs, null, "delegation", delegateMarker.contractId, "delegate session ended");
      return;
    }

    session = checkpoint(session, session.lastVerifiedState);
    session = closeSession(session);
    persistSession();
    writeWorkstate();

    // Queue the retrospective review rather than running it: an interactive
    // close must not wait for a reviewer (spec section 25).
    const item: ReviewQueueItem = {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      id: makeId("review"),
      sessionId: session.id,
      sessionFile: session.sessionFile,
      project: session.projectRoot,
      status: "pending",
      createdAt: nowIso(),
      reviewerModel: config.preferredReviewer,
      error: null,
    };
    store.writeReviewQueue([...store.readReviewQueue(), item]);
    audit("core", null, "session_close", session.id, "closed; retrospective review queued");
  });

  /* ---------------------------------------------------------------- *
   * Tools
   * ---------------------------------------------------------------- */

  if (TypeBoxType !== null) {
    const T = TypeBoxType as unknown as {
      Object: (props: Record<string, unknown>) => unknown;
      String: (opts?: Record<string, unknown>) => unknown;
      Optional: (schema: unknown) => unknown;
    };

    // Section 9: the only permitted shell path.
    pi.registerTool({
      name: "pi_harness_bash",
      label: "Sandboxed Shell",
      description:
        "Run a shell command inside an OS-level sandbox (bubblewrap). The scope root is the only writable path, network is unshared unless the scope grants it, and the command is refused outright if the sandbox is unavailable.",
      promptSnippet: "pi_harness_bash(command) - run a command in the sandboxed shell",
      parameters: T.Object({
        command: T.String({ description: "The shell command to run." }),
        record: T.Optional(T.Boolean({
          description:
            "Record this run as a command-execution decision (for validation/build/test checks) so its real exit code can be evaluated. Records an already-authorized action; grants no new authority.",
        })),
        expect_success: T.Optional(T.Boolean({
          description:
            "When recording, the outcome you are asserting: true = you expect this command to succeed (default). The real exit code is compared against this claim.",
        })),
      }) as never,
      execute: async (_id, params, ctx) => {
        const { command, record, expect_success } = params as { command: string; record?: boolean; expect_success?: boolean };
        if (session === null) {
          return { content: [{ type: "text", text: "Harness session is not initialized." }] } as never;
        }
        const outcome = planSandbox(command, session.scope, config, session.scope.root, {
          bwrapAvailable,
          exists: (p) => fs.existsSync(p),
        });
        if (!outcome.ok) {
          audit(actingAs, null, "shell_exec", command, `refused: ${outcome.reason}`);
          return { content: [{ type: "text", text: `Refused: ${outcome.reason}` }] } as never;
        }

        // A command-execution DECISION, recorded only when the coordinator opts
        // in (a validation/build/test run). This records an already-authorized
        // action through the 4.1 telemetry allowlist - no new capability, actor,
        // or policy. The CLAIM is the coordinator's asserted outcome
        // (expect_success), recorded BEFORE the exit code is known, so the
        // exit_code external witness below is an independent check, not a
        // tautology. When `record` is absent this tool behaves exactly as before
        // (no telemetry, decisionId null).
        const decisionId = record === true ? makeId("decision") : null;
        if (decisionId !== null) {
          const claimStatus = expect_success === false ? "failed" : "completed";
          recordDecision("coordinator", currentModel(ctx), {
            decisionId,
            action: "command_run",
            category: "command_execution",
            rule: "coordinator_validation",
            confidence: null,
            context: { taskClass: null, estimatedComplexity: null, availableCapabilities: [] },
            outcome: { status: claimStatus, retries: 0, userOverride: false },
          });
        }

        // Run id minted by the harness execution layer (never from params), so
        // the exit code is an execution record the model cannot forge (§A). When
        // the run is a recorded decision, decisionId closes the run-id join so
        // the exit_code reader produces a real externally_observed verdict.
        const runId = makeId("run");
        const result = await pi.exec("/bin/sh", ["-c", outcome.command], { cwd: session.scope.root });
        audit(actingAs, null, "shell_exec", command, `exit ${result.exitCode ?? 0}`, {
          mounts: outcome.mounts,
          runId,
          exitCode: result.exitCode ?? 0,
          decisionId,
        });
        const text = [result.stdout ?? "", result.stderr ?? ""].filter((s) => s.length > 0).join("\n");
        return { content: [{ type: "text", text: text.length > 0 ? text : "(no output)" }] } as never;
      },
    });

    // Section 3: a model may request scope; Core decides.
    pi.registerTool({
      name: "harness_request_scope",
      label: "Request Scope",
      description:
        "Request that the working scope be expanded to a path. One automatic expansion to the next boundary is available per scope; anything wider requires user approval.",
      promptSnippet: "harness_request_scope(path) - ask Pi Core to widen the working scope",
      parameters: T.Object({
        path: T.String({ description: "Absolute path to bring into scope." }),
        reason: T.Optional(T.String({ description: "Why the wider scope is needed." })),
      }) as never,
      execute: async (_id, params, ctx) => {
        const { path: target, reason } = params as { path: string; reason?: string };
        if (session === null) {
          return { content: [{ type: "text", text: "Harness session is not initialized." }] } as never;
        }
        const outcome = requestExpansion(session.scope, target, ctx.cwd, pathOps, os.homedir());
        if (outcome.decision === "auto-granted" && outcome.scope) {
          session = { ...session, scope: outcome.scope };
          persistSession();
          audit(actingAs, null, "scope_expand_auto", `${target} (${reason ?? "no reason given"})`, outcome.reason);
          return { content: [{ type: "text", text: `Granted: ${outcome.reason}` }] } as never;
        }
        audit(
          "coordinator",
          null,
          outcome.decision === "refused" ? "scope_expand_denied" : "authorization",
          `${target} (${reason ?? "no reason given"})`,
          outcome.reason,
        );
        return {
          content: [
            {
              type: "text",
              text: `Not granted: ${outcome.reason}. Ask the user to run: /harness scope approve ${target}`,
            },
          ],
        } as never;
      },
    });

    pi.registerTool({
      name: "harness_memory_search",
      label: "Search Memory",
      description:
        "Search durable harness memory. Results carry their epistemic type (fact, assumption, opinion) and their source references.",
      promptSnippet: "harness_memory_search(query) - search durable memory",
      parameters: T.Object({ query: T.String({ description: "Search text." }) }) as never,
      execute: async (_id, params) => {
        const { query } = params as { query: string };
        if (store === null) {
          return { content: [{ type: "text", text: "Harness store is not initialized." }] } as never;
        }
        // Section 32: default retrieval is global memory plus this project's.
        // A lesson learned in one repository ("the build is broken until you
        // run codegen") is true of exactly that repository, and returning it
        // elsewhere is not a ranking problem but a scope one.
        const hits = searchMemory(store.readMemory().records, query, 20, session?.projectRoot ?? null);
        return {
          content: [
            {
              type: "text",
              text: hits.length > 0 ? hits.map(formatMemoryEntry).join("\n") : "No matching memory.",
            },
          ],
        } as never;
      },
    });

    pi.registerTool({
      name: "harness_note",
      label: "Session Note",
      description:
        "Record a session-level finding, assumption, unresolved question, relevant file, or next action. These are provisional and do not become durable memory.",
      promptSnippet: "harness_note(kind, text) - record a provisional session note",
      parameters: T.Object({
        kind: T.String({
          description: "One of: finding, assumption, unresolved, relevant-file, next-action.",
        }),
        text: T.String({ description: "The note." }),
      }) as never,
      execute: async (_id, params) => {
        const { kind, text } = params as { kind: string; text: string };
        const valid = ["finding", "assumption", "unresolved", "relevant-file", "next-action"];
        if (session === null || !valid.includes(kind)) {
          return {
            content: [{ type: "text", text: `kind must be one of: ${valid.join(", ")}` }],
          } as never;
        }
        session = addNote(session, kind as Parameters<typeof addNote>[1], text);
        persistSession();
        return { content: [{ type: "text", text: `Recorded ${kind}.` }] } as never;
      },
    });

    // Section 8: capability search. TO1 says capability existence does not
    // imply prompt exposure - this tool is how a model discovers a
    // capability that is deliberately not in its context, without every
    // specialized tool being loaded up front (TO2).
    pi.registerTool({
      name: "harness_set_posture",
      label: "Set Posture",
      description:
        "Change the reasoning mode, or tighten autonomy or approval policy. Reasoning style is free. Loosening autonomy or approval is an authority expansion and requires the user's approval.",
      promptSnippet: "harness_set_posture(field, value) - change reasoning style, or tighten your own posture",
      parameters: T.Object({
        field: T.String({ description: "One of: reasoning, autonomy, approval." }),
        value: T.String({ description: "The new value for that field." }),
      }) as never,
      execute: async (_id, params, ctx) => {
        const { field, value } = params as { field: string; value: string };
        const outcome = await applyPosture(actingAs, field, value, ctx as ExtensionContext, currentModel(ctx));
        return { content: [{ type: "text", text: outcome.message }] } as never;
      },
    });
    pi.registerTool({
      name: "harness_find_capability",
      label: "Find Capability",
      description:
        "Search the capability catalog for a tool that can do something, including tools not currently loaded into context. Finding a capability does not authorize it.",
      promptSnippet: "harness_find_capability(need) - search for a tool that can do something",
      parameters: T.Object({
        need: T.String({ description: "What you need to be able to do." }),
      }) as never,
      execute: async (_id, params) => {
        const { need } = params as { need: string };
        const needle = need.toLowerCase().trim();
        let catalog: { name: string; description?: string }[] = [];
        try {
          catalog = pi.getAllTools() as unknown as { name: string; description?: string }[];
        } catch {
          catalog = [];
        }
        const active = new Set(pi.getActiveTools());
        const hits = catalog.filter(
          (tool) =>
            tool.name.toLowerCase().includes(needle) ||
            (tool.description ?? "").toLowerCase().includes(needle),
        );
        return {
          content: [
            {
              type: "text",
              text:
                hits.length > 0
                  ? [
                      ...hits.map(
                        (tool) =>
                          `${tool.name}${active.has(tool.name) ? " (loaded)" : " (available, not loaded)"}: ${tool.description ?? ""}`,
                      ),
                      "",
                      "Finding a capability is not authorization to use it. An unloaded tool must be enabled by the user.",
                    ].join("\n")
                  : `No capability matches "${need}". Propose a new tool rather than working around the gap; tool creation is a separate authority transition and is not automatic.`,
            },
          ],
        } as never;
      },
    });

    // Sections 6.2 and 7. Read-only by construction: buildContract caps
    // capabilities by delegate kind, and MVP kinds carry no write tools.
    if (createAgentSession !== null) {
      pi.registerTool({
        name: "harness_delegate",
        label: "Delegate",
        description:
          "Consult a read-only advisor, run a bounded read-only subagent, or run a bounded operator that may execute commands inside an OS-level sandbox scoped to its own root - all under an explicit delegation contract. The result is evidence and recommendations; nothing is applied. Consult an advisor ONLY when (a) you are blocked on a design or architecture decision after your own analysis, (b) you are about to take a consequential, irreversible step and are unsure, or (c) the user asks. Do NOT consult an advisor for routine implementation, orientation, or anything you can verify yourself - an advisor is a cloud model and each consult costs quota and latency.",
        promptSnippet: "harness_delegate(kind, objective) - consult an advisor (ONLY when blocked on a design decision after your own analysis, about to take a consequential irreversible step and unsure, or the user asks - never for routine work), or run a bounded subagent/operator",
        parameters: T.Object({
          kind: T.String({ description: 'One of "advisor", "subagent", or "operator" (operator may run sandboxed, scope-bounded commands). Use "advisor" ONLY when blocked on a design/architecture decision after your own analysis, about to take a consequential irreversible step and unsure, or the user asks - never for routine implementation or orientation.' }),
          objective: T.String({ description: "What the delegate should determine." }),
          scopePath: T.Optional(T.String({ description: "Subdirectory of the current scope." })),
          context: T.Optional(T.String({ description: "Minimum context the delegate needs." })),
          resumesContract: T.Optional(T.String({ description: "Blocked contract this is an approved restart of." })),
          approvedReadRoot: T.Optional(T.String({ description: "Exact additional read root approved by the user." })),
          approvalDecisionId: T.Optional(T.String({ description: "User decision authorizing that exact root." })),
        }) as never,
        execute: async (_id, params, ctx) => {
          const p = params as {
            kind: string;
            objective: string;
            scopePath?: string;
            context?: string;
            resumesContract?: string;
            approvedReadRoot?: string;
            approvalDecisionId?: string;
          };
          if (session === null) {
            return { content: [{ type: "text", text: "Harness session is not initialized." }] } as never;
          }
          if (p.kind !== "advisor" && p.kind !== "subagent" && p.kind !== "operator") {
            return { content: [{ type: "text", text: 'kind must be "advisor", "subagent", or "operator".' }] } as never;
          }
          const parent: ParentAuthority = {
            session: session.id,
            // `actingAs`, not a hardcoded "coordinator": a delegate may itself
            // delegate, and a contract chain that always claims coordinator
            // parentage is a provenance lie at exactly the point SA1 exists
            // to make legible.
            actor: actingAs,
            scope: session.scope,
            autonomy: session.autonomy,
            approvalPolicy: session.approvalPolicy,
            cwd: ctx.cwd,
          };
          const built = buildContract(
            parent,
            {
              kind: p.kind as DelegateKind,
              objective: p.objective,
              scopeTarget: p.scopePath,
              // The tools the child will actually hold. These used to be Pi's
              // builtin names, which stopped being true when the child moved
              // to inline scoped tools - leaving the contract, and the audit
              // line recording it, describing a surface that did not exist.
              // An operator additionally requests scoped_exec; buildContract
              // caps it against KIND_CAPABILITIES[kind], so a kind that may not
              // hold it has it dropped rather than granted.
              requestedCapabilities: delegateToolNames(p.kind as DelegateKind),
              // The child asks for exactly the parent's posture, which
              // `buildContract` then intersects - so it is equal to the
              // parent, never looser (A3). Leaving these unset took
              // `buildContract`'s deliberately strict defaults of
              // interactive/all-actions, which sounds safer and is not: a
              // read-only delegate that needs an approval prompt for every
              // read, inside a nested session that has no UI to prompt with,
              // is a delegate that cannot read. A boundary nobody can work
              // through gets removed rather than respected.
              requestedAutonomy: session.autonomy,
              requestedApprovalPolicy: session.approvalPolicy,
              contextPackage: p.context ? [p.context] : [],
              expectedOutput: "A handoff in the required section format.",
            },
            pathOps,
          );
          if (!built.ok) {
            audit("coordinator", currentModel(ctx), "delegation", p.objective, `refused: ${built.reason}`);
            return { content: [{ type: "text", text: `Refused: ${built.reason} (${built.rule})` }] } as never;
          }

          const restartFields = [p.resumesContract, p.approvedReadRoot, p.approvalDecisionId];
          const isApprovedRestart = restartFields.every((value) => typeof value === "string" && value.length > 0);
          if (restartFields.some(Boolean) && !isApprovedRestart) {
            return { content: [{ type: "text", text:
              "Refused: resumesContract, approvedReadRoot, and approvalDecisionId must be supplied together." }] } as never;
          }
          if (isApprovedRestart) {
            const scopeCheck = checkPath(p.approvedReadRoot!, session.scope, ctx.cwd, pathOps);
            const jobs = latestDelegationJobs(store!.readDelegations().records);
            const blocked = jobs.find((job) => job.contractId === p.resumesContract && job.status === "blocked");
            const sameBaseContract = blocked !== undefined &&
              blocked.kind === p.kind &&
              blocked.objective === p.objective &&
              blocked.autonomy === built.contract.autonomy &&
              blocked.approvalPolicy === built.contract.approvalPolicy &&
              JSON.stringify(blocked.capabilities.slice().sort()) ===
                JSON.stringify(built.contract.allowedCapabilities.slice().sort()) &&
              JSON.stringify(blocked.readRoots.slice().sort()) ===
                JSON.stringify(built.contract.scope.allowedRoots.slice().sort());
            const approval = scopeCheck.canonical === null ? null : matchingUserApproval(
              store!.readDecisions().records,
              p.approvalDecisionId!,
              p.resumesContract!,
              scopeCheck.canonical,
            );
            const alreadyUsed = jobs.some((job) => job.approvalDecisionId === p.approvalDecisionId);
            const requestedRootMatches = blocked !== undefined && blocked.pendingReadRoot === scopeCheck.canonical;
            if (!scopeCheck.allowed || blocked === undefined || !sameBaseContract ||
              !requestedRootMatches || approval === null || alreadyUsed) {
              const reasons = [
                !scopeCheck.allowed ? `root is outside the parent's scope (${scopeCheck.reason})` : "",
                blocked === undefined ? "the referenced contract is not durably blocked" : "",
                blocked !== undefined && !sameBaseContract ?
                  "the replacement does not preserve the blocked job's objective and base authority" : "",
                blocked !== undefined && !requestedRootMatches ? "the approved root is not the root that child requested" : "",
                approval === null ? "no exact user-authored approval matches contract and root" : "",
                alreadyUsed ? "that approval decision was already consumed" : "",
              ].filter(Boolean);
              audit("coordinator", currentModel(ctx), "delegation", p.resumesContract!,
                `refused approved restart: ${reasons.join("; ")}`);
              return { content: [{ type: "text", text: `Refused approved restart: ${reasons.join("; ")}.` }] } as never;
            }
            // Only the approved read root changes. Objective, base roots,
            // posture, and tools are bound to the blocked job above; without
            // that check a narrow path approval could be laundered into
            // authority for an unrelated delegated task.
            built.contract.scope = {
              ...built.contract.scope,
              allowedRoots: [...new Set([...built.contract.scope.allowedRoots, scopeCheck.canonical!])],
            };
          }

          audit("coordinator", currentModel(ctx), "delegation", `${p.kind}: ${p.objective}`, "contract issued", {
            contract: built.contract.id,
            scope: describeScope(built.contract.scope),
            capabilities: built.contract.allowedCapabilities,
            dropped: built.droppedCapabilities,
            resumesContract: p.resumesContract ?? null,
            approvalDecisionId: p.approvalDecisionId ?? null,
          });
          let job = makeDelegationJob(built.contract, {
            status: "running",
            detail: isApprovedRestart ? "approved restart constructed" : "child construction started",
            resumesContract: p.resumesContract ?? null,
            approvalDecisionId: p.approvalDecisionId ?? null,
            // Baseline anchor for the Phase 4.2 file_diff external-evidence
            // reader, captured by the harness at delegation start.
            repoAnchor: gitHeadSha(paths?.projectRoot ?? process.cwd()),
          });
          store!.appendDelegation(job);

          // Pi reloads this package's extensions for the nested session, so
          // a second instance of this file comes up inside the delegate.
          // The marker is how that instance learns to adopt the contract's
          // scope and authorize as a subagent instead of minting itself a
          // fresh full-project scope as a coordinator (SA3/SA5). It is set
          // for exactly as long as the nested session is being constructed.
          // The child is built, not inherited.
          //
          // Phase 2.1 refused delegation because a nested session came up
          // with no harness enforcing the contract. Measuring pi 0.84.1
          // properly showed why: extensions ARE loaded into a nested session
          // - the harness's own among them - but `session_start` is never
          // dispatched, so every handler sits registered and inert. Asking
          // for an extension inside the child was always asking Pi to run our
          // enforcement for us.
          //
          // So the enforcement boundary is the tools themselves. The child
          // gets an isolated ResourceLoader (no extensions, no skills, no
          // AGENTS.md), an exact allowlist, and three inline read-only tools
          // written here. It cannot reach the filesystem except through code
          // that checks the scope, because it has nothing else to reach with.
          if (createExtensionRuntime === null) {
            audit("coordinator", currentModel(ctx), "delegation", built.contract.id,
              "refused: this Pi build exposes no createExtensionRuntime, so the child cannot be isolated");
            job = transitionDelegationJob(job, "attestation-refused", "createExtensionRuntime unavailable");
            store!.appendDelegation(job);
            return { content: [{ type: "text", text:
              "Refused: this Pi build does not expose createExtensionRuntime, so the delegate's ambient resources cannot be stripped. Nothing was delegated." }] } as never;
          }

          const runtimeContract: DelegateRuntimeContract = {
            contractId: built.contract.id,
            readRoots: built.contract.scope.allowedRoots,
            allowedTools: built.contract.allowedCapabilities.includes("scoped_exec")
              ? delegateToolNames("operator")
              : DELEGATE_TOOL_NAMES.slice(),
            maxBytes: 64_000,
          };
          const runtimeLog: DelegateRuntimeLog = {
            calls: [],
            pendingRequests: [],
            attestationChecks: 0,
            runtimeViolations: [],
          };

          // The operator's execution path. Built here, in the extension, closed
          // over the OPERATOR's own narrowed scope (built.contract.scope, a
          // parent-subset via narrowScope) - never session.scope. The child
          // holds no pi/session/store; this is the only way it can run a
          // command, and the scope it runs under cannot be widened from the
          // child. It mirrors pi_harness_bash exactly: plan the sandbox, refuse
          // + audit if out of scope or bwrap-unavailable, else mint a
          // harness-side run id and decision id, record the command_run claim
          // BEFORE the exit code is known (so the exit code is an independent
          // witness), run under the sandbox, and write one shell_exec audit line
          // carrying {runId, exitCode, decisionId} so the exit_code
          // external-evidence seam joins with no reader-side change. Every write
          // is attributed to the operator actor, never relabeled coordinator.
          const execRuntime: DelegateExecRuntime | undefined =
            built.contract.allowedCapabilities.includes("scoped_exec")
              ? {
                  run: async (command: string, expectSuccess: boolean) => {
                    const outcome = planSandbox(
                      command,
                      built.contract.scope,
                      config,
                      built.contract.scope.root,
                      { bwrapAvailable, exists: (pp: string) => fs.existsSync(pp) },
                    );
                    if (!outcome.ok) {
                      audit("operator", currentModel(ctx), "shell_exec", command, `refused: ${outcome.reason}`);
                      return { refused: true, reason: outcome.reason, output: `Refused: ${outcome.reason}` };
                    }
                    const decisionId = makeId("decision");
                    recordDecision("operator", currentModel(ctx), {
                      decisionId,
                      action: "command_run",
                      category: "command_execution",
                      rule: "operator_delegated_exec",
                      confidence: null,
                      context: { taskClass: null, estimatedComplexity: null, availableCapabilities: ["scoped_exec"] },
                      outcome: { status: expectSuccess ? "completed" : "failed", retries: 0, userOverride: false },
                    });
                    const runId = makeId("run");
                    const result = await pi.exec("/bin/sh", ["-c", outcome.command], { cwd: built.contract.scope.root });
                    audit("operator", currentModel(ctx), "shell_exec", command, `exit ${result.exitCode ?? 0}`, {
                      mounts: outcome.mounts,
                      runId,
                      exitCode: result.exitCode ?? 0,
                      decisionId,
                    });
                    const out = [result.stdout ?? "", result.stderr ?? ""].filter((s) => s.length > 0).join("\n");
                    return { refused: false, exitCode: result.exitCode ?? 0, output: out.length > 0 ? out : "(no output)" };
                  },
                }
              : undefined;

          let agent: unknown;
          try {
            // The tools close over this holder. It is populated before the
            // model receives a prompt, and makes every actual invocation
            // re-read the constructed child runtime immediately before and
            // after touching the filesystem.
            const child = { session: null as unknown };
            const continuouslyAttest = (phase: "before" | "after", tool: string): void => {
              if (child.session === null) {
                throw new Error(`runtime unavailable ${phase} ${tool}`);
              }
              const measured = attestChild(child.session as never, runtimeContract);
              if (!measured.ok) {
                throw new Error(`runtime drift ${phase} ${tool}: ${measured.violations.join("; ")}`);
              }
            };
            const created = await createAgentSession!({
              cwd: built.contract.scope.root,
              // noTools "all" plus an exact allowlist. Measured: the
              // allowlist is exact and no builtin leaks past it. Without it
              // the child comes up with 34 tools including bash, Agent and
              // harness_delegate.
              noTools: "all",
              tools: runtimeContract.allowedTools,
              customTools: buildDelegateTools(runtimeContract, runtimeLog, undefined, {
                attest: continuouslyAttest,
              }, execRuntime),
              resourceLoader: isolatedResourceLoader(),
            });
            agent = created.session;
            child.session = agent;
          } catch (error) {
            audit("coordinator", currentModel(ctx), "delegation", built.contract.id,
              `refused: the isolated child could not be constructed (${String(error)})`);
            job = transitionDelegationJob(job, "attestation-refused", `construction failed: ${String(error)}`);
            store!.appendDelegation(job);
            return { content: [{ type: "text", text:
              `Refused: could not construct an isolated delegate session. ${String(error)}` }] } as never;
          }

          // Attestation, before the child is prompted.
          //
          // The configuration above is a request; this reads back what Pi
          // actually built. Ordering is the whole point - a capability found
          // after the model has run is a breach report, not a defence - and
          // an unexpected capability is never quietly removed, because
          // removing it would hide that the runtime did not match.
          const attestation = attestChild(agent as never, runtimeContract);
          audit("coordinator", currentModel(ctx), "delegation", built.contract.id,
            attestation.ok ? "child attested" : "refused: attestation failed", {
              contract: built.contract.id,
              activeTools: attestation.activeTools,
              extensions: attestation.extensions,
              skills: attestation.skills,
              prompts: attestation.prompts,
              agentsFiles: attestation.agentsFiles,
              systemPromptChars: attestation.systemPromptChars,
              violations: attestation.violations,
            });
          if (!attestation.ok) {
            job = transitionDelegationJob(job, "attestation-refused", attestation.violations.join("; "));
            store!.appendDelegation(job);
            return { content: [{ type: "text", text: [
              `Refused: contract ${built.contract.id} was not delegated.`,
              "",
              "The child session Pi built does not match the contract, so it was",
              "discarded before the model saw the task:",
              ...attestation.violations.map((v) => `  - ${v}`),
              "",
              "Nothing was removed and retried: a runtime that came up wrong once is",
              "not a runtime to negotiate with.",
            ].join("\n") }] } as never;
          }

          const replyText = await runNestedPrompt(agent, renderContractPrompt(built.contract));

          // Re-attest after the run. A clean start is not evidence about the
          // end: Pi exposes `setActiveToolsByName` on the session object, so
          // the tool surface is mutable from inside the child's own process.
          // Two independent checks, because they can fail separately - the
          // runtime can drift without a drifted tool being called, and a
          // call can be logged for a tool the surface no longer advertises.
          const postAttestation = attestChild(agent as never, runtimeContract);
          const callDrift = attestCalls(runtimeLog, runtimeContract);
          const drift = [
            ...postAttestation.violations.map((v) => `runtime drift: ${v}`),
            ...callDrift,
            ...(runtimeLog.runtimeViolations ?? []).map((v) => `per-call attestation: ${v}`),
          ];
          if (drift.length > 0) {
            job = transitionDelegationJob(job, "aborted", drift.join("; "));
            store!.appendDelegation(job);
            audit("coordinator", currentModel(ctx), "delegation", built.contract.id,
              "aborted: runtime drift", { violations: drift, calls: runtimeLog.calls.length });
            const incident = makeIncident({
              session: session.id,
              description: `delegate ${built.contract.id} drifted outside its contract`,
              severity: "major",
              detectedBy: "core",
              model: session.coordinator,
              reasoningMode: session.reasoningMode,
              observedEffect: drift.join("; "),
              suspectedCause: "tool",
            });
            if (incident.ok) {
              store!.appendIncident(incident.incident);
              session = { ...session, incidentIds: [...session.incidentIds, incident.incident.id] };
              persistSession();
            }
            return { content: [{ type: "text", text: [
              `Contract ${built.contract.id} ABORTED: the delegate's runtime changed while it ran.`,
              ...drift.map((d) => `  - ${d}`),
              "",
              "The handoff was discarded. Work produced by a runtime that left its",
              "contract is not evidence, whatever it says.",
            ].join("\n") }] } as never;
          }

          const handoff = parseHandoff(replyText);

          // What the child actually did, from the tool implementations rather
          // than from its own account of itself.
          const denied = runtimeLog.calls.filter((c) => !c.allowed);
          audit("coordinator", currentModel(ctx), "delegation", built.contract.id,
            runtimeLog.pendingRequests.length > 0 ? "blocked: scope request" : "returned", {
              toolCalls: runtimeLog.calls.length,
              attestationChecks: runtimeLog.attestationChecks ?? 0,
              denied: denied.length,
              reads: runtimeLog.calls.filter((c) => c.tool === "scoped_read" && c.allowed)
                .map((c) => c.resolved).filter(Boolean),
              pendingRequests: runtimeLog.pendingRequests,
            });
          for (const request of runtimeLog.pendingRequests) {
            // Section 7: a blocked delegate notifies the main conversation
            // with the exact request. Persisted as a decision the user owns,
            // so it outlives this tool call.
            const pending = makeDecision({
              session: session.id,
              kind: "temporary",
              statement: `delegate ${built.contract.id} requests read scope: ${request}`,
              rationale: "the delegate reached its read boundary and asked rather than proceeding",
              revisitCondition: "when the user approves or denies the expansion",
              createdBy: "core",
            });
            if (pending.ok) {
              store!.appendDecision(pending.decision);
              session = { ...session, decisionIds: [...session.decisionIds, pending.decision.id] };
              persistSession();
            }
          }
          if (runtimeLog.pendingRequests.length > 0) {
            const requestedRoot = runtimeLog.pendingRequests[0].split(" :: ", 1)[0] ?? runtimeLog.pendingRequests[0];
            let canonicalRequested = requestedRoot;
            try { canonicalRequested = fs.realpathSync(requestedRoot); } catch { /* exact unresolved request remains visible */ }
            job = transitionDelegationJob(job, "blocked", "read-scope request awaits user decision", {
              pendingReadRoot: canonicalRequested,
            });
            store!.appendDelegation(job);
          } else {
            job = transitionDelegationJob(job, "completed", "structured handoff returned");
            store!.appendDelegation(job);
          }

          // Phase 4.1 decision telemetry: record that Pi chose to delegate/
          // consult, and the measured outcome. This runs after the contract,
          // attestation, drift checks, and job transition have all completed -
          // it only observes; it changes no verdict and grants no authority.
          recordDecision("coordinator", currentModel(ctx), {
            decisionId: built.contract.id,
            action: p.kind === "advisor" ? "consult" : "delegate",
            category: p.kind === "advisor" ? "advisory_consult" : "subagent_delegation",
            rule: p.kind === "operator" ? "bounded_sandboxed_delegation" : "bounded_read_only_delegation",
            confidence: null,
            context: {
              taskClass: null,
              estimatedComplexity: null,
              availableCapabilities: built.contract.allowedCapabilities.slice(),
            },
            outcome: { status: job.status, retries: 0, userOverride: false },
          });

          return {
            content: [
              {
                type: "text",
                text: [
                  `Contract ${built.contract.id} (${p.kind}, scope ${describeScope(built.contract.scope)})`,
                  "",
                  `CONCLUSION: ${handoff.conclusion || "(none returned)"}`,
                  `EVIDENCE:\n${handoff.evidence.map((e) => `- ${e}`).join("\n") || "- (none)"}`,
                  `ASSUMPTIONS:\n${handoff.assumptions.map((a) => `- ${a}`).join("\n") || "- (none)"}`,
                  `UNRESOLVED:\n${handoff.unresolvedQuestions.map((u) => `- ${u}`).join("\n") || "- (none)"}`,
                  `RECOMMENDED:\n${handoff.recommendedActions.map((r) => `- ${r}`).join("\n") || "- (none)"}`,
                  handoff.blockedRequest ? `\nBLOCKED: ${handoff.blockedRequest}` : "",
                  "",
                  `TOOL CALLS (measured, not reported): ${runtimeLog.calls.length} - ${runtimeLog.calls.filter((c) => c.allowed).length} allowed, ${denied.length} refused by scope`,
                  ...denied.slice(0, 5).map((c) => `  REFUSED ${c.tool}(${c.argument}): ${c.reason}`),
                  ...(runtimeLog.pendingRequests.length > 0
                    ? ["", "SCOPE REQUESTS AWAITING YOUR DECISION:",
                       ...runtimeLog.pendingRequests.map((r) => `  - ${r}`),
                       "Nothing was widened. Each is recorded as a pending decision."]
                    : []),
                  "",
                  "This is evidence and recommendation. Nothing has been applied.",
                ].join("\n"),
              },
            ],
          } as never;
        },
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * Commands
   * ---------------------------------------------------------------- */

  const requireSession = (): SessionState | null => {
    if (session === null) emit("Harness", ["No harness session is active."]);
    return session;
  };

  pi.registerCommand("harness", {
    description: "Harness status, scope, authority, audit, recovery, and checkpoints",
    getArgumentCompletions: (prefix) => {
      const subs = [
        "status",
        "scope ",
        "authority ",
        "audit",
        "capability ",
        "recover",
        "checkpoint ",
        "workstate",
      ];
      const matches = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s.trim() })) : null;
    },
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const state = requireSession();
      if (state === null || store === null) return;

      switch (sub) {
        case "status": {
          const tasks = store.readTasks();
          emit("Harness status", [
            `Session:   ${state.id}`,
            `Project:   ${state.projectRoot}`,
            `Scope:     ${describeScope(state.scope)}`,
            `Coordinator: ${state.coordinator ? `${state.coordinator.provider}/${state.coordinator.model}` : "(none)"}`,
            `Reasoning: ${state.reasoningMode}`,
            `Autonomy:  ${state.autonomy}`,
            `Approval:  ${state.approvalPolicy}`,
            `Checkpoints: ${state.checkpointCount}`,
            `Last verified: ${state.lastVerifiedState ?? "(nothing verified)"}`,
            `Queued tasks: ${queuedFor(tasks, state.projectRoot).length}`,
            `Sandbox:   ${bwrapAvailable() ? "bubblewrap available" : "UNAVAILABLE - the harness shell will refuse"}`,
            `Audit chain: ${describeAuditChain()}`,
          ]);
          return;
        }

        case "capability": {
          const [op, tool, ...reasonParts] = rest;
          const catalog = buildCatalog(catalogTools().tools, capabilityExceptions);
          if (op === "grant" && tool) {
            const outcome = grantException(tool, "user", reasonParts.join(" ") || "granted by the user", () => new Date());
            if (!outcome.ok) {
              audit("user", null, "capability_block", tool, `refused: ${outcome.reason}`);
              emit("Harness capability", [`Refused: ${outcome.reason} (${outcome.rule})`]);
              return;
            }
            capabilityExceptions.set(tool, outcome.exception);
            audit("user", null, "capability_grant", tool, `granted for this session: ${outcome.exception.reason}`);
            applyActiveTools();
            emit("Harness capability", [
              `${tool} activated for this session only.`,
              "It remains UNCONFINED: the harness cannot resolve its target or scope-check it.",
            ]);
            return;
          }
          if (op === "revoke" && tool) {
            // Revoking is authority-reducing, so it needs no approval and no
            // actor check - anyone may give a capability back.
            const had = capabilityExceptions.delete(tool);
            if (had) {
              audit("user", null, "capability_block", tool, "exception revoked");
              applyActiveTools();
            }
            emit("Harness capability", [had ? `${tool} revoked.` : `${tool} had no exception.`]);
            return;
          }
          emit("Harness capabilities", [
            describeCatalog(catalog),
            "",
            "Catalogued is not active (TO1). Unconfined tools come from outside the",
            "harness, which cannot resolve their targets and so cannot confine them.",
            "",
            "/harness capability grant <tool> <reason>   activate one, this session only",
            "/harness capability revoke <tool>           give it back",
          ]);
          return;
        }

        case "scope": {
          const [op, target] = rest;
          if (op === "approve" && target) {
            const outcome = approveExpansion(state.scope, target, ctx.cwd, pathOps);
            if (outcome.scope) {
              session = { ...state, scope: outcome.scope };
              persistSession();
              audit("user", null, "scope_expand_approved", target, outcome.reason);
              emit("Harness scope", [outcome.reason, describeScope(outcome.scope)]);
            } else {
              emit("Harness scope", [`Refused: ${outcome.reason}`]);
            }
            return;
          }
          if (op === "network" && (target === "on" || target === "off")) {
            session = { ...state, scope: { ...state.scope, networkGrant: target === "on" } };
            persistSession();
            audit("user", null, "scope_set", `network ${target}`, "applied");
            emit("Harness scope", [`Network grant: ${target}`]);
            return;
          }
          emit("Harness scope", [
            describeScope(state.scope),
            `Granted by: ${state.scope.grantedBy}`,
            `Automatic expansions remaining: ${state.scope.automaticExpansionBudget}`,
            "",
            "/harness scope approve <path>   grant a wider scope",
            "/harness scope network on|off   grant or revoke sandbox networking",
          ]);
          return;
        }

        case "authority": {
          const actor = (rest[0] ?? "coordinator") as Parameters<typeof capabilitiesOf>[0];
          emit(`Harness authority: ${actor}`, [
            ...capabilitiesOf(actor).map((action) => `- ${action}`),
            "",
            "Constitutional rules (not modifiable by any model):",
            ...CONSTITUTIONAL_RULES.map((rule) => `- ${rule}`),
          ]);
          return;
        }

        case "audit": {
          const events = store.readRecentAudit(AUDIT_TAIL);
          emit("Harness audit (most recent)", events.length > 0 ? events.map(formatAuditEvent) : ["(empty)"]);
          return;
        }

        case "recover": {
          const orphaned = orphanedDelegationJobs(store.readDelegations().records, (pid) => {
            try { process.kill(pid, 0); return true; } catch { return false; }
          });
          for (const job of orphaned) {
            const closed = transitionDelegationJob(
              job,
              "orphaned",
              "parent process ended before the nested session recorded an outcome; explicit restart required",
            );
            store.appendDelegation(closed);
            audit("core", null, "delegation", job.contractId, "orphaned after parent crash", {
              ownerPid: job.ownerPid,
              resumesContract: job.resumesContract,
            });
          }
          const auditRead = store.readAudit();
          const report = reconcile(
            store.readSessionState(),
            {
              projectRootExists: fs.existsSync(state.projectRoot),
              missingScopeRoots: state.scope.allowedRoots.filter((root) => !fs.existsSync(root)),
              auditTruncated: auditRead.truncatedTail,
            },
            auditRead.records.slice(-AUDIT_TAIL),
          );
          emit("Harness recovery", [
            `Can continue without asking: ${report.canContinue ? "yes" : "no"}`,
            `Resume from: ${report.resumeFrom ?? "(nothing verified)"}`,
            ...report.conflicts.map((c) => `CONFLICT: ${c}`),
            ...report.uncertain.map((u) => `UNCERTAIN: ${u}`),
            ...orphaned.map((job) =>
              `ORPHANED DELEGATE: ${job.contractId} cannot be resumed in place; review and explicitly restart it.`),
            "",
            "Reconstruct, verify against the real environment, then continue.",
          ]);
          return;
        }

        case "checkpoint": {
          const verified = rest.join(" ").trim();
          session = checkpoint(state, verified.length > 0 ? verified : null);
          persistSession();
          writeWorkstate();
          audit("user", null, "checkpoint", verified || "(no verified state given)", "recorded");
          emit("Harness", [`Checkpoint ${session.checkpointCount} recorded.`]);
          return;
        }

        case "workstate": {
          writeWorkstate();
          emit("Harness", [`WORKSTATE written to ${paths?.workstateFile ?? "(unknown)"}`]);
          return;
        }

        default:
          emit("Harness", [
            "/harness status | scope | authority <actor> | audit | recover | checkpoint <verified state> | workstate",
          ]);
      }
    },
  });

  pi.registerCommand("harness-mode", {
    description: "Set the harness reasoning mode, autonomy, or approval policy",
    handler: async (args) => {
      const state = requireSession();
      if (state === null) return;
      const [field, value] = args.trim().split(/\s+/).filter(Boolean);
      if (!field || !value) {
        emit("Harness mode", [
          `Reasoning: ${state.reasoningMode}  Autonomy: ${state.autonomy}  Approval: ${state.approvalPolicy}`,
          "",
          "/harness-mode reasoning constrained|balanced|exploratory",
          "/harness-mode autonomy interactive|guided|autonomous",
          "/harness-mode approval all-actions|mutations|consequential|none",
        ]);
        return;
      }
      // The command is the user's own hand, so the posture rules permit
      // anything here - but it goes through the same path as the tool so
      // that validation and the audit record are identical either way.
      const outcome = await applyPosture("user", field, value, null, null);
      emit("Harness mode", [outcome.message]);
    },
  });

  pi.registerCommand("harness-task", {
    description: "Create, list, or advance an explicit harness task",
    handler: async (args) => {
      const state = requireSession();
      if (state === null || store === null) return;
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/).filter(Boolean);

      if (!sub || sub === "list") {
        const tasks = store.readTasks().filter((task) => task.project === state.projectRoot);
        emit("Harness tasks", tasks.length > 0 ? tasks.map(formatTask) : ["(none)"]);
        return;
      }
      if (sub === "new") {
        const objective = rest.join(" ");
        if (objective.length === 0) {
          emit("Harness tasks", ["/harness-task new <objective>"]);
          return;
        }
        const task = createTask({
          objective,
          project: state.projectRoot,
          scope: state.scope,
          autonomy: state.autonomy,
          approvalPolicy: state.approvalPolicy,
          createdBy: "user",
          originSession: state.id,
        });
        store.writeTasks(upsert(store.readTasks(), task));
        session = { ...state, currentTaskId: task.id };
        persistSession();
        audit("user", null, "task_create", objective, task.id);
        emit("Harness tasks", [formatTask(task)]);
        return;
      }
      if (sub === "status") {
        const [id, next] = rest;
        const task = store.readTasks().find((t) => t.id === id);
        if (!task) {
          emit("Harness tasks", [`No task ${id}.`]);
          return;
        }
        const outcome = transition(task, next as Parameters<typeof transition>[1]);
        if (!outcome.ok) {
          emit("Harness tasks", [`Refused: ${outcome.reason}`]);
          return;
        }
        store.writeTasks(upsert(store.readTasks(), outcome.task));
        audit("user", null, "task_status", `${id} -> ${next}`, "applied");
        emit("Harness tasks", [formatTask(outcome.task)]);
        return;
      }
      emit("Harness tasks", ["/harness-task list | new <objective> | status <id> <status>"]);
    },
  });

  pi.registerCommand("harness-delegate", {
    description: "Resolve a blocked delegate read request: /harness-delegate approve|deny <contract-id> [exact-root]",
    handler: async (args, ctx) => {
      const state = requireSession();
      if (state === null || store === null) return;
      const [action, contractId, suppliedRoot] = args.trim().split(/\s+/).filter(Boolean);
      const job = latestDelegationJobs(store.readDelegations().records)
        .find((candidate) => candidate.contractId === contractId);
      if ((action !== "approve" && action !== "deny") || !contractId || job?.status !== "blocked") {
        emit("Harness delegation", [
          "/harness-delegate approve <blocked-contract-id> <exact-read-root>",
          "/harness-delegate deny <blocked-contract-id>",
        ]);
        return;
      }
      if (action === "deny") {
        const decision = makeDecision({
          session: state.id,
          kind: "durable",
          statement: `deny delegate ${contractId} read scope: ${job.pendingReadRoot}`,
          rationale: "the user denied the delegated child's requested read expansion",
          createdBy: "user",
        });
        if (!decision.ok) return;
        store.appendDecision(decision.decision);
        store.appendDelegation(transitionDelegationJob(job, "denied", `denied by ${decision.decision.id}`));
        audit("user", null, "delegation", contractId, "scope request denied", {
          decision: decision.decision.id,
          root: job.pendingReadRoot,
        });
        emit("Harness delegation", [
          `${contractId} denied. No authority changed.`,
          `Decision: ${decision.decision.id}`,
        ]);
        return;
      }

      if (!suppliedRoot) {
        emit("Harness delegation", [`Approval requires the exact requested root: ${job.pendingReadRoot}`]);
        return;
      }
      const checked = checkPath(suppliedRoot, state.scope, ctx.cwd, pathOps);
      if (!checked.allowed || checked.canonical !== job.pendingReadRoot) {
        emit("Harness delegation", [
          `Refused: approval must match the pending root exactly and remain inside parent scope.`,
          `Pending: ${job.pendingReadRoot}`,
          `Supplied: ${checked.canonical ?? suppliedRoot} (${checked.reason})`,
        ]);
        return;
      }
      const decision = makeDecision({
        session: state.id,
        kind: "durable",
        statement: approvalStatement(contractId, checked.canonical),
        rationale: "the user approved only this read root for a provenance-linked replacement child",
        createdBy: "user",
      });
      if (!decision.ok) return;
      store.appendDecision(decision.decision);
      audit("user", null, "delegation", contractId, "scope request approved for restart", {
        decision: decision.decision.id,
        root: checked.canonical,
      });
      emit("Harness delegation", [
        `${contractId} approved for exact read root ${checked.canonical}.`,
        `Decision: ${decision.decision.id}`,
        "Pi cannot pause and resume the same nested AgentSession. Start a replacement",
        "child with resumesContract, approvedReadRoot, and approvalDecisionId set to",
        "these exact values; the harness rejects any mismatch or reuse.",
      ]);
    },
  });

  pi.registerCommand("harness-decide", {
    description: "Record a decision: /harness-decide <durable|temporary> <statement> || <rationale> [|| <revisit>]",
    handler: async (args) => {
      const state = requireSession();
      if (state === null || store === null) return;
      const [kind, ...restParts] = args.trim().split(/\s+/);
      const [statement = "", rationale = "", revisit = ""] = restParts.join(" ").split("||").map((s) => s.trim());
      const outcome = makeDecision({
        session: state.id,
        kind: kind === "temporary" ? "temporary" : "durable",
        statement,
        rationale,
        revisitCondition: revisit || null,
        createdBy: "user",
      });
      if (!outcome.ok) {
        emit("Harness decision", [`Refused: ${outcome.reason} (${outcome.rule})`]);
        return;
      }
      store.appendDecision(outcome.decision);
      session = { ...state, decisionIds: [...state.decisionIds, outcome.decision.id] };
      persistSession();
      audit("user", null, "decision_record", statement, outcome.decision.id);
      emit("Harness decision", [`${outcome.decision.id} recorded.`]);
    },
  });

  pi.registerCommand("harness-incident", {
    description:
      "Record an incident: /harness-incident <minor|moderate|major> <description> || <observed effect> || <cause>",
    handler: async (args, ctx) => {
      const state = requireSession();
      if (state === null || store === null) return;
      const [severity, ...restParts] = args.trim().split(/\s+/);
      const [description = "", observed = "", cause = "unknown"] = restParts
        .join(" ")
        .split("||")
        .map((s) => s.trim());
      const outcome = makeIncident({
        session: state.id,
        description,
        severity: (["minor", "moderate", "major"].includes(severity) ? severity : "minor") as "minor",
        detectedBy: "user",
        model: state.coordinator,
        reasoningMode: state.reasoningMode,
        observedEffect: observed,
        suspectedCause: cause as Parameters<typeof makeIncident>[0]["suspectedCause"],
      });
      if (!outcome.ok) {
        emit("Harness incident", [`Refused: ${outcome.reason} (${outcome.rule})`]);
        return;
      }
      store.appendIncident(outcome.incident);
      session = { ...state, incidentIds: [...state.incidentIds, outcome.incident.id] };
      persistSession();
      audit("user", currentModel(ctx), "incident_record", description, outcome.incident.id);
      emit("Harness incident", [formatIncident(outcome.incident)]);
    },
  });

  pi.registerCommand("harness-memory", {
    description: "List, search, or add durable memory (user promotion only)",
    handler: async (args) => {
      if (store === null) return;
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const entries = store.readMemory().records;

      const projectRoot = session?.projectRoot ?? null;
      if (!sub || sub === "list") {
        // `list all` shows every project's memory; the default shows what is
        // actually in force here, which is what the retrieval path returns.
        const all = rest[0] === "all";
        const shown = all ? activeMemory(entries) : retrievableMemory(entries, projectRoot);
        emit("Harness memory", shown.length > 0 ? shown.map(formatMemoryEntry) : ["(empty)"]);
        return;
      }
      if (sub === "search") {
        const hits = searchMemory(entries, rest.join(" "), 20, projectRoot);
        emit("Harness memory", hits.length > 0 ? hits.map(formatMemoryEntry) : ["(no matches)"]);
        return;
      }
      if (sub === "add") {
        // `add project ...` binds the memory to this project; the default is
        // global, which is what v0.1 effectively wrote.
        const scoped = rest[0] === "project" || rest[0] === "global";
        const memoryScope = scoped ? (rest[0] as "project" | "global") : "global";
        const [category = "general", type = "fact", ...contentParts] = scoped ? rest.slice(1) : rest;
        if (memoryScope === "project" && projectRoot === null) {
          emit("Harness memory", ["Refused: no project root, so a project-scoped memory has nowhere to belong."]);
          return;
        }
        const outcome = promote("user", {
          category,
          epistemicType: type as "fact",
          content: contentParts.join(" "),
          scope: memoryScope,
          project: memoryScope === "project" ? projectRoot : null,
        },
        () => new Date(),
        undefined,
        // The command runs in this session, so this session's project is the
        // extent of its authority.
        { permittedProject: projectRoot });
        if (!outcome.ok) {
          emit("Harness memory", [`Refused: ${outcome.reason} (${outcome.rule})`]);
          return;
        }
        store.appendMemory(outcome.entry);
        audit("user", null, "memory_promote", outcome.entry.content, outcome.entry.id);
        emit("Harness memory", [formatMemoryEntry(outcome.entry)]);
        return;
      }
      emit("Harness memory", [
        "/harness-memory list [all] | search <text>",
        "/harness-memory add [global|project] <category> <fact|assumption|opinion> <content>",
        "",
        "Default retrieval is global memory plus this project's (section 32).",
      ]);
    },
  });

  pi.registerCommand("harness-identity", {
    description: "Show or edit Pi's durable identity (user only)",
    handler: async (args) => {
      if (store === null) return;
      const [sub, field, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      identity = identity ?? store.readIdentity();

      if (!sub || sub === "show") {
        const block = renderIdentityBlock(identity);
        emit("Harness identity", [
          block.length > 0 ? block : "(empty)",
          "",
          "/harness-identity add principle|preference|behavior <text>",
          "/harness-identity remove principle|preference|behavior <text>",
        ]);
        return;
      }
      const valid = ["principle", "preference", "behavior"];
      if ((sub !== "add" && sub !== "remove") || !valid.includes(field ?? "")) {
        emit("Harness identity", [`field must be one of: ${valid.join(", ")}`]);
        return;
      }
      const text = rest.join(" ");
      const outcome =
        sub === "add"
          ? addIdentityLine(identity, "user", field as IdentityField, text)
          : removeIdentityLine(identity, "user", field as IdentityField, text);
      if (!outcome.ok) {
        emit("Harness identity", [`Refused: ${outcome.reason} (${outcome.rule})`]);
        return;
      }
      identity = outcome.identity;
      store.writeIdentity(identity);
      audit("user", null, "identity_change", `${sub} ${field}: ${text}`, "applied");
      emit("Harness identity", [renderIdentityBlock(identity) || "(empty)"]);
    },
  });

  pi.registerCommand("harness-policy", {
    description: "Show or tune the durable soft policy (global/device/project layers)",
    handler: async (args) => {
      if (store === null) return;
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const chain = store.readSoftPolicyChain();

      if (!sub || sub === "show") {
        emit("Harness policy", [
          formatSoftPolicy(resolveSoftPolicy(chain), chain.map((r) => r.level)),
          "",
          "/harness-policy set <global|device|project> <field> <value>",
          "fields: delegateExternalResearch, runTestsAfterEdits,",
          "        consultAdvisorOnLowConfidence, preferredReasoningModeHint,",
          "        denyTool, allowTool",
        ]);
        return;
      }
      if (sub !== "set") {
        emit("Harness policy", ["/harness-policy show | set <level> <field> <value>"]);
        return;
      }
      const [level, field, ...valueParts] = rest;
      if (level !== "global" && level !== "device" && level !== "project") {
        emit("Harness policy", ["level must be global, device, or project"]);
        return;
      }
      const existing =
        store.readSoftPolicy(level) ??
        toSoftPolicyRecord(defaultSoftPolicy(level), level, "user", nowIso());
      const outcome = editSoftPolicy(existing, "user", field ?? "", valueParts.join(" "), nowIso());
      if (!outcome.ok) {
        emit("Harness policy", [`Refused: ${outcome.reason} (${outcome.rule})`]);
        return;
      }
      store.writeSoftPolicy(outcome.record);
      soft = resolveSoftPolicy(store.readSoftPolicyChain());
      audit("user", null, "policy_change", `${level}.${field}=${valueParts.join(" ")}`, "applied");
      emit("Harness policy", [
        `${level}.${field} updated. Resolved policy:`,
        formatSoftPolicy(soft, store.readSoftPolicyChain().map((r) => r.level)),
      ]);
    },
  });

  pi.registerCommand("harness-goal", {
    description: "Goals above tasks, and relationships between projects",
    handler: async (args) => {
      const state = requireSession();
      if (state === null || store === null) return;
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const goals = store.readGoals();

      if (!sub || sub === "list") {
        const applicable = goalsForProject(goals, state.projectRoot);
        const links = relatedProjects(store.readProjectLinks(), state.projectRoot);
        emit("Harness goals", [
          ...(applicable.length > 0 ? applicable.map(formatGoal) : ["(no goals apply here)"]),
          "",
          "Related projects (context only, never access):",
          ...(links.length > 0 ? links.map(formatLink) : ["(none)"]),
        ]);
        return;
      }

      if (sub === "new") {
        // /harness-goal new <now|near|long> <priority 1-5> <statement> [|| conflict phrases]
        const [horizon, priorityRaw, ...statementParts] = rest;
        const [statement = "", conflicts = ""] = statementParts.join(" ").split("||").map((x) => x.trim());
        const outcome = makeGoal({
          statement,
          horizon: horizon as GoalHorizon,
          priority: Number.parseInt(priorityRaw ?? "3", 10),
          projects: [],
          conflictsWith: conflicts.length > 0 ? conflicts.split(",").map((c) => c.trim()) : [],
          createdBy: "user",
        });
        if (!outcome.ok) {
          emit("Harness goals", [
            `Refused: ${outcome.reason}`,
            "/harness-goal new <now|near|long> <1-5> <statement> [|| phrase, phrase]",
          ]);
          return;
        }
        store.writeGoals(upsertGoal(goals, outcome.goal));
        audit("user", null, "goal_change", statement, outcome.goal.id);
        emit("Harness goals", [formatGoal(outcome.goal)]);
        return;
      }

      if (sub === "status") {
        const [id, status] = rest;
        const goal = goals.find((g) => g.id === id);
        if (!goal || (status !== "active" && status !== "met" && status !== "dropped")) {
          emit("Harness goals", ["/harness-goal status <id> <active|met|dropped>"]);
          return;
        }
        store.writeGoals(upsertGoal(goals, setGoalStatus(goal, status)));
        audit("user", null, "goal_change", `${id} -> ${status}`, "applied");
        emit("Harness goals", [`${id} is now ${status}.`]);
        return;
      }

      if (sub === "link") {
        const [other, kind, ...detail] = rest;
        const outcome = makeProjectLink(
          state.projectRoot,
          other ?? "",
          kind as ProjectLinkKind,
          detail.join(" "),
          "user",
        );
        if (!outcome.ok) {
          emit("Harness goals", [
            `Refused: ${outcome.reason}`,
            "/harness-goal link <other-project-root> <shared-dependency|shared-goal|shared-tool|inherited-decision> <detail>",
          ]);
          return;
        }
        store.writeProjectLinks(upsertLink(store.readProjectLinks(), outcome.link));
        audit("user", null, "goal_change", `link ${state.projectRoot} <-> ${other}`, outcome.link.kind);
        emit("Harness goals", [
          formatLink(outcome.link),
          "",
          "This records a relationship. It grants no access to the other project;",
          "working there still needs a scope expansion.",
        ]);
        return;
      }

      if (sub === "check") {
        // Surface tension between standing goals and a proposed objective.
        const objective = rest.join(" ");
        const conflicts = conflictingGoals(goals, state.projectRoot, objective);
        emit("Harness goals", [
          conflicts.length === 0
            ? "No standing goal conflicts with that."
            : "Tension with standing goals (advisory - your instruction still wins):",
          ...conflicts.map((c) => `- "${c.phrase}" conflicts with: ${c.goal.statement}`),
        ]);
        return;
      }

      emit("Harness goals", ["/harness-goal list | new | status | link | check <objective>"]);
    },
  });

  pi.registerCommand("harness-review", {
    description: "Show or run the retrospective review queue",
    getArgumentCompletions: (prefix) => {
      const subs = ["list", "run "];
      const matches = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s.trim() })) : null;
    },
    handler: async (args, ctx) => {
      if (store === null || paths === null) return;
      const [sub = "list", id] = args.trim().split(/\s+/).filter(Boolean);
      const queue = store.readReviewQueue();

      if (sub !== "run") {
        emit(
          "Harness review queue",
          queue.length > 0
            ? queue.map((item) => `${item.id} [${item.status}] session ${item.sessionId} (${item.project})`)
            : ["(empty)"],
        );
        return;
      }

      const item = id ? queue.find((q) => q.id === id) : queue.find((q) => q.status === "pending");
      if (!item) {
        emit("Harness review", [id ? `No review ${id}.` : "Nothing pending."]);
        return;
      }
      if (createAgentSession === null) {
        emit("Harness review", ["Pi's agent-session SDK is unavailable; cannot run a reviewer here."]);
        return;
      }

      const mark = (status: ReviewQueueItem["status"], error: string | null) => {
        store!.writeReviewQueue(
          store!.readReviewQueue().map((q) => (q.id === item.id ? { ...q, status, error } : q)),
        );
      };
      mark("running", null);

      try {
        // What the reviewer rereads is Pi's session JSONL (sections 6.3 and
        // 32 condition 1), retrieved through the fixed reader.
        //
        // v0.2 measured the harness's own audit log here and called the
        // result a complete session read. It was not wrong about the number
        // - the audit log really was read completely - it was measuring the
        // wrong artifact. The audit log records the decisions the harness
        // made; it contains no user message, no assistant reply, no tool
        // result and no compaction, so a reviewer given only that can see a
        // write being denied and cannot see what was asked for. Deleting the
        // session file outright changed neither the count nor the verdict,
        // which is the proof that the file was never being opened.
        //
        // Fail-closed on a missing path: condition 1 is a claim about a read
        // that happened, and there is no honest way to make it about a file
        // nobody can name. A v0.1 queue row, or a session Pi ran without a
        // file, is therefore un-reviewable rather than trivially complete.
        if (item.sessionFile === null) {
          mark("failed", "no Pi session file recorded for that session");
          emit("Harness review", [
            `Session ${item.sessionId} has no recorded Pi session file.`,
            "Section 32 condition 1 requires a complete read of the session JSONL, so this",
            "review cannot be run. Rows queued by v0.1, and sessions Pi ran without a",
            "session file, are affected.",
          ]);
          return;
        }
        const sessionRead = readPiSession(item.sessionFile, {
          readFile: (file) => fs.readFileSync(file, "utf8"),
          exists: (file) => fs.existsSync(file),
        });
        if (!sessionRead.found) {
          mark("failed", sessionRead.reason);
          emit("Harness review", [
            `Cannot read the session file for ${item.sessionId}: ${sessionRead.reason}`,
            `Path: ${item.sessionFile}`,
          ]);
          return;
        }

        // `linesExpected` is the physical non-empty line count of the file,
        // counted from raw text before anything parsed. A line the reader
        // could not parse is still a line it did not retrieve, so it widens
        // the gap rather than vanishing from the denominator - which is what
        // makes a truncated or damaged session fail the condition instead of
        // silently producing a review of a prefix.
        const linesExpected = sessionRead.linesTotal;
        const linesRead = sessionRead.linesParsed;

        // The harness audit for the same session is shown alongside the
        // transcript as complementary evidence - it is what the harness did
        // while the session ran, which the session file does not record -
        // but it is deliberately not part of the coverage denominator. Two
        // different artifacts, one claim each.
        const auditRead = store.readAudit();
        const sessionEvents = auditRead.records.filter((event) => event.session === item.sessionId);
        const auditTranscript = sessionEvents.map(formatAuditEvent).join("\n");
        // The header deliberately carries no citable id. An earlier version
        // printed the harness session id here and the live reviewer cited it
        // on every single item - it was the most prominent id on the page and
        // it is not an entry, so every item was correctly rejected. Naming a
        // decoy is a way of causing the failure the gate then reports.
        const transcript = [
          `# Pi session transcript: ${sessionRead.linesTotal} line(s), ${sessionRead.entries.length} entries.`,
          `# Cite the id at the start of the line you are citing.`,
          renderSessionTranscript(sessionRead),
          "",
          `# Harness audit for this session (${sessionEvents.length} event(s))`,
          auditTranscript.length > 0 ? auditTranscript : "(none)",
        ].join("\n");

        // The id space a citation may point into: every entry in the session
        // file, plus this session's audit events and the decisions and
        // incidents it produced. All of them are in the transcript above; a
        // citation outside the set is a fabrication however well-formed it
        // looks, which is the difference condition 3 exists to catch.
        const knownEntryIds = new Set<string>([
          ...sessionRead.entryIds,
          ...sessionEvents.map((event) => event.id),
          ...store.readDecisions().records.filter((d) => d.session === item.sessionId).map((d) => d.id),
          ...store.readIncidents().records.filter((i) => i.session === item.sessionId).map((i) => i.id),
        ]);

        const existing = activeMemory(store.readMemory().records).map(formatMemoryEntry);
        const created = await createAgentSession({
          cwd: item.project,
          // The reviewer has learning authority and no operational authority
          // (spec section 20): read-only tools, nothing that can mutate.
          noTools: "builtin",
          tools: ["read", "grep", "find", "ls"],
        });
        const replyText = await runNestedPrompt(created.session, renderReviewPrompt(transcript, existing));
        const parsed = parseReviewProposals(replyText);

        // Section 32, conditions 2 and 3. The parser is not the gate: a
        // parser that silently enforced policy would be a policy nobody can
        // find. `checkReviewEvidence` drops every item that does not cite an
        // id from this session and reports what it dropped, verbatim.
        const shaped = validateReviewProposals(parsed);
        const { acceptance, filtered } = checkReviewEvidence(
          shaped ?? parsed,
          knownEntryIds,
          { linesExpected, linesRead },
          replyText,
        );
        // Only the surviving items are ever acted on. On rejection this is
        // empty, so a caller that ignored `accepted` still cannot promote
        // anything - the gate is structural, not advisory.
        const proposals = acceptance.accepted ? filtered : { ...filtered, memoryCandidates: [], modelSpecificGuidance: [] };

        // MO4: which model produced this reading is itself evidence.
        const reviewerModel = item.reviewerModel ?? currentModel(ctx);
        // Section 32: repeated reviews of a resumed session are separate
        // generations, not overwrites.
        const generation = nextReviewGeneration(store.listReviewGenerations(item.sessionId));
        store.writeReviewGeneration({
          schemaVersion: HARNESS_SCHEMA_VERSION,
          id: makeId("review"),
          sessionId: item.sessionId,
          generation,
          reviewerModel,
          createdAt: nowIso(),
          acceptance,
          // The reviewer's own words are kept alongside the parsed
          // proposals. Without them, an empty proposal set is ambiguous in
          // exactly the way section 19 warns about: "the reviewer found
          // nothing" and "the reviewer's answer did not parse" are different
          // facts, and storing only the parse result silently converts the
          // second into the first. The raw reply is the evidence;
          // `proposals` is the interpretation of it.
          proposals: { ...filtered, unfiltered: parsed } as unknown as Record<string, unknown>,
          rawReply: replyText.slice(0, 20000),
        });

        if (!acceptance.accepted) {
          mark("failed", acceptance.reason);
          audit("reviewer", reviewerModel, "review_rejected", item.sessionId, acceptance.reason, {
            generation,
            readComplete: acceptance.readComplete,
            shapeValid: acceptance.shapeValid,
            citationsValid: acceptance.citationsValid,
            rejectedItems: acceptance.rejectedItems.length,
          });
          emit("Harness review", [
            `Review of session ${item.sessionId} was NOT accepted (generation ${generation}).`,
            `Read complete: ${acceptance.readComplete} (${acceptance.linesRead}/${acceptance.linesExpected} lines)`,
            `Shape valid:   ${acceptance.shapeValid}`,
            `Citations:     ${acceptance.citationsValid}`,
            acceptance.reason,
            ...acceptance.rejectedItems.slice(0, 10).map((r) => `UNCITED: ${r}`),
            "",
            "Nothing was promoted. The reviewer's raw reply is stored for inspection.",
          ]);
          return;
        }

        // Memory promotion. A reviewer promotion without citations is
        // refused by memory.ts (M5); those are reported, never forced.
        let promoted = 0;
        const rejected: string[] = [];
        for (const candidate of proposals.memoryCandidates) {
          const outcome = promote("reviewer", {
            category: "retrospective",
            epistemicType: "fact",
            content: candidate.content,
            sourceReferences: candidate.sources,
            // Section 32: a retrospective on one project's session is
            // evidence about that project. Promoting it globally would make
            // one repository's lesson follow the user everywhere, which is
            // the failure the memory-scope rule names.
            scope: "project",
            project: item.project,
          },
          () => new Date(),
          undefined,
          // A review's authority is the project of the session it read, and
          // `item.project` is the queue entry the harness wrote at session
          // close - not anything the reviewer model can influence. Passing it
          // as both the draft's project and the caller's authority is
          // deliberate: it makes the equality explicit rather than implicit,
          // so a future change that lets the model name a project fails here
          // instead of silently writing into someone else's memory.
          { permittedProject: item.project });
          if (outcome.ok) {
            store.appendMemory(outcome.entry);
            audit("reviewer", reviewerModel, "memory_promote", candidate.content, outcome.entry.id);
            promoted++;
          } else {
            rejected.push(`${candidate.content} (${outcome.reason})`);
          }
        }

        // Section 6.4: model guidance is *stored as a proposal*, never
        // applied. It is also filed under the model it concerns, so a
        // correction for one model never constrains another (MO2).
        if (reviewerModel && proposals.modelSpecificGuidance.length > 0) {
          const target = item.reviewerModel ?? reviewerModel;
          fs.mkdirSync(modelDir(paths, target), { recursive: true });
          for (const guidance of proposals.modelSpecificGuidance) {
            store.appendGuidanceProposal(modelProposalsFile(paths, target), {
              guidance,
              session: item.sessionId,
              proposedAt: nowIso(),
              status: "proposed",
            });
          }
        }

        mark("complete", null);
        audit("reviewer", reviewerModel, "review_complete", item.sessionId, `${promoted} memories promoted`, {
          generation,
        });
        emit("Harness review", [
          `Review ${item.id} complete (session ${item.sessionId}, generation ${generation}).`,
          `Findings: ${proposals.findings.length}  Patterns: ${proposals.patterns.length}  Mistakes: ${proposals.mistakes.length}`,
          ...(acceptance.uniformCitation
            ? [
                "WARNING: every item cites the same single session entry. That passes the",
                "evidence gate - the id is real - but it is what padded citations look like.",
                "The gate cannot check that an entry supports the claim attached to it.",
              ]
            : []),
          `Memory promoted: ${promoted}`,
          ...rejected.map((r) => `REJECTED: ${r}`),
          `Model-guidance proposals stored (not applied): ${proposals.modelSpecificGuidance.length}`,
          "",
          "Proposals are proposals. Nothing here has changed how Pi behaves.",
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mark("failed", message);
        audit("core", null, "review_complete", item.sessionId, `failed: ${message}`);
        emit("Harness review", [`Review ${item.id} failed: ${message}`]);
      }
    },
  });

  /**
   * Render an evaluation report for the terminal. Pure formatting - it names no
   * change and recommends nothing (that is Phase 4.3); it only reports whether
   * observed outcomes matched recorded decisions, and keeps the four meanings
   * of "empty" distinct so "nothing evaluated" is never read as "all correct".
   */
  const renderEvaluation = (report: EvaluationReport): string[] => {
    const { coverage: cov, provenance: prov } = report;
    const lines: string[] = [
      `Decisions observed: ${cov.decisionsObserved}  (measured ${cov.measured}, unmeasured ${cov.unmeasured}, unsupported ${cov.unsupported})`,
      `Audit chain: ${prov.chainOk ? "ok" : "BROKEN"} (verified ${prov.verifiedPrefix}/${prov.totalRecords})`,
      `Evidence: ${prov.evidenceCount} records (${prov.claims} claims, ${prov.observations} observations)`,
    ];
    if (cov.decisionsObserved === 0) {
      lines.push("", "No recorded decisions to evaluate yet. This means telemetry is empty, not that every decision was correct.");
    } else {
      lines.push(
        `Corroboration: ${cov.externallyCorroborated} externally observed, ${cov.agentAuthoredOnly} on Pi's own account only (unconfirmed).`,
      );
      lines.push("", "By action:");
      for (const action of Object.keys(report.byAction).sort()) {
        const b = report.byAction[action];
        lines.push(`  ${action}: ${b.total} total  ${b.match} match  ${b.mismatch} mismatch  ${b.unmeasured} unmeasured`);
      }
      const mismatches = report.decisions.filter((d) => d.verdict === "mismatch");
      lines.push("", mismatches.length > 0 ? "Mismatches (telemetry claim vs observed evidence):" : "No mismatches among measured decisions.");
      for (const d of mismatches) {
        lines.push(
          `  ${d.decisionId} [${d.action}] ${d.verdictReason}` +
            (d.observedEvidence ? ` (evidence: ${d.observedEvidence.source} ${d.observedEvidence.refId})` : ""),
        );
      }
    }
    lines.push("", "This is observation only. Nothing here changes how Pi behaves; nothing was written.");
    return lines;
  };

  /**
   * Build the current outcome evaluation. Strictly read-only: reads the audit
   * chain, delegation records, and reviews, folds in the Phase 4.2
   * external-evidence (file_diff) reader, and evaluates. The reader's
   * edit-expectation predicate is conservatively false today - the only
   * telemetry seam is read-only delegation, which is meant to produce no diff -
   * so it emits nothing until an edit-class decision is recorded. This is the one
   * read-only entry point shared by /harness-eval and /harness-propose (§C).
   */
  const evaluateCurrent = (state: NonNullable<ReturnType<typeof requireSession>>): EvaluationReport => {
    const auditRead = store!.readAudit();
    const verification = store!.verifyAudit();
    const delegations = store!.readDelegations().records;
    const reviews = store!.readReviewGenerations(state.id);
    const evidence = toEvidence({ audit: auditRead.records, delegations, reviews });
    const claims = evidence.filter((e): e is DecisionClaim => e.kind === "claim");
    const fileDiff = readFileDiffEvidence(claims, delegations, {
      gitDiff: (anchor, roots) => gitDiffSince(paths?.projectRoot ?? process.cwd(), anchor, roots),
      now: nowIso(),
      expectsFileChange: () => false,
    });
    // exit_code external evidence: joins decisions to harness-captured process
    // exits by decisionId (read only from shell_exec audit records; no
    // model-supplied field enters the join). Dormant until a command-executing
    // decision class stamps decisionId on its shell_exec lines.
    const exitCodes = readExitCodeEvidence(claims, extractExecutionRecords(auditRead.records));
    return evaluate({
      evidence: [...evidence, ...fileDiff, ...exitCodes],
      chain: chainTrust(verification, auditRead.records.length),
    });
  };

  pi.registerCommand("harness-eval", {
    description: "Read-only outcome evaluation: did observed outcomes match recorded decisions? (writes nothing)",
    handler: async () => {
      const state = requireSession();
      if (state === null || store === null) return;
      // Strictly read-only. Leaves the system byte-identical: no audit(), no
      // session persist, no checkpoint or workstate. Phase 4.2 observes.
      emit("Harness outcome evaluation", renderEvaluation(evaluateCurrent(state)));
    },
  });

  /** Proposals older than this render as stale (Amendment 2). A display rule
   * only - no status is stored. */
  const PROPOSAL_STALE_DAYS = 14;

  /**
   * Render proposals for a human, with staleness computed at read time. Names
   * no change beyond the drafted suggestion text and enacts nothing.
   */
  const renderProposals = (
    all: ImprovementProposal[],
    freshCount: number,
    stale: { now: string; maxAgeDays: number; currentByDecision: Map<string, string> },
  ): string[] => {
    if (all.length === 0) {
      return [
        "No proposals. Either no outcome mismatches have been observed, or none map to a proposable class.",
        "This is not evidence that every decision was correct - run /harness-eval for coverage.",
      ];
    }
    const lines = [`${all.length} proposal(s) on file; ${freshCount} new this run.`, ""];
    let staleCount = 0;
    for (const p of all) {
      const s = classifyStaleness(p, stale);
      if (s !== "fresh") staleCount++;
      const tag = s === "fresh" ? "" : ` [${s.toUpperCase()}]`;
      lines.push(`- ${p.proposalClass}${tag}: ${p.text}`);
      lines.push(`    evidence: ${p.evidence.decisionIds.length} decision(s); proposed ${p.proposedAt}`);
    }
    lines.push(
      "",
      `${staleCount} of ${all.length} render as stale (older than ${stale.maxAgeDays} days or evidence superseded).`,
      "These are DRAFTS. Nothing here has changed how Pi behaves; apply one only by editing AGENTS.md / config / memory yourself.",
    );
    return lines;
  };

  pi.registerCommand("harness-propose", {
    description: "Draft human-reviewable improvement proposals from evaluated outcome mismatches (writes proposals only; applies nothing)",
    handler: async (_args, ctx) => {
      const state = requireSession();
      if (state === null || store === null) return;

      // Same evaluation the read-only evaluator produces (external-evidence
      // folded in). This command writes ONLY improvement-proposal records and one
      // proposal_created audit line per new proposal. It edits no AGENTS.md, no
      // policy, no config, no memory, no session state - a proposal is enacted
      // only by a human (Phase 4.3 generation-only).
      const report = evaluateCurrent(state);

      const now = nowIso();
      const model = currentModel(ctx);
      const generated = generateProposals(report, { model, proposedAt: now });
      const existing = store.readImprovementProposals().records;
      const fresh = selectNewProposals(existing, generated);

      for (const proposal of fresh) {
        store.appendImprovementProposal(proposal);
        // A draft is a MODEL assertion (AU2): actor coordinator + its model,
        // never "user".
        audit("coordinator", model, "proposal_created", `${proposal.proposalClass}: ${proposal.text}`, "proposed", {
          proposalId: proposal.id,
          decisionIds: proposal.evidence.decisionIds,
        });
      }

      const currentByDecision = new Map(report.decisions.map((d) => [d.decisionId, d.verdict]));
      emit(
        "Harness proposals",
        renderProposals([...existing, ...fresh], fresh.length, { now, maxAgeDays: PROPOSAL_STALE_DAYS, currentByDecision }),
      );
    },
  });
}
