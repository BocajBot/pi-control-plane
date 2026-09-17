/**
 * Pi Control Plane — extension entry point.
 *
 * Registers the /context, /phase, and /autonomy commands,
 * the tool-authorization hook, per-turn state injection, session persistence,
 * the footer status segment, and three hotkeys (alt+c context preview,
 * alt+p phase cycle, alt+a autonomy cycle).
 *
 * All decision logic lives in ../src/control-plane/ and is unit-tested
 * without Pi. This file is wiring only.
 */

import { CreditBalance, openRouterMessageCost, readOpenRouterBalance } from "../src/control-plane/credits.ts";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BashToolCallEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import {
  emptyTimingState,
  recordTurn,
  renderTimingSummary,
  restoreTimingFromEntries,
  TIMING_ENTRY_TYPE,
  timingFooterSegment,
} from "../src/control-plane/turn-timing.ts";
import {
  addTodo,
  clearCompleted,
  completeTodo,
  emptyTodoState,
  reopenTodo,
  removeTodo,
  renderTodoBlock,
  renderTodoList,
  renderTodoWidget,
  restoreTodoFromEntries,
  TODO_COMPLETION_ENTRY_TYPE,
  TODO_ENTRY_TYPE,
  type TodoOpResult,
  type TodoState,
} from "../src/control-plane/todo.ts";
import {
  newerTodo,
  readWorkspaceTodo,
  writeWorkspaceTodo,
} from "../src/control-plane/todo-store.ts";

import {
  parseBwrapArgs,
  parseContextArgs,
  parseModeArgs,
  parseScratchpadArgs,
} from "../src/control-plane/commands.ts";
import { diffIsEmpty, diffSnapshots } from "../src/control-plane/context-diff.ts";
import {
  applyEdits,
  extractText,
  mergeOverlay,
  type MessageLike,
  type Overlay,
  parseEditedContext,
  serializeContext,
} from "../src/control-plane/context-editor.ts";
import { buildSnapshot, sha256 } from "../src/control-plane/context-snapshot.ts";
import { redactSecrets } from "../src/control-plane/redaction.ts";
import {
  buildSandboxedCommand,
  describeSandbox,
  emptySandboxState,
  restoreSandboxFromEntries,
} from "../src/control-plane/sandbox.ts";
import {
  addNote,
  clearScratchpad,
  emptyScratchpad,
  generateNoteId,
  removeNote,
  renderScratchpadBlock,
  renderScratchpadList,
  restoreScratchpadFromEntries,
} from "../src/control-plane/scratchpad.ts";
import {
  type CustomEntryLike,
  cycleMode,
  defaultState,
  type Mode,
  modeOf,
  restoreFromEntries,
  stateForMode,
} from "../src/control-plane/state.ts";
import { applyContextFileToggles, replaceSkillsBlock, toggleName } from "../src/control-plane/toggles.ts";
import {
  ALL_PROFILE,
  applyAlwaysDisabled,
  applyProfile,
  clearToolToggles,
  currentProfileForActiveTools,
  currentProfileName,
  type ProfilesConfig,
  validateProfiles,
} from "../src/control-plane/profiles.ts";
import {
  countPayloadTokens,
  type JsonFetch,
  serializeForCounting,
  type TokenCountResult,
} from "../src/control-plane/token-counter.ts";
import {
  canonicalizePath,
  classifyTool,
  evaluateToolCall,
  riskCategoryFor,
  validatePolicy,
  type PathOps,
} from "../src/control-plane/tool-policy.ts";
import {
  defaultBackupRoot,
  planBackup,
  resolveNonCollidingPath,
} from "../src/control-plane/backup.ts";
import { isSensitiveReadTarget, type SensitiveReadExtra } from "../src/control-plane/sensitive-paths.ts";
import {
  addRule,
  emptyRules,
  matchRule,
  removeRule,
  renderRulesList,
  restoreRulesFromEntries,
} from "../src/control-plane/rules.ts";
import {
  buildInjectionBlock,
  contextWarningLevel,
  compactFooterState,
  displayMode,
  formatAddedContext,
  formatContextWarning,
  formatDenial,
  formatDraftCounter,
  formatFooterStats,
  formatStatus,
  formatTokenCount,
  LIMITS,
  type ProfilePickerItem,
  renderContextSummary,
  renderActiveTools,
  renderDiagnosticsPanel,
  renderDiff,
  renderHotkeyCheatsheet,
  renderProfilePicker,
  renderSources,
  SANDBOX_ALIAS_WARNING,
  SENSITIVE_OUTPUT_WARNING,
  USAGE,
} from "../src/control-plane/ui.ts";
import {
  type ContextSnapshot,
  type ControlPlaneState,
  DIAGNOSTIC_ENTRY_TYPE,
  OUTPUT_ENTRY_TYPE,
  type RestrictedPolicy,
  SANDBOX_ENTRY_TYPE,
  type SandboxState,
  SCRATCHPAD_ENTRY_TYPE,
  type ScratchpadState,
  type SnapshotItem,
  STATE_ENTRY_TYPE,
  type ToolDecision,
  RULES_ENTRY_TYPE,
  type RememberedRulesState,
} from "../src/control-plane/types.ts";
import {
  DEFAULT_TRANSCRIPTION_BASE_URL,
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  DEFAULT_TRANSCRIPTION_MODEL,
  formatTranscript,
  type PostAudio,
  transcribeAudio,
} from "../src/control-plane/transcription.ts";
import {
  DEFAULT_SEARXNG_BASE_URL,
  formatSearchResults,
  type GetFetch,
  MAX_RESULTS as MAX_SEARCH_RESULTS,
  searchSearxng,
} from "../src/control-plane/websearch.ts";

/** Transcription measures 0.03-0.04x realtime on real 8kHz voicemails now
 * that it runs on the GPU, so this is a very generous ceiling: it exists to
 * cover a llama-swap cold start that may first evict a 23 GiB chat model,
 * not a typical HTTP round trip. */
const TRANSCRIPTION_TIMEOUT_MS = 900_000;

const STATUS_KEY = "control-plane";
const WIDGET_KEY = "control-plane-context";
/** Shared left grid: every extension-owned footer/header row starts at column 1. */
const PAD = " ";

interface OutputEntryData {
  title: string;
  lines: string[];
}

interface TodoCompletionEntryData {
  message: string;
}

/**
 * One-line render for a control-plane diagnostic entry. Kind-aware: renders
 * as the actual kind plus whatever subject it carries (a toolName, or a
 * target) - so any kind without a toolName field (e.g. a
 * read-out-of-scope-denied keyed by `target`, or an advisor-consult) still
 * shows something meaningful instead of a bare "?".
 */
export function formatDiagnosticLine(data: Record<string, unknown> | undefined): string {
  const kind = typeof data?.kind === "string" ? data.kind : "diagnostic";
  const at = typeof data?.at === "string" ? data.at : "";
  const subject =
    typeof data?.toolName === "string" && data.toolName.length > 0
      ? ` "${data.toolName}"`
      : typeof data?.target === "string" && data.target.length > 0
        ? ` ${data.target}`
        : "";
  const body = `${kind}${subject}`;
  return `[control plane] diagnostic: ${body}${at ? ` (${at})` : ""}`;
}

export type DiagnosticTone = "dim" | "warning" | "success" | "error";
export interface DiagnosticRow {
  glyph: "○" | "◐" | "✓" | "✗";
  tone: DiagnosticTone;
  label: string;
  subject: string;
  at: string;
}

/** kind -> [glyph, tone, sentence-case label]. Unknown kinds render pending. */
const DIAGNOSTIC_LABELS: Record<string, [DiagnosticRow["glyph"], DiagnosticTone, string]> = {
  "blocked-read-before-edit": ["✗", "error", "Blocked: read before edit"],
  "read-out-of-scope-denied": ["✗", "error", "Read out of scope"],
  "backup-before-edit-failed": ["✗", "error", "Backup failed"],
  "advisor-budget-blocked": ["✗", "error", "Advisor budget blocked"],
  "advisor-consult": ["◐", "warning", "Advisor consult"],
  "backup-before-edit": ["✓", "success", "Backup before edit"],
  "advisor-budget-lifted": ["✓", "success", "Advisor budget lifted"],
  "unattended-call-allowed": ["✓", "success", "Unattended call allowed"],
  "remembered-rule-added": ["✓", "success", "Rule remembered"],
  "remembered-rule-allow": ["✓", "success", "Rule allowed"],
  "remembered-rule-revoked": ["✓", "success", "Rule revoked"],
  "remembered-rules-cleared": ["✓", "success", "Rules cleared"],
  "phase-switch-via-dialog": ["✓", "success", "Phase switched"],
};

/** Visual form of a diagnostic entry (transcript row and alt+i panel). */
export function describeDiagnostic(data: Record<string, unknown> | undefined): DiagnosticRow {
  const kind = typeof data?.kind === "string" ? data.kind : "diagnostic";
  const [glyph, tone, label] = DIAGNOSTIC_LABELS[kind] ?? ["○", "dim", kind];
  const subject =
    typeof data?.toolName === "string" && data.toolName.length > 0
      ? `"${data.toolName}"`
      : typeof data?.target === "string" && data.target.length > 0
        ? data.target
        : "";
  return { glyph, tone, label, subject, at: typeof data?.at === "string" ? data.at : "" };
}

/** Component shapes the diagnostic entry renderer needs from pi-tui. */
export interface DiagnosticEntryComponents {
  Box: new (px?: number, py?: number, bgFn?: (s: string) => string) => { addChild(c: unknown): void };
  Text: new (text: string, px?: number, py?: number) => unknown;
  Container: new () => { addChild(c: unknown): void };
  Spacer: new (lines?: number) => unknown;
}

/**
 * One opaque transcript row per diagnostic (Box with the customMessageBg
 * background) followed by one blank line. Text wraps char-by-char inside Pi,
 * so no explicit clip is needed here.
 */
export function buildDiagnosticEntry(
  data: Record<string, unknown> | undefined,
  theme: { fg(color: string, text: string): string; bg?(color: string, text: string): string },
  c: DiagnosticEntryComponents,
): unknown {
  const row = describeDiagnostic(data);
  const bg = typeof theme.bg === "function" ? (s: string) => theme.bg!("customMessageBg", s) : undefined;
  const box = new c.Box(1, 0, bg);
  box.addChild(
    new c.Text(
      `${theme.fg(row.tone, row.glyph)} ${theme.fg("text", row.label)}` +
        (row.subject ? ` ${theme.fg("text", row.subject)}` : "") +
        (row.at ? `  ${theme.fg("muted", row.at)}` : ""),
      0,
      0,
    ),
  );
  const container = new c.Container();
  container.addChild(box);
  container.addChild(new c.Spacer(1));
  return container;
}

/**
 * Terminal-safe width for a confirm-dialog body line. Base pi renders a dialog
 * body line-for-line and its top-level doRender THROWS (uncaughtException, pi
 * exits) if any rendered line exceeds the terminal width, so every body line
 * must be clamped to fit. The margin covers the dialog box's own chrome/indent.
 */
export function safeDialogWidth(columns: number | undefined = process.stdout.columns): number {
  return Math.max(24, (columns ?? 80) - 8);
}

/**
 * Truncate each line of a plain-text dialog body to `maxWidth` visible columns
 * (unicode-aware, ellipsized), so no single line can overflow the terminal and
 * crash the renderer. Replaces the old fixed 200-char command cap, which
 * ignored the terminal width and the "Command: " prefix and so still produced
 * ~209-wide lines that crashed on any terminal narrower than that.
 */
export function clampBodyLines(body: string, maxWidth: number): string {
  return body
    .split("\n")
    .map((line) => {
      const chars = Array.from(line);
      return chars.length > maxWidth ? chars.slice(0, Math.max(1, maxWidth - 1)).join("") + "…" : line;
    })
    .join("\n");
}

/**
 * The body shown in an attended confirm dialog. Only prints fields that are
 * actually meaningful: the "Inside project root" line appears solely when a
 * target resolved to a boolean (a tool with no file target omits it rather than
 * printing "Unavailable"); a tool with neither a path nor a command says
 * "no file target" plainly. The permanently-unavailable "Model's stated reason"
 * line is gone - a field that is never available is noise in every confirm.
 * Every line is clamped to `maxWidth` so a long command or path can never
 * overflow the terminal and crash the renderer.
 */
export function formatConfirmDetail(
  args: {
    toolName: string;
    riskCategory: string;
    path: string | null;
    command: string | null;
    insideRoot: boolean | null;
    reason: string;
  },
  maxWidth: number = safeDialogWidth(),
): string {
  const { toolName, riskCategory, path, command, insideRoot, reason } = args;
  const body = [
    `Tool: ${toolName}`,
    `Risk: ${riskCategory}`,
    path !== null
      ? `Target: ${path}`
      : command === null
        ? "Target: no file target"
        : null,
    command !== null ? `Command: ${command}` : null,
    insideRoot !== null ? `Inside project root: ${insideRoot ? "yes" : "no"}` : null,
    "",
    reason,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return clampBodyLines(body, maxWidth);
}

export default async function controlPlaneExtension(pi: ExtensionAPI) {
  // Pi-provided modules are imported dynamically so the entry can also be
  // loaded by the unit-test harness outside of Pi. Inside Pi both imports
  // resolve; outside, the affected features degrade explicitly (skill toggles
  // report as not applied, entry renderers render nothing).
  let formatSkillsForPrompt: ((skills: { name: string; description: string }[]) => string) | null = null;
  let Box: DiagnosticEntryComponents["Box"] | null = null;
  let Text: DiagnosticEntryComponents["Text"] | null = null;
  let Container: DiagnosticEntryComponents["Container"] | null = null;
  let Spacer: DiagnosticEntryComponents["Spacer"] | null = null;
  let matchesKey: ((data: string, keyId: string) => boolean) | null = null;
  let visibleWidth: ((text: string) => number) | null = null;
  let truncateToWidth: ((text: string, width: number, ellipsis?: string) => string) | null = null;
  // For the three-option attended dialog (Yes once / No / Always). Same
  // dynamic-import-with-fallback posture as the tui imports below: null under
  // the unit-test harness (where these packages are not resolvable), in which
  // case the attended gate falls back to a plain yes/no confirm.
  type SelectListItem = { value: string; label: string; description?: string };
  interface SelectListLike {
    onSelect?: (item: SelectListItem) => void;
    onCancel?: () => void;
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
  }
  let SelectListCtor:
    | (new (items: SelectListItem[], maxVisible: number, theme?: unknown) => SelectListLike)
    | null = null;
  let getSelectListThemeFn: (() => unknown) | null = null;
  try {
    const piPkg = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      formatSkillsForPrompt: typeof formatSkillsForPrompt;
      getSelectListTheme?: () => unknown;
    };
    formatSkillsForPrompt = piPkg.formatSkillsForPrompt;
    getSelectListThemeFn = piPkg.getSelectListTheme ?? null;
  } catch {
    formatSkillsForPrompt = null;
    getSelectListThemeFn = null;
  }
  try {
    const tui = (await import("@earendil-works/pi-tui")) as unknown as {
      Box: typeof Box;
      Text: typeof Text;
      Container: typeof Container;
      Spacer: typeof Spacer;
      matchesKey: (data: string, keyId: string) => boolean;
      visibleWidth: (text: string) => number;
      truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
      SelectList?: typeof SelectListCtor;
    };
    Box = tui.Box;
    Text = tui.Text;
    Container = tui.Container;
    Spacer = tui.Spacer;
    matchesKey = tui.matchesKey;
    visibleWidth = tui.visibleWidth;
    truncateToWidth = tui.truncateToWidth;
    SelectListCtor = tui.SelectList ?? null;
  } catch {
    Box = null;
    Text = null;
    Container = null;
    Spacer = null;
    matchesKey = null;
    visibleWidth = null;
    truncateToWidth = null;
    SelectListCtor = null;
  }
  // Width invariant: base pi's doRender throws (and pi exits) on any rendered
  // line wider than the terminal, so every render(width) below returns lines
  // that went through clipLine/clipLines. Cell-aware inside Pi; plain
  // character fallback under the unit-test harness.
  const measureWidth = (text: string): number =>
    visibleWidth !== null ? visibleWidth(text) : Array.from(text).length;
  const clipLine = (text: string, max: number, ellipsis = "…"): string =>
    truncateToWidth !== null ? truncateToWidth(text, max, ellipsis) : Array.from(text).slice(0, max).join("");
  const clipLines = (lines: string[], width: number): string[] =>
    width <= 0 ? [] : lines.map((line) => clipLine(line, width));
  // TypeBox backs pi.registerTool()'s parameter schema. Same
  // dynamic-import-with-fallback pattern as the two imports above: if it
  // cannot be resolved (e.g. under the unit-test harness, outside Pi), the
  // web_search tool is simply not registered rather than throwing at load.
  let TypeBoxType: Record<string, (...args: never[]) => unknown> | null = null;
  try {
    const typebox = (await import("typebox")) as unknown as { Type: typeof TypeBoxType };
    TypeBoxType = typebox.Type;
  } catch {
    TypeBoxType = null;
  }

  /** Key matching that works under both legacy escape codes and the kitty
   * keyboard protocol (pi enables kitty in supporting terminals, where e.g.
   * escape arrives as a CSI-u sequence, not a bare \x1b). */
  const keyIs = (data: string, keyId: string, legacy: string[]): boolean => {
    if (matchesKey !== null) {
      try {
        if (matchesKey(data, keyId)) return true;
      } catch {
        // fall through to legacy comparison
      }
    }
    return legacy.includes(data);
  };

  let state: ControlPlaneState = defaultState();
  let scratchpad: ScratchpadState = emptyScratchpad();
  let rememberedRules: RememberedRulesState = emptyRules();
  let sandbox: SandboxState = emptySandboxState();
  /** Cached bwrap-on-PATH check (spawnSync is not free; the binary does not
   * appear or disappear mid-session). Null = not checked yet. */
  let bwrapAvailableCache: boolean | null = null;
  let policy: RestrictedPolicy | null = null;
  let policyLoadError: string | null = null;
  let lastPayloadMeta: { length: number; hash: string } | null = null;
  let projectRoot: string | null = null;
  let widgetVisible = false;
  let hotkeysModalOpen = false;
  // Context-editor state (memory only; raw context is never persisted).
  let lastContextMessages: MessageLike[] | null = null;
  /** Length of the live (unmerged) conversation at the last context event. */
  let lastIncomingCount = 0;
  let lastBaseSystemPrompt: string | null = null;
  let contextOverlay: Overlay | null = null;
  // Read-before-edit read-set (memory only, never persisted): resolved absolute
  // paths this session has actually read via the `read` tool, each mapped to the
  // file's mtimeMs at read time. The stamp is refreshed when this session's own
  // edit/write completes (see refreshReadCredit), so the model's own edits never
  // look like external staleness. A restart clears it, so a fresh session must
  // re-read before it may modify — the safe direction. This set is per
  // control-plane activation: a separate session (e.g. an isolated delegate)
  // starts empty and inherits no read credit from any other session.
  const readSet = new Map<string, number>();
  // Advisor-consult budget (soft policy, memory-only). A read-only advisor
  // (harness_delegate kind:"advisor") is a cloud model - each consult costs
  // quota and latency, and a tool-eager coordinator consults freely during
  // routine work. This caps consults per session: the first
  // ADVISOR_CONSULTS_PER_TASK are silent, further consults hit the attended
  // Yes/No/Always gate. "Always" lifts the cap for the rest of the session. A
  // restart resets it (the safe direction). It only ever downgrades the
  // attended per-call path for advisor consults and never loosens a hard
  // block (phase/restricted/unattended).
  const ADVISOR_CONSULTS_PER_TASK = 1;
  let advisorConsultsThisTask = 0;
  let advisorBudgetTaskKey: string | null = null;
  let advisorBudgetLifted = false;
  // Exact token counting (memory only; raw payloads are never persisted).
  let lastProviderRequest: { payload: unknown; model: string; baseUrl: string } | null = null;
  let lastTokenCount: TokenCountResult | null = null;
  let tokenCountInFlight = false;

  const jsonFetch: JsonFetch = async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    return { ok: res.ok, json: () => res.json() as Promise<unknown> };
  };

  // Highest warning level already notified; re-warned only after usage drops
  // back below the warn threshold (e.g. after /compact) or on session start.
  let contextWarnedLevel: "urgent" | "warn" | null = null;

  const checkContextThreshold = (ctx: ExtensionContext | ExtensionCommandContext): void => {
    if (lastTokenCount === null) return;
    const window = ctx.getContextUsage()?.contextWindow ?? 0;
    if (window <= 0) return;
    const level = contextWarningLevel((lastTokenCount.tokens / window) * 100);
    if (level === null) {
      contextWarnedLevel = null;
      return;
    }
    const rank = { warn: 1, urgent: 2 };
    if (contextWarnedLevel !== null && rank[contextWarnedLevel] >= rank[level]) return;
    contextWarnedLevel = level;
    ctx.ui.notify(
      formatContextWarning(level, lastTokenCount.tokens, window),
      level === "urgent" ? "error" : "warning",
    );
  };

  // Forward-looking count: what the NEXT request will carry (system prompt +
  // injection block + full history + active tool definitions), counted by the
  // model's tokenizer while the agent is idle. The serialization approximates
  // the provider wire format, so the value is shown with "~".
  let prospectiveCount: { tokens: number; countedAt: string } | null = null;
  let prospectiveInFlight = false;
  /** Messages produced since the last provider request (assistant replies),
   * appended to the real last payload for the forward-looking count. */
  let messagesSinceLastRequest: Array<{ role: string; content: string }> = [];

  const refreshProspectiveCount = async (
    ctx: ExtensionContext | ExtensionCommandContext,
  ): Promise<void> => {
    if (prospectiveInFlight) return;
    const model = ctx.model as { id?: string; baseUrl?: string } | undefined;
    if (typeof model?.id !== "string" || typeof model.baseUrl !== "string") return;
    let payload: unknown;
    // Preferred: the REAL last request payload (pi's exact wire format) plus
    // whatever arrived since — no reconstruction error. Falls back to
    // rebuilding from scratch before the first request of a session.
    if (lastProviderRequest !== null && lastProviderRequest.model === model.id) {
      const base = lastProviderRequest.payload as { messages?: unknown[] };
      if (Array.isArray(base.messages)) {
        payload = {
          ...(lastProviderRequest.payload as Record<string, unknown>),
          messages: [...base.messages, ...messagesSinceLastRequest],
        };
      }
    }
    if (payload === undefined) {
      try {
        const system =
          ctx.getSystemPrompt() + "\n\n" + buildInjectionBlock(state, policy !== null);
        const messages: Array<{ role: string; content: string }> = [
          { role: "system", content: system },
        ];
        for (const entry of ctx.sessionManager.getBranch() as unknown as Array<{
          type: string;
          message?: { role?: string; content?: unknown };
        }>) {
          if (entry.type === "message" && entry.message !== undefined) {
            messages.push(serializeForCounting(entry.message));
          }
        }
        const active = new Set(pi.getActiveTools());
        const tools = pi
          .getAllTools()
          .filter((t) => active.has(t.name))
          .map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }));
        payload = { messages, tools };
      } catch {
        return;
      }
    }
    prospectiveInFlight = true;
    try {
      const result = await countPayloadTokens(model.baseUrl, model.id, payload, jsonFetch);
      if (result !== null) {
        prospectiveCount = { tokens: result.tokens, countedAt: result.countedAt };
      }
    } finally {
      prospectiveInFlight = false;
    }
  };

  const refreshTokenCount = async (
    ctx: ExtensionContext | ExtensionCommandContext | null = null,
  ): Promise<void> => {
    if (tokenCountInFlight || lastProviderRequest === null) return;
    tokenCountInFlight = true;
    try {
      const req = lastProviderRequest;
      const result = await countPayloadTokens(req.baseUrl, req.model, req.payload, jsonFetch);
      if (result !== null) {
        lastTokenCount = result;
        if (ctx !== null) checkContextThreshold(ctx);
      }
    } finally {
      tokenCountInFlight = false;
    }
  };

  const pathOps: PathOps = {
    realpath: (p) => fs.realpathSync(p),
    exists: (p) => fs.existsSync(p),
  };

  /** Canonical path of Pi's agent directory,
   * which reads freely (Pi reading its own skills/config is not exfil). Computed
   * from PI_CODING_AGENT_DIR, then PI_HARNESS_HOME, else ~/.pi/agent.
   * Cached; null only if it cannot be resolved. */
  let agentDirCache: string | null | undefined;
  const agentDir = (): string | null => {
    if (agentDirCache !== undefined) return agentDirCache;
    const explicit = process.env.PI_CODING_AGENT_DIR?.trim();
    const configured = explicit
      ? explicit
      : path.join(process.env.PI_HARNESS_HOME?.trim() || path.join(os.homedir(), ".pi"), "agent");
    agentDirCache = canonicalizePath(configured, os.homedir(), pathOps);
    return agentDirCache;
  };

  /** Sensitive-read denylist extensions drawn from the Restricted policy's deny
   * patterns, so the list is configurable via policy/default-policy.json on top
   * of the built-in defaults. */
  const sensitiveReadExtra = (): SensitiveReadExtra =>
    policy === null
      ? {}
      : { basenames: policy.denyPathBasenames, pathSubstrings: policy.denyPathSubstrings };

  /** mtimeMs of a file, or null if it cannot be stat'd. */
  const mtimeOf = (canonical: string): number | null => {
    try {
      return fs.statSync(canonical).mtimeMs;
    } catch {
      return null;
    }
  };

  /**
   * Record read credit for the `read` tool: an existing file the coordinator
   * actually read this session, stamped with its current mtime. Only the read
   * tool grants credit (grep/find/ls enumerate, they do not establish that a
   * specific file's contents were seen). Called when a read is permitted.
   */
  const recordReadCredit = (event: ToolCallEvent, ctx: ExtensionContext): void => {
    if (event.toolName !== "read") return;
    const rawPath = (event.input as Record<string, unknown>).path;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) return;
    const canonical = canonicalizePath(rawPath, ctx.cwd, pathOps);
    if (canonical === null || !fs.existsSync(canonical)) return;
    const mtime = mtimeOf(canonical);
    if (mtime !== null) readSet.set(canonical, mtime);
  };

  /**
   * Refresh read credit for the `edit`/`write` tools: a successful tool_result
   * for a MUTATE-class call means this session itself changed the file — the
   * model authored the change, so the content is still "seen". Restamping the
   * recorded mtime keeps the NEXT edit of the same file from tripping the
   * stale branch ("changed on disk since read") when the only change was the
   * model's own permitted edit. Only files that already carry read credit are
   * restamped — a completed write grants no new credit. A FAILED edit is not
   * restamped: it may have half-applied on disk, so a re-read is the safe
   * direction. True external modifications (anything other than this session's
   * own tool calls) still change the mtime without a restamp and stay caught.
   */
  const refreshReadCredit = (event: ToolResultEvent, ctx: ExtensionContext): void => {
    if (classifyTool(event.toolName) !== "mutate") return;
    if (event.isError) return;
    const rawPath = (event.input as Record<string, unknown>).path;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) return;
    const canonical = canonicalizePath(rawPath, ctx.cwd, pathOps);
    if (canonical === null || !readSet.has(canonical)) return;
    const mtime = mtimeOf(canonical);
    if (mtime !== null) readSet.set(canonical, mtime);
  };

  // Per-control-plane-activation backup identity: a tag for naming and a
  // resolved root directory. One (tag, root) pair per activation means a file
  // edited N times in one session yields ONE backup (the pre-first-edit state),
  // while the same file edited across two sessions yields two backups (each
  // session's pre-edit state). Both are memory-only and minted ONCE when this
  // extension instance is created, so a restart starts fresh and never reuses an
  // old activation's backups.
  //
  // The root is resolved at EXTENSION INIT, not lazily per decision and not at
  // session_start. This closure is created exactly once per control-plane
  // activation (one `controlPlaneExtension(pi)` call), so capturing the env here
  // pins the destination for the whole activation — matching the sessionTag. It
  // also matches the test fixture, which sets PI_BACKUP_DIR only around boot()
  // (i.e. around this very init) and restores it before session_start fires; a
  // decision-time or session_start read would see the env after restore and fall
  // back to the real ~/.pi/backups (spilling real backups into the user's home).
  const backupSessionTag = `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const backupRoot = defaultBackupRoot();

  /**
   * Backup-before-edit: snapshot an existing file's pre-mutation bytes to a
   * durable, reviewable location BEFORE the mutation proceeds. Returns undefined
   * on success (or when exempt), or { block, reason } on failure — fail-closed,
   * so a mutation never runs without a recoverable pre-image.
   *
   * Only called from handleDecision for mutate-class tools (edit/write) whose
   * target is an existing file, after read-before-edit has already passed and
   * the policy decision allows/approves the call, immediately before the sandbox.
   * The copy is written by THIS process on the host fs (not inside any bwrap
   * child), so it is unaffected by the read-only scope mount.
   */
  const takeBackup = (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): { block: true; reason: string } | undefined => {
    if (classifyTool(event.toolName) !== "mutate") return undefined;
    const rawPath = (event.input as Record<string, unknown>).path;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) return undefined;
    const canonical = canonicalizePath(rawPath, ctx.cwd, pathOps);
    if (canonical === null) return undefined; // unresolvable: the normal policy path handles it
    const plan = planBackup(canonical, backupSessionTag, backupRoot, { exists: (p) => fs.existsSync(p) });
    if (plan === null) return undefined; // new file: nothing to back up (exempt)
    try {
      const targetPath = resolveNonCollidingPath(plan.targetPath, { exists: (p) => fs.existsSync(p) });
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(canonical, targetPath);
      const bytes = fs.statSync(targetPath).size;
      pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
        kind: "backup-before-edit",
        toolName: event.toolName,
        target: canonical,
        backupPath: targetPath,
        sessionTag: backupSessionTag,
        bytes,
        at: new Date().toISOString(),
      });
      return undefined;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
        kind: "backup-before-edit-failed",
        toolName: event.toolName,
        target: canonical,
        sessionTag: backupSessionTag,
        error: msg,
        at: new Date().toISOString(),
      });
      // Warn-and-proceed: a failed pre-image snapshot no longer blocks the
      // edit. In a git repo the working tree already carries the pre-image, so
      // failing closed here mostly duplicated git while interrupting flow. The
      // failure is still recorded (diagnostic above) and surfaced to the user;
      // outside version control the warning is the signal to check the disk.
      ctx.ui.notify(
        `[control plane] backup-before-edit could not snapshot "${canonical}" (${msg}); ` +
          `proceeding without a pre-image. Rely on git/undo, or fix the backup path/disk.`,
        "warning",
      );
      return undefined;
    }
  };

  /**
   * Read-before-edit hard rule: an edit/write-class call targeting an EXISTING
   * file must have read that exact file this session, and the file must not have
   * changed on disk since (mtime match) — an external modification requires a
   * re-read. The session's own successful edit/write refreshes the stamp (see
   * refreshReadCredit), so only changes made outside this session's tool calls
   * count as stale. Returns the violation (with the canonical target) or null.
   *
   * Scope is exactly read-before-mutate: shell (bash) is not covered (the peer
   * scoped this to edit/write-class tools; shell mutation is out of scope),
   * unknown tools are not covered, and creating a NEW file is exempt (there is
   * nothing to read). Harness-mediated append-only records (audit, proposals)
   * are written through pi.appendEntry, not the generic write tool, so they
   * never reach this rule.
   */
  const readBeforeEditViolation = (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): { canonical: string; stale: boolean } | null => {
    if (classifyTool(event.toolName) !== "mutate") return null;
    const rawPath = (event.input as Record<string, unknown>).path;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) return null;
    const canonical = canonicalizePath(rawPath, ctx.cwd, pathOps);
    if (canonical === null) return null; // unresolvable target: handled by the normal policy path
    if (!fs.existsSync(canonical)) return null; // creating a new file: nothing to read
    const recorded = readSet.get(canonical);
    if (recorded === undefined) return { canonical, stale: false };
    const current = mtimeOf(canonical);
    if (current === null || current !== recorded) return { canonical, stale: true };
    return null;
  };

  // ---- profiles loading (invalid file -> profiles unavailable; safety unaffected) ----
  let profilesConfig: ProfilesConfig | null = null;
  let profilesLoadError: string | null = null;
  const profilesPath = fileURLToPath(new URL("../policy/profiles.json", import.meta.url));
  try {
    profilesConfig = validateProfiles(JSON.parse(fs.readFileSync(profilesPath, "utf8")));
    if (profilesConfig === null) {
      profilesLoadError = "policy/profiles.json failed validation; /context profile is unavailable.";
    }
  } catch (error) {
    profilesLoadError = `policy/profiles.json could not be loaded (${String(error)}); /context profile is unavailable.`;
  }

  // ---- policy loading (fail closed: invalid policy -> null -> Read-only) ----
  try {
    const policyPath = fileURLToPath(new URL("../policy/default-policy.json", import.meta.url));
    const raw = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    policy = validatePolicy(raw);
    if (policy === null) {
      policyLoadError = "policy/default-policy.json failed validation; Restricted mode will fall back to Read-only.";
    }
  } catch (error) {
    policy = null;
    policyLoadError = `policy/default-policy.json could not be loaded (${String(error)}); Restricted mode will fall back to Read-only.`;
  }

  // ---- helpers ----

  const rootOf = (ctx: ExtensionContext): string => {
    if (projectRoot === null) {
      try {
        projectRoot = fs.realpathSync(ctx.cwd);
      } catch {
        projectRoot = ctx.cwd;
      }
    }
    return projectRoot;
  };

  const persist = () => {
    state.updatedAt = new Date().toISOString();
    pi.appendEntry(STATE_ENTRY_TYPE, state);
  };

  const persistScratchpad = () => {
    scratchpad.updatedAt = new Date().toISOString();
    pi.appendEntry(SCRATCHPAD_ENTRY_TYPE, scratchpad);
  };

  const persistRules = () => {
    rememberedRules.updatedAt = new Date().toISOString();
    pi.appendEntry(RULES_ENTRY_TYPE, rememberedRules);
  };

  const persistTiming = () => {
    timing.updatedAt = new Date().toISOString();
    pi.appendEntry(TIMING_ENTRY_TYPE, timing);
  };

  let todoWorkspace: string | null = null;
  const persistTodo = (ctx?: ExtensionContext) => {
    todo.updatedAt = new Date().toISOString();
    pi.appendEntry(TODO_ENTRY_TYPE, todo);
    if (todoWorkspace !== null) {
      const error = writeWorkspaceTodo(todoWorkspace, todo);
      if (error !== null && ctx !== undefined) {
        ctx.ui.notify(`Control plane: task list could not be saved across sessions (${error}).`, "warning");
      }
    }
  };

  const persistSandbox = () => {
    sandbox.updatedAt = new Date().toISOString();
    pi.appendEntry(SANDBOX_ENTRY_TYPE, sandbox);
  };

  const updateStatus = (ctx: ExtensionContext) => {
    const percent = ctx.getContextUsage()?.percent ?? null;
    const base = formatStatus(state, percent, policy !== null, describeSandbox(sandbox));
    ctx.ui.setStatus(STATUS_KEY, contextOverlay !== null ? `${base} | Context edited` : base);
  };

  const isBwrapAvailable = (): boolean => {
    if (bwrapAvailableCache !== null) return bwrapAvailableCache;
    try {
      const result = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
      bwrapAvailableCache = result.error === undefined && result.status === 0;
    } catch {
      bwrapAvailableCache = false;
    }
    return bwrapAvailableCache;
  };

  /**
   * Resolve the bwrap invocation's path lists fresh on every call - same
   * "no caching, this module already does per-call fs work" posture as
   * tool-policy.ts's resolveAllowPrefixes, and for the same reason: the
   * project root, cwd, and $HOME's contents can all change between calls.
   *
   * roBindPaths: system toolchain directories plus $HOME, read-only, so
   * interpreters/package managers resolve inside the sandbox.
   * shadowDirs/shadowFiles: credential paths reused directly from
   * policy/default-policy.json (denyPathSubstrings, denyPathBasenames) so
   * this list never drifts from the one the read/edit/write tools already
   * enforce - see docs/SECURITY.md for what this does and does not cover
   * (basename patterns are only shadowed at $HOME's top level, not
   * everywhere on disk; the project root is bound read-write regardless,
   * same as bash's existing unsandboxed access to it today).
   */
  const sandboxOptionsFor = (ctx: ExtensionContext) => {
    const home = os.homedir();
    const systemDirs = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"];
    const roBindPaths = [...systemDirs.filter((p) => fs.existsSync(p)), ...(fs.existsSync(home) ? [home] : [])];
    const shadowDirs: string[] = [];
    const shadowFiles: string[] = [];
    if (policy !== null) {
      const candidates = new Set<string>();
      for (const sub of policy.denyPathSubstrings) {
        const trimmed = sub.replace(/^\/+/, "").replace(/\/+$/, "");
        if (trimmed.length > 0) candidates.add(path.join(home, trimmed));
      }
      for (const base of policy.denyPathBasenames) {
        candidates.add(path.join(home, base));
      }
      for (const candidate of candidates) {
        try {
          const st = fs.statSync(candidate);
          if (st.isDirectory()) shadowDirs.push(candidate);
          else shadowFiles.push(candidate);
        } catch {
          // Does not exist: nothing to shadow, same fail-closed-skip posture
          // as resolveAllowPrefixes.
        }
      }
    }
    return { projectRoot: rootOf(ctx), cwd: ctx.cwd, network: sandbox.network, roBindPaths, shadowDirs, shadowFiles };
  };

  // ---- readable footer ----
  // Replaces pi's compact stats line ("↑4.2k ↓30 R4.2k CH99.2% 8.6%/49k")
  // with plain words. Same data sources as pi's built-in footer; values the
  // extension cannot observe (e.g. the auto-compact toggle) are omitted, not
  // guessed.
  let footerInstalled = false;
  let detailedUI = false;
  let credits: CreditBalance | null = null;
  let promptStarted = 0;
  let firstTextMs: number | null = null;
  let creditTurn = 0;
  let lastCreditRefreshAt = 0;
  const creditRefreshIntervalMs = 5_000;
  const creditSettlementDelaysMs = [2_000, 5_000, 10_000, 20_000] as const;
  // Workload ledger: every completed turn (count, total model time, slowest,
  // recent) persisted as its own session entry so resumed sessions keep their
  // totals. Pure logic + rendering live in src/control-plane/turn-timing.ts.
  let timing = emptyTimingState();
  // Task tracking: the model's to-do list (todo tool + top-right widget),
  // persisted as its own session entry like the scratchpad. Pure logic in
  // src/control-plane/todo.ts.
  let todo = emptyTodoState();
  // Nonblocking: session_start constructs the balance poller and queues its
  // first lookup without awaiting network I/O. The footer therefore starts at
  // "loading" and resolves to the real balance without requiring a prompt.
  // before_agent_start calls ensureCredits defensively, then queues the prompt
  // baseline. Missing credentials or request failures become "unavailable".
  let creditsInit = false;
  const ensureCredits = (ctx: ExtensionContext): void => {
    if (creditsInit) return;
    creditsInit = true;
    credits = new CreditBalance(
      async () => {
        const key =
          process.env.OPENROUTER_MANAGEMENT_KEY ??
          process.env.OPENROUTER_API_KEY ??
          (await ctx.modelRegistry?.getApiKeyForProvider?.("openrouter"));
        if (!key) throw new Error("No OpenRouter credential");
        return readOpenRouterBalance(key);
      },
      // A refresh can resolve after a session replacement; a stale ctx makes
      // updateStatus throw. Guard it so a late poll never crashes the session.
      () => {
        try {
          updateStatus(ctx);
        } catch {
          /* ctx stale after session replacement */
        }
      },
    );
    void credits.refresh("idle");
  };
  const refreshCredits = (
    phase: "start" | "live" | "end",
    ctx: ExtensionContext,
    force = false,
  ): void => {
    ensureCredits(ctx);
    const now = Date.now();
    if (phase === "live" && !force && now - lastCreditRefreshAt < creditRefreshIntervalMs) return;
    lastCreditRefreshAt = now;
    void credits?.refresh(phase);
  };
  const scheduleCreditSettlement = (ctx: ExtensionContext, turn: number): void => {
    for (const delay of creditSettlementDelaysMs) {
      const timer = setTimeout(() => {
        if (creditTurn !== turn || promptStarted !== 0 || !credits?.needsReconciliation()) return;
        refreshCredits("live", ctx, true);
      }, delay);
      timer.unref();
    }
  };
  pi.on("message_update", (event, ctx) => {
    if (promptStarted && firstTextMs === null && event.assistantMessageEvent?.type === "text_delta") {
      firstTextMs = Date.now() - promptStarted;
    }
    if (promptStarted) refreshCredits("live", ctx);
  });
  pi.on("message_end", (event, ctx) => {
    const cost = openRouterMessageCost(event.message);
    if (cost === null) return;
    credits?.recordCost(cost);
    refreshCredits("live", ctx);
  });

  /** Cyberpunk footer accents ("footerYellow"/"footerPurple") are optional
   * custom theme tokens; themes without them (dark, light) fall back to
   * "muted" so the footer stays readable on stock themes. */
  const footerPaint = (theme: { fg(color: string, text: string): string }, token: string, text: string): string => {
    try {
      return theme.fg(token, text);
    } catch {
      return theme.fg("muted", text);
    }
  };

  // Compact footer uses one status row plus a contextual row only when needed.
  const installFooter = (ctx: ExtensionContext) => {
    if (footerInstalled) return;
    const ui = ctx.ui as unknown as {
      setFooter?: (
        factory: (
          tui: unknown,
          theme: { fg(color: string, text: string): string },
          footerData: {
            getGitBranch(): string | null;
            getExtensionStatuses(): ReadonlyMap<string, string>;
            getAvailableProviderCount(): number;
          },
        ) => { render(width: number): string[] },
      ) => void;
    };
    if (typeof ui.setFooter !== "function") return;
    const width = measureWidth;
    const clip = clipLine;
    footerInstalled = true;
    ui.setFooter((_tui, theme, footerData) => ({
      render: (cols: number): string[] => {
        if (!detailedUI) {
          if (cols <= 0) return [];
          const usage = ctx.getContextUsage();
          const exact = lastTokenCount !== null && lastTokenCount.model === ctx.model?.id;
          const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const percent = exact && window > 0
            ? (lastTokenCount!.tokens / window) * 100 : usage?.percent ?? null;
          const view = compactFooterState(state, policy !== null, percent, exact && window > 0);
          const lines: string[] = [];
          // Attention rows sit on the shared left grid (1-space pad) when room allows.
          const pad = cols >= 2 ? PAD : "";
          // Wrap attention text instead of clipping away the reason or action.
          const wrap = (text: string): string[] => {
            const rows: string[] = [];
            let row = "";
            const max = cols - pad.length;
            for (const char of text) {
              if (width(row + char) > max) {
                if (row) rows.push(row);
                row = "";
              }
              if (width(char) <= max) row += char;
            }
            if (row) rows.push(row);
            return rows;
          };
          for (const message of view.attention) {
            lines.push(...wrap(message.text).map((line) => pad + theme.fg(message.color, line)));
          }
          const home = process.env.HOME ?? "";
          let cwd = ctx.sessionManager.getCwd();
          if (home !== "" && (cwd === home || cwd.startsWith(`${home}/`))) {
            cwd = cwd === home ? "~" : `~${cwd.slice(home.length)}`;
          }
          const model = ctx.model?.id ?? "No model";
          const statusWidth = cols;
          // Absolute usage against the loaded model's window ("ctx ~42k/1.0M")
          // rather than a bare percent, so the window size is always visible.
          // `percent` is still computed above and drives the warning colour.
          const usedTokens = exact && window > 0 ? lastTokenCount!.tokens : usage?.tokens ?? null;
          const contextValue =
            usedTokens === null
              ? "?"
              : window > 0
                ? `${exact ? "" : "~"}${formatTokenCount(usedTokens)}/${formatTokenCount(window)}`
                : `${exact ? "" : "~"}${formatTokenCount(usedTokens)}`;
          const level = percent === null ? null : contextWarningLevel(percent);
          const contextPainted =
            level === "urgent" ? theme.fg("error", `ctx ${contextValue}`)
              : level === "warn" ? theme.fg("warning", `ctx ${contextValue}`)
                : theme.fg("muted", `ctx ${contextValue}`);
          // Natural-width status line. Preserve cwd and model whenever the terminal has room.
          // Anchor-accent palette: a quiet muted/dim baseline carrying exactly
          // one bright accent per element — cyan mode, neon-yellow model +
          // thinking level, purple balance + Δ. ctx keeps its semantic
          // warn/error colours under pressure.
          const separator = theme.fg("dim", "  ·  ");
          const creditsText = credits?.compact() ?? "OpenRouter loading";
          const creditsGap = creditsText.indexOf(" ");
          const creditsPainted = creditsGap === -1
            ? theme.fg("muted", creditsText)
            : theme.fg("muted", creditsText.slice(0, creditsGap)) +
              footerPaint(theme, "footerPurple", creditsText.slice(creditsGap));
          let modelPainted = footerPaint(theme, "footerYellow", model);
          if ((ctx.model as { reasoning?: boolean } | undefined)?.reasoning === true) {
            let thinking = "off";
            try {
              thinking = pi.getThinkingLevel();
            } catch {
              thinking = "off";
            }
            modelPainted += theme.fg("dim", " · ") +
              theme.fg("muted", "thinking ") + footerPaint(theme, "footerYellow", thinking);
          }
          const status =
            PAD + theme.fg("muted", cwd) + separator +
            theme.fg("accent", view.mode) + separator +
            contextPainted + separator + creditsPainted +
            separator + modelPainted + separator + theme.fg("dim", "alt+h help");
          lines.push(clip(status, statusWidth, "…"));
          const contextual = [describeSandbox(sandbox), contextOverlay !== null ? "Context edited" : ""];
          for (const [key, text] of footerData.getExtensionStatuses()) {
            // Known idle status adds no action; detailed view retains it verbatim.
            const plain = text.replace(/\x1b\[[0-9;:]*m/g, "").trim();
            if (key !== STATUS_KEY && plain && !/^LSP Inactive$/i.test(plain)) contextual.push(text);
          }
          // Preserve third-party status colors; omit the row when no context needs attention.
          const statuses = contextual.filter(Boolean).map((text) => text.replace(/[\r\n\t]/g, " "));
          if (statuses.length) lines.push(clip(PAD + statuses.join("  "), statusWidth, "…"));
          return lines;
        }
        // Cumulative token usage across the whole session, like pi's footer.
        let input = 0;
        let output = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        let cost = 0;
        let cacheHitPercent: number | null = null;
        for (const entry of ctx.sessionManager.getEntries() as unknown as Array<{
          type: string;
          message?: {
            role?: string;
            usage?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              cost?: { total?: number };
            };
          };
        }>) {
          if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
          const u = entry.message.usage;
          if (u === undefined) continue;
          input += u.input ?? 0;
          output += u.output ?? 0;
          cacheRead += u.cacheRead ?? 0;
          cacheWrite += u.cacheWrite ?? 0;
          cost += u.cost?.total ?? 0;
          const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          cacheHitPercent = prompt > 0 ? ((u.cacheRead ?? 0) / prompt) * 100 : null;
        }
        const usage = ctx.getContextUsage();
        const model = ctx.model as
          | { id?: string; provider?: string; reasoning?: boolean; contextWindow?: number }
          | undefined;
        const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
        const contextPercent = usage?.percent ?? null;
        const exactTokens =
          lastTokenCount !== null && lastTokenCount.model === model?.id ? lastTokenCount.tokens : null;
        const { stats, context } = formatFooterStats({
          input,
          output,
          cacheRead,
          cacheWrite,
          cost,
          cacheHitPercent,
          contextPercent,
          contextWindow,
          exactTokens,
        });

        // Line 1: cwd (+ git branch), like pi's footer.
        const home = process.env.HOME ?? "";
        let cwd = ctx.sessionManager.getCwd();
        if (home !== "" && (cwd === home || cwd.startsWith(`${home}/`))) {
          cwd = cwd === home ? "~" : `~${cwd.slice(home.length)}`;
        }
        const branch = footerData.getGitBranch();
        if (branch !== null) cwd = `${cwd} (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName !== undefined && sessionName !== "") cwd = `${cwd} • ${sessionName}`;
        const lineWidth = cols;
        const pwdLine = clip(
          theme.fg("muted", cwd),
          lineWidth,
          theme.fg("muted", "..."),
        );

        // Line 2: stats left, model right — same anchor-accent palette as the
        // compact footer: muted/dim baseline, neon-yellow model + thinking
        // level, purple balance, semantic warn/error on ctx under pressure.
        // The workload timer segment ("time 4m 12s · 9 turns") joins the
        // cumulative token stats once any turn has completed.
        const timeSegment = timingFooterSegment(timing);
        const leftPlain =
          [stats, ...(timeSegment.length > 0 ? [timeSegment] : []), context]
            .filter((part) => part.length > 0)
            .join(" · ") || context;
        const pct =
          exactTokens !== null && contextWindow > 0
            ? (exactTokens / contextWindow) * 100
            : (contextPercent ?? 0);
        const contextColored =
          contextWarningLevel(pct) === "urgent" ? theme.fg("error", context) : contextWarningLevel(pct) === "warn" ? theme.fg("warning", context) : null;
        let left =
          contextColored !== null
            ? (stats.length > 0 ? theme.fg("muted", `${stats} · `) : "") + contextColored
            : theme.fg("muted", leftPlain);
        let leftWidth = width(leftPlain);
        if (leftWidth > lineWidth) {
          left = clip(left, lineWidth, theme.fg("muted", "..."));
          leftWidth = lineWidth;
        }
        let right = footerPaint(theme, "footerYellow", model?.id ?? "no-model");
        if (model?.reasoning === true) {
          let level = "off";
          try {
            level = pi.getThinkingLevel();
          } catch {
            level = "off";
          }
          right += theme.fg("dim", " · ") +
            theme.fg("muted", "thinking ") + footerPaint(theme, "footerYellow", level);
        }
        if (footerData.getAvailableProviderCount() > 1 && model?.provider !== undefined) {
          const withProvider = theme.fg("muted", `(${model.provider}) `) + right;
          if (leftWidth + 2 + width(withProvider) <= lineWidth) right = withProvider;
        }
        let statsLine: string;
        if (leftWidth + 2 + width(right) <= lineWidth) {
          const padding = " ".repeat(lineWidth - leftWidth - width(right));
          statsLine = left + theme.fg("muted", padding) + right;
        } else {
          statsLine = left;
        }

        // Line 3: extension statuses (includes our own status segment).
        // Credits line carries the same anchor accents: "OpenRouter" label
        // muted, the balance + Δ value purple.
        const creditsDetail = credits?.text() ?? "OpenRouter loading";
        const creditsDetailGap = creditsDetail.indexOf(" ");
        const creditsDetailPainted = creditsDetailGap === -1
          ? theme.fg("muted", creditsDetail)
          : theme.fg("muted", creditsDetail.slice(0, creditsDetailGap)) +
            footerPaint(theme, "footerPurple", creditsDetail.slice(creditsDetailGap));
        const lines = [pwdLine, statsLine, clip(creditsDetailPainted, lineWidth, "…")];
        const statuses = Array.from(footerData.getExtensionStatuses().entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
        if (statuses.length > 0) {
          lines.push(clip(statuses.join(" "), lineWidth, theme.fg("muted", "...")));
        }
        return clipLines(lines, cols);
      },
    }));
  };

  // Native header stays in document flow: no overlay over conversation or approvals.
  let toolsHeaderInstalled = false;
  const installToolsHeader = (ctx: ExtensionContext) => {
    if (toolsHeaderInstalled || typeof ctx.ui.setHeader !== "function") return;
    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render: (width: number): string[] => {
        const lines = clipLines(
          renderActiveTools(
            pi.getActiveTools(),
            width,
            measureWidth,
            currentProfileForActiveTools(
              profilesConfig,
              pi.getAllTools().map((tool) => tool.name),
              pi.getActiveTools(),
            ) ?? "custom",
          ).map((line) => theme.fg("text", line)),
          width,
        );
        return lines;
      },
    }));
    toolsHeaderInstalled = true;
  };

  // Keep open work in a noncapturing top-right overlay. A zero-height widget
  // owns its lifecycle so Pi removes the overlay during UI/session reset.
  const TODO_WIDGET_KEY = "control-plane-todo";
  let todoWidgetTui: { requestRender(force?: boolean): void } | null = null;
  const installTodoWidget = (ctx: ExtensionContext) => {
    if (typeof ctx.ui.setWidget !== "function") return;
    ctx.ui.setWidget(
      TODO_WIDGET_KEY,
      (tui, theme) => {
        todoWidgetTui = tui;
        const component = {
          invalidate() {},
          render: (width: number): string[] => renderTodoWidget(
            todo,
            width,
            { fg: (color, text) => theme.fg(color, text) },
            { measure: measureWidth, clip: (text, max) => clipLine(text, max) },
          ),
        };
        const overlay = tui.showOverlay(component, {
          anchor: "top-right",
          width: 44,
          margin: { top: 1, right: 1 },
          nonCapturing: true,
          visible: (width, height) => todo.items.some((item) => !item.done) && width >= 48 && height >= 8,
        });
        return {
          invalidate() {},
          render: (): string[] => [],
          dispose() {
            overlay.hide();
            if (todoWidgetTui === tui) todoWidgetTui = null;
          },
        };
      },
      { placement: "aboveEditor" },
    );
  };
  const refreshTodoWidget = () => todoWidgetTui?.requestRender(true);

  // ---- draft token counter (bottom-right, under the input box) ----
  // A component-factory widget re-renders every TUI frame, so reading the
  // editor text in render() keeps the count live while typing. The count is an
  // estimate (~4 chars/token; no tokenizer is available in-process), hence "~".
  let draftCounterInstalled = false;

  const installDraftCounter = (ctx: ExtensionContext) => {
    if (draftCounterInstalled) return;
    const ui = ctx.ui as unknown as {
      getEditorText?: () => string;
      setWidget?: (
        key: string,
        content: (tui: unknown, theme: { fg(color: string, text: string): string }) => {
          render(width: number): string[];
        },
        options?: { placement?: string },
      ) => void;
    };
    if (typeof ui.setWidget !== "function" || typeof ui.getEditorText !== "function") return;
    draftCounterInstalled = true;
    ui.setWidget(
      "control-plane-draft-counter",
      (_tui, theme) => ({
        render: (width: number): string[] => {
          if (!detailedUI || width <= 0) return [];
          let draft = "";
          try {
            draft = ui.getEditorText?.() ?? "";
          } catch {
            draft = "";
          }
          // What accompanies the draft when it is sent. Preferred source: the
          // forward-looking pre-send count (model tokenizer over the NEXT
          // request's content, "~" because the serialization approximates the
          // wire format). Fallbacks: exact count of the last request, then
          // pi's estimate.
          let added: number | null = null;
          let exact = false;
          if (prospectiveCount !== null) {
            added = prospectiveCount.tokens;
          } else if (lastTokenCount !== null) {
            added = lastTokenCount.tokens;
            exact = true;
          } else {
            const tokens = ctx.getContextUsage()?.tokens;
            // 0 before the first request means "nothing measured yet", not zero.
            if (typeof tokens === "number" && tokens > 0) added = tokens;
          }
          return [
            theme.fg("muted", truncateToWidth?.(formatDraftCounter(draft, width), width) ?? formatDraftCounter(draft, width).slice(0, width)),
            theme.fg("muted", truncateToWidth?.(formatAddedContext(added, exact, width), width) ?? formatAddedContext(added, exact, width).slice(0, width)),
          ];
        },
      }),
      { placement: "belowEditor" },
    );
  };

  const clearOverlay = (ctx: ExtensionContext, reason: string) => {
    if (contextOverlay === null) return;
    contextOverlay = null;
    updateStatus(ctx);
    ctx.ui.notify(`Context override removed: ${reason}`, "info");
  };

  const emit = (title: string, lines: string[]) => {
    const capped =
      lines.length > LIMITS.outputLines
        ? [...lines.slice(0, LIMITS.outputLines), `[TRUNCATED: ${lines.length - LIMITS.outputLines} more lines]`]
        : lines;
    pi.appendEntry<OutputEntryData>(OUTPUT_ENTRY_TYPE, { title, lines: capped });
  };

  const messagesByRole = (ctx: ExtensionContext): { counts: Record<string, number>; total: number } => {
    const counts: Record<string, number> = {};
    let total = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message") {
        const role = (entry as { message?: { role?: string } }).message?.role ?? "unknown";
        counts[role] = (counts[role] ?? 0) + 1;
        total++;
      }
    }
    return { counts, total };
  };

  const buildCurrentSnapshot = (ctx: ExtensionCommandContext | ExtensionContext): ContextSnapshot => {
    const usage = ctx.getContextUsage();
    const model = ctx.model as
      | { id?: string; provider?: string; contextWindow?: number }
      | undefined;
    let options: { contextFiles?: { path: string; content: string }[]; skills?: { name: string; description: string }[] } | undefined;
    const maybeGet = (ctx as ExtensionCommandContext).getSystemPromptOptions;
    if (typeof maybeGet === "function") {
      try {
        options = maybeGet.call(ctx);
      } catch {
        options = undefined;
      }
    }
    const sources: SnapshotItem[] = [];
    for (const file of options?.contextFiles ?? []) {
      const name = toggleName.contextFile(file.path);
      sources.push({
        name,
        kind: "context-file",
        detail: file.path,
        enabled: state.sourceToggles[name] !== false,
        toggleable: true,
      });
    }
    for (const skill of options?.skills ?? []) {
      const name = toggleName.skill(skill.name);
      sources.push({
        name,
        kind: "skill",
        detail: skill.description,
        enabled: state.sourceToggles[name] !== false,
        toggleable: true,
      });
    }
    for (const command of pi.getCommands()) {
      if (command.source === "prompt") {
        sources.push({
          name: toggleName.template(command.name),
          kind: "prompt-template",
          detail: command.description,
          enabled: true,
          toggleable: false,
        });
      }
    }
    const activeTools = pi.getActiveTools();
    for (const tool of pi.getAllTools()) {
      sources.push({
        name: toggleName.tool(tool.name),
        kind: "tool",
        detail: tool.description.slice(0, 100),
        enabled: activeTools.includes(tool.name),
        toggleable: true,
      });
    }
    let redactedPrompt: string | null = null;
    try {
      redactedPrompt = redactSecrets(ctx.getSystemPrompt()).text;
    } catch {
      redactedPrompt = null;
    }
    const { counts, total } = messagesByRole(ctx);
    return buildSnapshot({
      timestamp: new Date().toISOString(),
      provider: model?.provider ?? null,
      model: model?.id ?? null,
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? null,
      tokens: usage?.tokens ?? null,
      percent: usage?.percent ?? null,
      messageCount: total,
      messagesByRole: counts,
      sources,
      tools: activeTools,
      redactedSystemPrompt: redactedPrompt,
      providerPayload: lastPayloadMeta,
      phase: state.phase,
      autonomy: state.autonomy,
    });
  };

  /** Re-apply persisted tool toggles after restore (incremental, additive-safe). */
  const reapplyToolToggles = () => {
    const disabled = Object.entries(state.sourceToggles)
      .filter(([name, enabled]) => name.startsWith("tool:") && enabled === false)
      .map(([name]) => name.slice("tool:".length));
    if (disabled.length === 0) return;
    const active = pi.getActiveTools().filter((t) => !disabled.includes(t));
    pi.setActiveTools(active);
  };

  const setMode = (ctx: ExtensionContext, mode: Mode, sandboxAlias: boolean) => {
    const { phase, autonomy } = stateForMode(mode);
    state.phase = phase;
    state.autonomy = autonomy;
    persist();
    updateStatus(ctx);
    if (sandboxAlias) {
      ctx.ui.notify(SANDBOX_ALIAS_WARNING, "warning");
    }
    if (mode === "auto" && policy === null) {
      ctx.ui.notify(
        "Auto selected but the policy failed to load/validate — enforcement falls back to read-only.",
        "warning",
      );
      return;
    }
    const note =
      phase === "execute" ? "" : " (mutating tools are blocked in this mode)";
    ctx.ui.notify(`Mode: ${displayMode(phase, autonomy, policy !== null)}${note}`, "info");
  };

  const knownToggleTargets = (ctx: ExtensionCommandContext): SnapshotItem[] =>
    buildCurrentSnapshot(ctx).sources;

  const resolveToggleTarget = (
    name: string,
    targets: SnapshotItem[],
  ): SnapshotItem | { error: string } => {
    const exact = targets.find((t) => t.name === name);
    if (exact) return exact;
    for (const prefix of ["tool:", "skill:", "file:", "template:"]) {
      const candidate = targets.find((t) => t.name === prefix + name);
      if (candidate) return candidate;
    }
    // Unique basename match for files.
    const fileMatches = targets.filter(
      (t) => t.kind === "context-file" && t.name.split("/").pop() === name,
    );
    if (fileMatches.length === 1) return fileMatches[0];
    const near = targets
      .filter((t) => t.name.toLowerCase().includes(name.toLowerCase()))
      .map((t) => t.name)
      .slice(0, 5);
    return {
      error:
        near.length > 0
          ? `Unknown source "${name}". Close matches: ${near.join(", ")}`
          : `Unknown source "${name}". Run /context sources to list toggleable sources.`,
    };
  };

  /**
   * Apply a profile by name ("all" included), then force alwaysDisabledTools
   * off on top - this always wins regardless of which profile was picked, so
   * a redundant tool disabled for a known reason (see policy/profiles.json)
   * can never come back just by switching profiles. Individually toggling
   * that exact tool back on via /context toggle afterward still works - this
   * only guards bulk profile application, not the explicit single-tool
   * escape hatch. Manual applications notify; fresh-session defaults are
   * already visible in the persistent header and skip duplicate transcript UI.
   */
  const applyNamedProfile = (
    ctx: ExtensionContext,
    name: string,
    options: { notify?: boolean } = {},
  ): boolean => {
    const shouldNotify = options.notify !== false;
    const allTools = pi.getAllTools().map((t) => t.name);
    const alwaysDisabledTools = profilesConfig?.alwaysDisabledTools ?? [];
    if (name === ALL_PROFILE) {
      const forced = applyAlwaysDisabled(clearToolToggles(state.sourceToggles), alwaysDisabledTools, allTools);
      state.sourceToggles = forced.toggles;
      pi.setActiveTools(allTools.filter((t) => !forced.newlyDisabled.includes(t)));
      persist();
      updateStatus(ctx);
      const forcedNote =
        forced.newlyDisabled.length > 0
          ? ` (${forced.newlyDisabled.join(", ")} kept off - see policy/profiles.json alwaysDisabledTools)`
          : "";
      if (shouldNotify) {
        ctx.ui.notify(
          `Profile "all": ${allTools.length - forced.newlyDisabled.length} tool(s) enabled.${forcedNote}`,
          "info",
        );
      }
      void refreshProspectiveCount(ctx);
      return true;
    }
    const profile = profilesConfig?.profiles[name];
    if (profile === undefined) {
      const known = [ALL_PROFILE, ...Object.keys(profilesConfig?.profiles ?? {})].join(", ");
      ctx.ui.notify(profilesLoadError ?? `Unknown profile "${name}". Available: ${known}`, "error");
      return false;
    }
    const result = applyProfile(profile.tools, allTools, state.sourceToggles);
    const forced = applyAlwaysDisabled(result.toggles, alwaysDisabledTools, allTools);
    state.sourceToggles = forced.toggles;
    pi.setActiveTools(result.enabled.filter((t) => !forced.newlyDisabled.includes(t)));
    persist();
    updateStatus(ctx);
    const enabledCount = result.enabled.length - forced.newlyDisabled.length;
    const disabledCount = result.disabled.length + forced.newlyDisabled.length;
    const missingNote =
      result.missing.length > 0
        ? ` Not present in this session (skipped): ${result.missing.join(", ")}.`
        : "";
    const forcedNote =
      forced.newlyDisabled.length > 0
        ? ` (${forced.newlyDisabled.join(", ")} kept off - see policy/profiles.json alwaysDisabledTools)`
        : "";
    if (shouldNotify) {
      ctx.ui.notify(
        `Profile "${name}": ${enabledCount} tool(s) enabled, ${disabledCount} disabled.${forcedNote}${missingNote}`,
        "info",
      );
    }
    void refreshProspectiveCount(ctx);
    return true;
  };

  /**
   * Persist a profile name as the default for fresh sessions by writing
   * "defaultProfile" back into policy/profiles.json. The file is re-validated
   * after the edit so an unexpected on-disk shape can never be made worse.
   */
  const setDefaultProfile = (ctx: ExtensionContext, name: string): boolean => {
    if (name !== ALL_PROFILE && profilesConfig?.profiles[name] === undefined) {
      ctx.ui.notify(profilesLoadError ?? `Unknown profile "${name}".`, "error");
      return false;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(profilesPath, "utf8")) as Record<string, unknown>;
      raw.defaultProfile = name;
      const revalidated = validateProfiles(raw);
      if (revalidated === null) {
        ctx.ui.notify(
          "policy/profiles.json on disk does not validate; default profile not saved.",
          "error",
        );
        return false;
      }
      fs.writeFileSync(profilesPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
      profilesConfig = revalidated;
      ctx.ui.notify(
        `Default profile is now "${name}" — new sessions will start with it.`,
        "info",
      );
      return true;
    } catch (error) {
      ctx.ui.notify(`Could not save default profile: ${String(error)}`, "error");
      return false;
    }
  };

  // ---- entry renderers (chat-visible output, excluded from LLM context) ----

  pi.registerEntryRenderer<OutputEntryData>(OUTPUT_ENTRY_TYPE, (entry, _options, theme) => {
    if (Box === null || Text === null) return undefined;
    const data = entry.data ?? { title: "control plane", lines: [] };
    const box = new Box(1, 0);
    box.addChild(new Text(theme.fg("accent", `[control plane] ${data.title}`), 0, 0));
    for (const line of data.lines) {
      box.addChild(new Text(line.length > 0 ? line : " ", 0, 0));
    }
    return box as never;
  });

  pi.registerEntryRenderer<TodoCompletionEntryData>(
    TODO_COMPLETION_ENTRY_TYPE,
    (entry, _options, theme) => {
      if (Text === null || typeof entry.data?.message !== "string") return undefined;
      return new Text(theme.fg("success", entry.data.message), 0, 0) as never;
    },
  );

  pi.registerEntryRenderer<Record<string, unknown>>(
    DIAGNOSTIC_ENTRY_TYPE,
    (entry, _options, theme) => {
      if (Box === null || Text === null || Container === null || Spacer === null) return undefined;
      return buildDiagnosticEntry(entry.data, theme, { Box, Text, Container, Spacer }) as never;
    },
  );

  // ---- session lifecycle ----

  pi.on("session_start", (_event, ctx) => {
    creditTurn++;
    const entries = ctx.sessionManager.getBranch() as unknown as CustomEntryLike[];
    const result = restoreFromEntries(entries, STATE_ENTRY_TYPE);
    state = result.state;
    if (result.ignoredMalformed > 0) {
      ctx.ui.notify(
        `Control plane: ignored ${result.ignoredMalformed} malformed state entr${result.ignoredMalformed === 1 ? "y" : "ies"}; ${result.restored ? "restored an earlier valid state" : "using safe defaults (Plan / read-only)"}.`,
        "warning",
      );
    }
    const scratchpadResult = restoreScratchpadFromEntries(entries, SCRATCHPAD_ENTRY_TYPE);
    scratchpad = scratchpadResult.scratchpad;
    if (scratchpadResult.ignoredMalformed > 0) {
      ctx.ui.notify(
        `Control plane: ignored ${scratchpadResult.ignoredMalformed} malformed scratchpad entr${scratchpadResult.ignoredMalformed === 1 ? "y" : "ies"}; ${scratchpadResult.restored ? "restored the latest valid scratchpad" : "starting with an empty scratchpad"}.`,
        "warning",
      );
    }
    const rulesResult = restoreRulesFromEntries(entries, RULES_ENTRY_TYPE);
    rememberedRules = rulesResult.rules;
    if (rulesResult.ignoredMalformed > 0) {
      ctx.ui.notify(
        `Control plane: ignored ${rulesResult.ignoredMalformed} malformed remembered-rule entr${rulesResult.ignoredMalformed === 1 ? "y" : "ies"}; ${rulesResult.restored ? "restored the latest valid rule set" : "starting with no remembered rules"}.`,
        "warning",
      );
    }
    const sandboxResult = restoreSandboxFromEntries(entries, SANDBOX_ENTRY_TYPE);
    sandbox = sandboxResult.sandbox;
    if (sandboxResult.ignoredMalformed > 0) {
      ctx.ui.notify(
        `Control plane: ignored ${sandboxResult.ignoredMalformed} malformed sandbox entr${sandboxResult.ignoredMalformed === 1 ? "y" : "ies"}; ${sandboxResult.restored ? "restored the latest valid sandbox setting" : "starting with the sandbox off"}.`,
        "warning",
      );
    }
    if (sandbox.enabled && !isBwrapAvailable()) {
      ctx.ui.notify(
        "Control plane: bwrap sandbox was enabled in this session but the `bwrap` binary is no longer on PATH. Bash calls will fail until it is reinstalled or /bwrap off is run.",
        "warning",
      );
    }
    const timingResult = restoreTimingFromEntries(entries, TIMING_ENTRY_TYPE);
    timing = timingResult.timing;
    if (timingResult.ignoredMalformed > 0) {
      ctx.ui.notify(
        `Control plane: ignored ${timingResult.ignoredMalformed} malformed timing entr${timingResult.ignoredMalformed === 1 ? "y" : "ies"}; starting the workload ledger from zero.`,
        "warning",
      );
    }
    const todoResult = restoreTodoFromEntries(entries, TODO_ENTRY_TYPE);
    todoWorkspace = rootOf(ctx);
    const workspaceTodo = readWorkspaceTodo(todoWorkspace);
    todo = newerTodo(todoResult.restored ? todoResult.todo : null, workspaceTodo.todo) ?? todoResult.todo;
    if (todoResult.ignoredMalformed > 0) {
      const recovery = todoResult.restored
        ? "restored the newest valid task list"
        : "starting with an empty task list";
      ctx.ui.notify(
        `Control plane: ignored ${todoResult.ignoredMalformed} malformed task entr${todoResult.ignoredMalformed === 1 ? "y" : "ies"}; ${recovery}.`,
        "warning",
      );
    }
    if (workspaceTodo.malformed) {
      ctx.ui.notify("Control plane: ignored malformed workspace task state; using session state or an empty list.", "warning");
    }
    if (todoResult.restored && todo === todoResult.todo && workspaceTodo.todo !== todo) {
      writeWorkspaceTodo(todoWorkspace, todo);
    }
    if (policyLoadError !== null) {
      ctx.ui.notify(`Control plane: ${policyLoadError}`, "warning");
    }
    reapplyToolToggles();
    // Fresh sessions (no saved control-plane state) start on the default
    // profile, if one is configured. Restored sessions keep their own toggles.
    const defaultProfile = profilesConfig?.defaultProfile ?? null;
    if (!result.restored && defaultProfile !== null && defaultProfile !== ALL_PROFILE) {
      applyNamedProfile(ctx, defaultProfile, { notify: false });
    } else if (!result.restored && (profilesConfig?.alwaysDisabledTools.length ?? 0) > 0) {
      // No named default profile ran above (none configured, or the default
      // is literally "all") - apply the always-disabled overlay on its own
      // so the invariant holds even without a profile in the loop. Restored
      // sessions are still left alone, same reasoning as applyNamedProfile.
      const allTools = pi.getAllTools().map((t) => t.name);
      const forced = applyAlwaysDisabled(state.sourceToggles, profilesConfig!.alwaysDisabledTools, allTools);
      if (forced.newlyDisabled.length > 0) {
        state.sourceToggles = forced.toggles;
        pi.setActiveTools(pi.getActiveTools().filter((t) => !forced.newlyDisabled.includes(t)));
        persist();
        ctx.ui.notify(
          `Control plane: ${forced.newlyDisabled.join(", ")} kept off by default (see policy/profiles.json alwaysDisabledTools).`,
          "info",
        );
      }
    }
    ctx.ui.setToolsExpanded?.(false);
    installToolsHeader(ctx);
    installTodoWidget(ctx);
    refreshTodoWidget();
    installFooter(ctx);
    installDraftCounter(ctx);
    ensureCredits(ctx);
    // Editor state is process/session scoped; a new or resumed session starts clean.
    contextOverlay = null;
    lastContextMessages = null;
    lastBaseSystemPrompt = null;
    lastProviderRequest = null;
    lastTokenCount = null;
    prospectiveCount = null;
    messagesSinceLastRequest = [];
    contextWarnedLevel = null;
    void refreshProspectiveCount(ctx);
    updateStatus(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    updateStatus(ctx);
    void refreshProspectiveCount(ctx);
    refreshCredits("live", ctx);
  });
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));

  // Branch navigation may reveal a newer session snapshot, but never discards
  // newer workspace state shared by other sessions/windows.
  pi.on("session_tree", (_event, ctx) => {
    const result = restoreTodoFromEntries(
      ctx.sessionManager.getBranch() as unknown as CustomEntryLike[],
      TODO_ENTRY_TYPE,
    );
    const workspaceTodo = todoWorkspace === null ? null : readWorkspaceTodo(todoWorkspace).todo;
    todo = newerTodo(result.restored ? result.todo : null, workspaceTodo) ?? todo;
    refreshTodoWidget();
  });

  // ---- context capture ----

  // Fires before every LLM call: capture the effective messages for the
  // context editor and apply any active override (edited prefix + live tail).
  pi.on("context", (event, ctx) => {
    const incoming = event.messages as unknown as MessageLike[];
    lastIncomingCount = incoming.length;
    if (contextOverlay !== null) {
      const merged = mergeOverlay(contextOverlay, incoming);
      if (!merged.ok) {
        clearOverlay(ctx, merged.reason);
        lastContextMessages = [...incoming];
        return;
      }
      lastContextMessages = merged.messages;
      return { messages: merged.messages as never };
    }
    lastContextMessages = [...incoming];
  });

  pi.on("before_provider_request", (event, ctx) => {
    try {
      const json = JSON.stringify(event.payload);
      const redacted = redactSecrets(json).text;
      lastPayloadMeta = { length: redacted.length, hash: sha256(redacted) };
    } catch {
      lastPayloadMeta = null;
    }
    // Exact token counting: keep the payload in memory only (never persisted,
    // never returned) and count it asynchronously against the provider's own
    // llama-swap endpoints so the request itself is not delayed.
    const model = ctx.model as { id?: string; baseUrl?: string } | undefined;
    if (typeof model?.id === "string" && typeof model.baseUrl === "string") {
      lastProviderRequest = { payload: event.payload, model: model.id, baseUrl: model.baseUrl };
      messagesSinceLastRequest = [];
      void refreshTokenCount(ctx);
    }
  });

  // ---- per-turn injection + source toggles ----

  pi.on("before_agent_start", (event, ctx) => {
    promptStarted = Date.now();
    firstTextMs = null;
    creditTurn++;
    refreshCredits("start", ctx, true); // defensive if an embedding skips session_start
    // The context editor can override the base system prompt; toggles and the
    // control-plane block still apply on top of the override.
    let prompt = contextOverlay?.systemPrompt ?? event.systemPrompt;
    lastBaseSystemPrompt = prompt;
    const options = event.systemPromptOptions;

    // Context-file toggles: verified excision, honest failure handling.
    const fileResult = applyContextFileToggles(prompt, options.contextFiles ?? [], state.sourceToggles);
    prompt = fileResult.prompt;
    const failed: string[] = [...fileResult.failed];

    // Skill toggles: replace the skills block with a filtered rebuild.
    const skills = options.skills ?? [];
    const disabledSkills = skills.filter(
      (skill) => state.sourceToggles[toggleName.skill(skill.name)] === false,
    );
    if (disabledSkills.length > 0) {
      if (formatSkillsForPrompt === null) {
        failed.push(...disabledSkills.map((skill) => toggleName.skill(skill.name)));
      } else {
        const fullBlock = formatSkillsForPrompt(skills);
        const filteredBlock = formatSkillsForPrompt(
          skills.filter((skill) => state.sourceToggles[toggleName.skill(skill.name)] !== false),
        );
        const replaced = replaceSkillsBlock(prompt, fullBlock, filteredBlock);
        if (replaced === null) {
          failed.push(...disabledSkills.map((skill) => toggleName.skill(skill.name)));
        } else {
          prompt = replaced;
        }
      }
    }

    if (failed.length > 0) {
      // Honesty rule: never report a source as disabled while it still reaches
      // the provider. Re-enable and tell the user.
      for (const name of failed) {
        delete state.sourceToggles[name];
      }
      persist();
      ctx.ui.notify(
        `Control plane: could not verifiably exclude ${failed.join(", ")} from the system prompt — re-enabled (content is still sent to the provider).`,
        "warning",
      );
    }

    prompt += "\n\n" + buildInjectionBlock(state, policy !== null);
    const scratchpadBlock = renderScratchpadBlock(scratchpad, LIMITS.injectionTotal);
    if (scratchpadBlock !== null) prompt += "\n\n" + scratchpadBlock;
    const todoBlock = renderTodoBlock(todo, LIMITS.injectionTotal);
    if (todoBlock !== null) prompt += "\n\n" + todoBlock;
    updateStatus(ctx);
    return { systemPrompt: prompt };
  });

  pi.on("agent_end", (event, ctx) => {
    // For the forward-looking count: the turn's final assistant reply is the
    // one message the last provider request has not seen yet.
    const tail = event.messages.at(-1) as { role?: string; content?: unknown } | undefined;
    if (tail?.role === "assistant") {
      messagesSinceLastRequest.push(serializeForCounting(tail));
    }
    if (promptStarted) {
      // Workload ledger: one record per completed turn. The turn boundary is
      // before_agent_start -> agent_end: model streaming, tool calls and
      // hooks combined — the time the model spends working between prompts.
      timing = recordTurn(
        timing,
        {
          firstTextMs,
          totalMs: Date.now() - promptStarted,
          endedAt: new Date().toISOString(),
        },
        new Date().toISOString(),
      );
      persistTiming();
      promptStarted = 0;
    }
    const completedCreditTurn = creditTurn;
    refreshCredits("end", ctx, true);
    scheduleCreditSettlement(ctx, completedCreditTurn);
  });

  // ---- tool authorization ----

  /**
   * Applied only once a call has already been allowed (by policy, or by
   * user confirmation) - sandboxing is orthogonal to authorization, not a
   * replacement for it. `event.input` mutation here relies on the documented
   * Pi extension contract ("event.input is mutable. Mutate it in place to
   * patch tool arguments before execution.", types.d.ts on ToolCallEvent).
   * Fails closed: if bwrap is missing, the call is blocked rather than
   * silently running unsandboxed, since the user explicitly turned this on.
   */
  const applySandboxIfEnabled = (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): { ok: true } | { ok: false; reason: string } => {
    if (!sandbox.enabled) return { ok: true };
    if (event.toolName !== "bash") return { ok: true };
    if (!isBwrapAvailable()) {
      return {
        ok: false,
        reason:
          "[control plane] Bwrap sandbox is on (/bwrap on) but the `bwrap` binary is not on PATH. " +
          "Failing closed rather than running this command unsandboxed - install bubblewrap, or run /bwrap off.",
      };
    }
    const bashEvent = event as BashToolCallEvent;
    bashEvent.input.command = buildSandboxedCommand(bashEvent.input.command, sandboxOptionsFor(ctx));
    return { ok: true };
  };

  /**
   * The attended per-call gate for a rememberable confirm: a three-option
   * dialog (Yes once / No / Always) rendered with pi-tui's SelectList via
   * ctx.ui.custom. It is a SINGLE prompt — the same one shown today — with a
   * third choice; "Always" is handled by the caller (it saves exactly the rule
   * /harness-rules allow would, then allows). Escape / cancel = No. Falls back
   * to a trivial No if SelectList is unavailable at runtime (should not happen
   * in an interactive session; the caller only reaches here when ctx.ui.custom
   * exists). The unit-test harness supplies its own ctx.ui.custom that resolves
   * a scripted choice without invoking this factory.
   */
  const promptAttendedChoice = async (
    ctx: ExtensionContext,
    toolName: string,
    ruleLabel: string,
    detail: string,
  ): Promise<"once" | "always" | "no"> => {
    const header = [...detail.split("\n"), "", "↑↓ choose · enter select · esc = No"];
    const items: SelectListItem[] = [
      { value: "once", label: `Yes — allow ${toolName} once` },
      { value: "no", label: "No — deny this call" },
      {
        value: "always",
        label: `Always — allow ${ruleLabel}`,
        description: "saves a scope-bound rule; manage with /harness-rules",
      },
    ];
    const ui = ctx.ui as unknown as {
      custom: <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => SelectListLike) => Promise<T>;
    };
    const choice = await ui.custom<string | null>((_tui, _theme, _kb, done) => {
      if (SelectListCtor === null) {
        done("no");
        return { render: (width: number) => clipLines(header, width), handleInput: () => {}, invalidate: () => {} };
      }
      const list = new SelectListCtor(items, items.length, getSelectListThemeFn ? getSelectListThemeFn() : undefined);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done("no"); // Escape / ctrl+c = No
      return {
        render: (width: number) => [...clipLines(header, width), ...list.render(width)],
        handleInput: (data: string) => list.handleInput(data),
        invalidate: () => list.invalidate(),
      };
    });
    return choice === "once" || choice === "always" ? choice : "no"; // null/escape/unknown -> No
  };

  /**
   * For an attended confirm, the target a remembered rule (and the three-option
   * dialog's "Always") would key on, so EVERY confirm path is rememberable and
   * shows the rule - not just resolvable-path ones:
   *   - a resolvable path (edit/write/outside-root read) -> the canonical path;
   *   - a shell command (bare `bash` or the harness shell) -> the exact command
   *     string (conservative: only the identical command is later suppressed);
   *   - a harness meta-tool or a genuinely foreign tool -> "*" (a tool-level
   *     rule: "always allow this tool" in this scope; "*" is a non-empty
   *     sentinel so validateRule accepts it and it never collides with a
   *     canonical path, which is always absolute).
   * Returns null when the confirm must NOT be rememberable - a sensitive read,
   * the one documented hard exception (remembering an exfil path is forbidden),
   * which therefore keeps a plain yes/no.
   */
  const rememberTargetFor = (
    event: ToolCallEvent,
    decision: ToolDecision,
    ctx: ExtensionContext,
  ): { target: string; label: string } | null => {
    const input = event.input as Record<string, unknown>;
    const rawPath = typeof input.path === "string" ? input.path : null;
    const command = typeof input.command === "string" ? input.command : null;
    const canonical = rawPath !== null ? canonicalizePath(rawPath, ctx.cwd, pathOps) : null;
    if (
      decision.rule === "attended:read-outside-root" &&
      canonical !== null &&
      isSensitiveReadTarget(canonical, agentDir(), sensitiveReadExtra())
    ) {
      return null; // sensitive read: hard boundary, never rememberable
    }
    if (canonical !== null) {
      return { target: canonical, label: `${event.toolName} on ${canonical}` };
    }
    if (decision.riskCategory === "shell" && command !== null) {
      const shown = command.length > 60 ? command.slice(0, 60) + "…" : command;
      return { target: command, label: `${event.toolName}: ${shown}` };
    }
    if (decision.riskCategory === "harness-tool" || decision.riskCategory === "unknown-tool") {
      return { target: "*", label: `${event.toolName} (any call in this scope)` };
    }
    return null;
  };

  /**
   * P2, control-plane side: stamp a human approval onto the tool-call event so
   * the harness's own authorization seam can consume it instead of asking the
   * same question a second time (GATE-FATIGUE-REDESIGN.md P2).
   *
   * Deliberately passed ON THE EVENT rather than through shared state: the two
   * extensions share no state by design (docs/ARCHITECTURE.md), and each must
   * keep working when the other is not installed. The harness reads the field
   * if present and ignores it otherwise.
   *
   * The stamp carries the tool-call id so it authorizes exactly one call, and
   * only an APPROVAL is ever stamped — a decline blocks here and never reaches
   * the harness.
   */
  const markConfirmedForHarness = (event: ToolCallEvent): void => {
    const callId = (event as { toolCallId?: string }).toolCallId;
    (event as { __cpUserApproved?: { callId: string | null; at: string } }).__cpUserApproved = {
      callId: typeof callId === "string" ? callId : null,
      at: new Date().toISOString(),
    };
  };

  /**
   * Harness tools whose EFFECT is read-only: they answer a question and change
   * nothing, so the attended layer lets them through silently (P1). The harness
   * already treats these as reads at its own seam, so gating them here was the
   * only thing standing between the coordinator and a free lookup — it cost a
   * real prompt in the observed trace.
   *
   * Deliberately excluded and still gated: harness_note and
   * harness_set_posture (they write) and harness_delegate (it spawns an actor).
   */
  const READ_EFFECT_HARNESS_TOOLS: ReadonlySet<string> = new Set([
    "harness_find_capability",
    "harness_memory_search",
    // harness_request_scope is deliberately NOT here. The design note claimed it
    // only RECORDS a request and that Core decides separately - that is wrong.
    // Its auto-granted path widens the scope itself (src/harness/scope.ts:270
    // returns a new root; extensions/pi-harness.ts then assigns session.scope and
    // persists it), bounded only by a one-expansion-per-scope budget, with no
    // human in the loop. A tool that can widen authority must not be downgraded
    // to a silent allow - same anomaly class as harness_note.
  ]);

  /**
   * The over-budget advisor-consult gate: Yes (this once) / No / Always (lift
   * the cap for the session). Same three-option ctx.ui.custom dialog as the
   * attended per-call gate, but "Always" lifts a session budget rather than
   * saving a path rule, so it is a distinct helper. Falls back to a plain
   * yes/no confirm when ctx.ui.custom is unavailable (no "Always" then).
   */
  const promptAdvisorBudget = async (
    ctx: ExtensionContext,
    detail: string,
  ): Promise<"once" | "always" | "no"> => {
    // Same RPC guard as the attended per-call gate: custom() exists as a
    // function in RPC mode but returns undefined without prompting, which
    // would auto-deny without ever asking. Plain yes/no outside the TUI.
    const hasCustom =
      ctx.mode === "tui" && typeof (ctx.ui as { custom?: unknown }).custom === "function";
    if (!hasCustom) {
      const ok = await ctx.ui.confirm("Consult the advisor again?", detail);
      return ok ? "once" : "no";
    }
    const header = [...detail.split("\n"), "", "↑↓ choose · enter select · esc = No"];
    const items: SelectListItem[] = [
      { value: "once", label: "Yes — consult the advisor this once" },
      { value: "no", label: "No — skip this consult" },
      {
        value: "always",
        label: "Always — stop asking for advisor consults this session",
        description: "lifts the per-task advisor budget until the session ends",
      },
    ];
    const ui = ctx.ui as unknown as {
      custom: <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => SelectListLike) => Promise<T>;
    };
    const choice = await ui.custom<string | null>((_tui, _theme, _kb, done) => {
      if (SelectListCtor === null) {
        done("no");
        return { render: (width: number) => clipLines(header, width), handleInput: () => {}, invalidate: () => {} };
      }
      const list = new SelectListCtor(items, items.length, getSelectListThemeFn ? getSelectListThemeFn() : undefined);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done("no"); // Escape / ctrl+c = No
      return {
        render: (width: number) => [...clipLines(header, width), ...list.render(width)],
        handleInput: (data: string) => list.handleInput(data),
        invalidate: () => list.invalidate(),
      };
    });
    return choice === "once" || choice === "always" ? choice : "no"; // null/escape/unknown -> No
  };

  /**
   * Enact a policy decision: allow (with sandbox), confirm (attended per-call
   * dialog), or block. Factored out so the phase-switch dialog below can
   * re-dispatch a call through the SAME path after an attended phase change,
   * rather than duplicating the logic.
   */
  const handleDecision = async (
    event: ToolCallEvent,
    ctx: ExtensionContext,
    decision: ToolDecision,
  ): Promise<{ block: true; reason: string } | undefined> => {
    if (decision.action === "allow") {
      // A permitted read establishes read-before-edit credit for that file.
      recordReadCredit(event, ctx);
      const input = event.input as Record<string, unknown>;
      const targetPath = typeof input.path === "string" ? input.path : null;
      const command = typeof input.command === "string" ? input.command : null;
      // Unattended mode has nobody watching in real time; every allowed call
      // (not just blocked ones) is logged so there is something to review
      // afterward. Read tools are excluded - the volume would drown out the
      // signal, and reads are not the risk this level gates.
      if (state.autonomy === "unattended" && decision.riskCategory !== "read") {
        pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
          kind: "unattended-call-allowed",
          toolName: event.toolName,
          ...(targetPath !== null ? { targetPath } : {}),
          ...(command !== null ? { command } : {}),
          at: new Date().toISOString(),
        });
      }
      // Auto mode, P2 extension: an allow under the auto:in-root-edit rule
      // rests on the same human decision a dialog would have collected — the
      // user chose /mode accept, a standing "yes" for exactly this class of call
      // (in-root, non-protected file writes/edits; nothing else earns the
      // rule). Stamp it so the harness layer consumes that answer instead of
      // asking its own section-21 question, in the TUI and headless alike.
      // Same per-callId, single-use stamp as a dialog approval; the harness
      // still evaluates and still enforces its scope and hard rules.
      if (decision.rule === "auto:in-root-edit") {
        markConfirmedForHarness(event);
      }
      // Backup-before-edit (hard rule): snapshot the pre-mutation state of an
      // existing file before it changes. Runs on the allow path (attended or
      // unattended) and fails closed — a mutation never proceeds without a
      // recoverable pre-image. Exempt for new files and non-mutate tools.
      const backupResult = takeBackup(event, ctx);
      if (backupResult !== undefined) return backupResult;
      const sandboxResult = applySandboxIfEnabled(event, ctx);
      if (!sandboxResult.ok) return { block: true, reason: sandboxResult.reason };
      return;
    }

    if (decision.action === "confirm") {
      if (!ctx.hasUI) {
        return {
          block: true,
          // Actionable, because a refusal that only says "failing closed" leaves
          // a non-interactive session with no move at all: name both ways the
          // user can pre-authorize this without a dialog.
          reason:
            formatDenial(decision, event.toolName) +
            " No confirmation UI is available in this mode; failing closed." +
            " To pre-authorize without a dialog: /mode accept (applies in-root file edits without asking)," +
            " or /harness-rules allow <tool> <path> plus /harness-rules headless on, which applies" +
            " the rules you saved in sessions with no UI.",
        };
      }
      const input = event.input as Record<string, unknown>;
      const command = typeof input.command === "string" ? input.command : null;
      const target = typeof input.path === "string" ? input.path : null;
      const detail = formatConfirmDetail({
        toolName: event.toolName,
        riskCategory: decision.riskCategory,
        path: target,
        command,
        insideRoot: decision.insideRoot,
        reason: decision.reason,
      });
      // EVERY confirm routes through the three-option dialog (Yes/No/Always) so
      // no confirm is a bare, un-rememberable yes/no: a resolvable path keys the
      // rule on the path, a shell command on the exact command, a harness/foreign
      // tool at tool level. "Always" saves that rule and suppresses the prompt
      // next time. The one exception is a sensitive read (rememberTargetFor ->
      // null), the documented hard boundary, which keeps a plain yes/no.
      // Without a real custom-dialog surface, plain yes/no: in RPC mode
      // custom() is a function that returns undefined without prompting, so a
      // typeof-only check silently auto-denies every attended confirm there.
      const remember = rememberTargetFor(event, decision, ctx);
      const hasCustom =
        ctx.mode === "tui" && typeof (ctx.ui as { custom?: unknown }).custom === "function";
      let approved: boolean;
      if (hasCustom && remember !== null) {
        const choice = await promptAttendedChoice(ctx, event.toolName, remember.label, detail);
        if (choice === "always") {
          const scopeRoot = rootOf(ctx);
          const result = addRule(
            rememberedRules,
            { tool: event.toolName, target: remember.target, scopeRoot },
            new Date().toISOString(),
          );
          if (result.rule !== null && !result.duplicate) {
            rememberedRules = result.state;
            persistRules();
            pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
              kind: "remembered-rule-added",
              actor: "user",
              provenance: "attended-dialog",
              ruleId: result.rule.id,
              toolName: event.toolName,
              target: remember.target,
              scopeRoot,
              at: new Date().toISOString(),
            });
          }
        }
        approved = choice === "once" || choice === "always";
      } else {
        approved = await ctx.ui.confirm(`Allow ${event.toolName}?`, detail);
      }
      if (approved) {
        // P2 "one door per decision" (GATE-FATIGUE-REDESIGN.md): the harness
        // registered a tool_call handler too, and this extension only
        // short-circuits on BLOCK — so an ALLOW here lets the same call reach
        // the harness, whose authorize() may independently return
        // needs-approval and ask the identical question again. That double
        // dialog was two of the five prompts in the observed trace.
        //
        // Stamp the human's answer onto the event, keyed to THIS tool call. The
        // harness consumes it in place of prompting. Both layers still evaluate
        // and still enforce; only the second QUESTION disappears. Single-use and
        // per-callId, so it can never be replayed onto a later call, and it is
        // never persisted. A denial is never stamped: a decline blocks here, so
        // the harness never sees the call.
        markConfirmedForHarness(event);
        // A confirmed read (e.g. an outside-root read approved in Attended)
        // also earns read-before-edit credit for that file.
        recordReadCredit(event, ctx);
        // Backup-before-edit: same hard precondition as the allow path — a
        // user-approved mutation of an existing file still needs its pre-image
        // snapshotted first. Fails closed on backup failure.
        const backupResult = takeBackup(event, ctx);
        if (backupResult !== undefined) return backupResult;
        const sandboxResult = applySandboxIfEnabled(event, ctx);
        if (!sandboxResult.ok) return { block: true, reason: sandboxResult.reason };
        return;
      }
      // Decision B: record a declined out-of-scope READ so a refused read is a
      // first-class event, not just an inline block reason. Emitted only on the
      // decline of a read-risk confirm (attended:read-outside-root) — an
      // approved read takes the branch above and records nothing here, so there
      // is no double-count. This lands in the control-plane diagnostic log (the
      // retrospective reviewer reads the session transcript); it does NOT reach
      // the harness tamper-evident chain — AU1 makes the harness audit() the
      // sole writer of that chain and control-plane's block short-circuits the
      // harness, so a control-plane-refused read cannot appear there. Closing
      // that fully is a harness-side change tracked separately.
      if (decision.riskCategory === "read") {
        pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
          kind: "read-out-of-scope-denied",
          toolName: event.toolName,
          ...(target !== null ? { target } : {}),
          rule: decision.rule,
          at: new Date().toISOString(),
        });
      }
      return {
        block: true,
        reason: `[control plane] Denied by user confirmation (${decision.rule}). The operation did not run.`,
      };
    }

    // Blocked.
    return { block: true, reason: formatDenial(decision, event.toolName) };
  };

  // tool_result fires only for calls that actually executed (blocked calls
  // never reach it), so this restamps read credit exactly once per completed
  // edit/write — keeping follow-up edits of the same file free of a pointless
  // "changed on disk" re-read demand.
  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    refreshReadCredit(event, ctx);
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    const decision = evaluateToolCall({
      toolName: event.toolName,
      toolInput: event.input as Record<string, unknown>,
      phase: state.phase,
      autonomy: state.autonomy,
      projectRoot: rootOf(ctx),
      cwd: ctx.cwd,
      policy,
      ops: pathOps,
      agentDir: agentDir(),
    });

    // Reads free by default: a read outside the project root would otherwise
    // confirm (attended:read-outside-root), which turns a normal read workload
    // into a yes/no every few seconds. Downgrade it to a silent (still scope-
    // checked, still read-before-edit-crediting) allow UNLESS the target is on
    // the sensitive-path denylist — those keep the exfil confirm. In-scope reads
    // were already allowed, so this only touches the out-of-root read prompt.
    if (decision.action === "confirm" && decision.rule === "attended:read-outside-root") {
      const rawPath = typeof (event.input as Record<string, unknown>).path === "string"
        ? ((event.input as Record<string, unknown>).path as string)
        : null;
      const canonical = rawPath !== null ? canonicalizePath(rawPath, ctx.cwd, pathOps) : null;
      if (canonical !== null && !isSensitiveReadTarget(canonical, agentDir(), sensitiveReadExtra())) {
        recordReadCredit(event, ctx);
        return; // allow silently
      }
      // Sensitive (or unresolvable): fall through to the confirm below.
    }

    // P1 (GATE-FATIGUE-REDESIGN.md): a harness tool whose effect is read-only
    // flows free. These answer a question and change nothing — the harness
    // itself already classifies them as reads at its own seam, so the attended
    // confirm here was the only prompt standing in front of a lookup, and it
    // was one of the five in the observed trace. Same shape as the reads-free
    // downgrade above. Write-effect (harness_note, harness_set_posture) and
    // escalating (harness_delegate) harness tools are deliberately excluded and
    // keep their gate; a hard block is never downgraded, only a confirm.
    if (decision.action === "confirm" && READ_EFFECT_HARNESS_TOOLS.has(event.toolName)) {
      return; // read-effect harness tool: silent allow
    }

    // Advisor-consult budget (soft policy): a read-only advisor consult
    // (harness_delegate kind:"advisor") is a cloud model - each call costs quota
    // and latency. The first ADVISOR_CONSULTS_PER_TASK consults per session
    // are silent; further consults hit the attended Yes/No/Always gate, where
    // "Always" lifts the cap for the session.
    // This only downgrades/gates the ATTENDED path - a consult a hard rule
    // already blocks (phase/restricted/unattended/read-only) has
    // decision.action === "block" and is left untouched, so the budget never
    // expands capability. A no-UI session fails closed over budget. Allowed
    // consults are already recorded in the harness tamper-evident chain (AU1);
    // the control plane cannot write that chain, so budget blocks and lifts are
    // recorded here as control-plane diagnostics instead.
    const advisorConsult =
      event.toolName === "harness_delegate" &&
      (event.input as Record<string, unknown>).kind === "advisor";
    if (advisorConsult && decision.action !== "block") {
      // One shared per-session budget.
      const taskKey = "__session__";
      if (taskKey !== advisorBudgetTaskKey) {
        advisorBudgetTaskKey = taskKey;
        advisorConsultsThisTask = 0;
      }
      const withinBudget =
        advisorBudgetLifted || advisorConsultsThisTask < ADVISOR_CONSULTS_PER_TASK;
      if (!withinBudget) {
        if (!ctx.hasUI) {
          pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
            kind: "advisor-budget-blocked",
            reason: "no-ui",
            count: advisorConsultsThisTask,
            limit: ADVISOR_CONSULTS_PER_TASK,
            taskKey,
            at: new Date().toISOString(),
          });
          return {
            block: true,
            reason:
              `[control plane] Advisor consult budget reached (${ADVISOR_CONSULTS_PER_TASK} per task) ` +
              "and no confirmation UI is available; failing closed. Raise the budget or re-run in an " +
              "attended session to approve further consults.",
          };
        }
        const detail = [
          `Advisor consult budget reached: ${advisorConsultsThisTask} of ${ADVISOR_CONSULTS_PER_TASK} used for this task.`,
          "An advisor is a cloud model; each consult costs quota and latency.",
          "",
          "Approve this extra consult, skip it, or stop asking for the rest of the session.",
        ].join("\n");
        const choice = await promptAdvisorBudget(ctx, detail);
        if (choice === "no") {
          pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
            kind: "advisor-budget-blocked",
            count: advisorConsultsThisTask,
            limit: ADVISOR_CONSULTS_PER_TASK,
            taskKey,
            at: new Date().toISOString(),
          });
          return {
            block: true,
            reason: `[control plane] Advisor consult declined (over the per-task budget of ${ADVISOR_CONSULTS_PER_TASK}).`,
          };
        }
        if (choice === "always") {
          advisorBudgetLifted = true;
          pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
            kind: "advisor-budget-lifted",
            actor: "user",
            provenance: "attended-dialog",
            taskKey,
            at: new Date().toISOString(),
          });
        }
        advisorConsultsThisTask += 1;
        pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
          kind: "advisor-consult",
          count: advisorConsultsThisTask,
          overBudgetApproved: true,
          taskKey,
          at: new Date().toISOString(),
        });
        return; // approved over-budget consult: allow (downgrade any confirm)
      }
      advisorConsultsThisTask += 1;
      pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
        kind: "advisor-consult",
        count: advisorConsultsThisTask,
        overBudgetApproved: false,
        taskKey,
        at: new Date().toISOString(),
      });
      return; // within budget: silent allow (downgrade the attended confirm)
    }

    // Read-only harness shell flows freely: pi_harness_bash is bwrap-sandboxed
    // by the harness with the scope root mounted READ-ONLY unless the call
    // passes mode:"write" (see PHASE4-RO-SHELL-DESIGN.md). A read-mode call
    // cannot mutate, cannot reach out-of-scope/credential paths (the mount table
    // is the classifier), and has no network - so in Execute+attended it is
    // auto-allowed silently instead of prompting for every wc/grep/git-status.
    // The harness still writes the shell_exec audit (runId + exit code), so the
    // run is recorded. Gated on bwrap being available: without it the harness
    // would refuse and there is no read-only guarantee to lean on, so it falls
    // through to the confirm (never a silent allow). A write-mode call also falls
    // through to the gate (the Part-2 three-option dialog, scope root shown).
    if (
      event.toolName === "pi_harness_bash" &&
      decision.action === "confirm" &&
      (event.input as Record<string, unknown>).mode !== "write" &&
      isBwrapAvailable()
    ) {
      return; // read-only sandboxed shell: silent allow
    }

    // Read-before-edit (hard rule): an edit/write targeting an EXISTING file
    // must have read that file this session (and it must not have changed on
    // disk since). This is a strict precondition on mutation — it preempts both
    // the attended per-call confirm and the phase-switch dialog, because the
    // actionable fix for a blind edit is to read the file first, not to confirm
    // it or switch phase. New files are exempt; shell and reads are out of
    // scope. Each denial is audited so refused blind writes are visible to
    // /harness-eval and the retrospective reviewer.
    const rbe = readBeforeEditViolation(event, ctx);
    if (rbe !== null) {
      const rule = rbe.stale ? "read-before-edit:stale" : "read-before-edit";
      const why = rbe.stale
        ? `"${rbe.canonical}" changed on disk since this session last read it (external modification).`
        : `"${rbe.canonical}" has not been read in this session.`;
      pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
        kind: "blocked-read-before-edit",
        toolName: event.toolName,
        target: rbe.canonical,
        stale: rbe.stale,
        at: new Date().toISOString(),
      });
      return {
        block: true,
        reason:
          `[control plane] Blocked tool "${event.toolName}" (${riskCategoryFor(event.toolName)}). ` +
          `Rule: ${rule}. ${why} Inspect before editing — do not infer source state. ` +
          `Fix: read ${rbe.canonical} first, then retry.`,
      };
    }

    // Remembered decisions: a soft-policy rule the user saved converts a
    // matching attended confirm into an allow, so the same prompt never recurs.
    // Placed AFTER read-before-edit (a rule cannot resurrect a blind edit) and
    // it never matches a sensitive-read confirm (rememberTargetFor -> null), so
    // it can only skip a prompt the user has already, explicitly, agreed to skip
    // — never loosen a hard boundary. Keyed by the SAME rememberTargetFor as the
    // dialog's "Always", so path-ful, shell (by command) and tool-level
    // (harness/foreign) rules all match here.
    //
    // Gated on hasUI by DEFAULT, unchanged: a rule suppresses a PROMPT, and a
    // no-UI session has none, so it fails closed. The opt-in
    // (/harness-rules headless on, persisted as applyWithoutUi) is the one way
    // that default moves, and only a human can set it. It widens WHEN the
    // user's existing approvals apply, never WHAT they cover — the rule set,
    // its scope binding, and the hard boundaries above are untouched.
    if (decision.action === "confirm" && (ctx.hasUI || rememberedRules.applyWithoutUi === true)) {
      const remember = rememberTargetFor(event, decision, ctx);
      if (
        remember !== null &&
        matchRule(rememberedRules, event.toolName, remember.target, rootOf(ctx)) !== null
      ) {
        pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
          kind: "remembered-rule-allow",
          toolName: event.toolName,
          target: remember.target,
          at: new Date().toISOString(),
        });
        recordReadCredit(event, ctx);
        // P2: a remembered rule IS a human approval - the "Always" answer the
        // user gave, replayed. Stamp it like the live dialog answer it stands
        // in for, or the harness asks its own section-21 question about a call
        // the user already approved (observed live: rule allowed
        // harness_delegate, harness dialog still popped).
        markConfirmedForHarness(event);
        const backupResult = takeBackup(event, ctx);
        if (backupResult !== undefined) return backupResult;
        const sandboxResult = applySandboxIfEnabled(event, ctx);
        if (!sandboxResult.ok) return { block: true, reason: sandboxResult.reason };
        return; // allowed by a remembered rule, no prompt
      }
    }

    // Attended phase-switch dialog: when a call is blocked SOLELY by the phase
    // rule (a non-Execute phase prohibiting a mutating tool) and a UI is
    // available, offer the human the same transition they could type as
    // /mode manual — a prose dead end ("type /mode manual") becomes a Yes/No
    // at the moment of the block. This is user-actor authority (the human
    // answers), identical to the attended confirm and read-out-of-scope gates;
    // it grants no model actor any new capability. Autonomy still gates
    // independently: we recompute the decision AS IF already in Execute and,
    // if that would still block, fall back to the plain block (never stack two
    // escalations into one Yes); if it would only confirm, the retry hits the
    // attended per-call dialog separately below.
    if (decision.action === "block" && decision.rule.startsWith("phase:") && ctx.hasUI) {
      const exec = stateForMode("manual");
      const postSwitch = evaluateToolCall({
        toolName: event.toolName,
        toolInput: event.input as Record<string, unknown>,
        phase: exec.phase,
        autonomy: exec.autonomy,
        projectRoot: rootOf(ctx),
        cwd: ctx.cwd,
        policy,
        ops: pathOps,
        agentDir: agentDir(),
      });
      if (postSwitch.action !== "block") {
        const input = event.input as Record<string, unknown>;
        const command = typeof input.command === "string" ? input.command : null;
        const target = typeof input.path === "string" ? input.path : null;
        // Clamped line-by-line: an over-wide line here crashes the renderer
        // (see clampBodyLines).
        const body = clampBodyLines(
          [
            `The current phase (${state.phase}) blocks mutating tool calls.`,
            `Blocked tool: ${event.toolName}`,
            target !== null ? `Target: ${target}` : null,
            command !== null ? `Command: ${command}` : null,
            "",
            "Switching to Execute permits mutating tools until you change the phase back.",
            postSwitch.action === "confirm"
              ? "After switching, this call still requires a separate per-action confirmation (autonomy is unchanged)."
              : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
          safeDialogWidth(),
        );
        const approved = await ctx.ui.confirm("Switch to Execute phase?", body);
        if (approved) {
          const fromMode = modeOf(state.phase, state.autonomy) ?? state.phase;
          setMode(ctx, "manual", false);
          // Audit the phase change with the dialog as provenance so a
          // dialog-driven switch is visible to review, and is
          // attributable to the human who answered (user actor).
          pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
            kind: "phase-switch-via-dialog",
            from: fromMode,
            to: "manual",
            actor: "user",
            provenance: "attended-phase-dialog",
            blockedTool: event.toolName,
            blockedRule: decision.rule,
            at: new Date().toISOString(),
          });
          // Re-dispatch the SAME call under the new phase so the user does not
          // retype anything; autonomy gates it independently (attended → the
          // per-call confirm dialog runs here).
          return handleDecision(event, ctx, postSwitch);
        }
        // Declined: block exactly as today.
        return handleDecision(event, ctx, decision);
      }
    }

    return handleDecision(event, ctx, decision);
  });

  // ---- commands ----

  pi.registerCommand("control-reload", {
    description: "Reload Pi resources (same as /reload)",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Pi is busy; reload when the current turn finishes.", "warning");
        return;
      }
      await ctx.reload();
      return;
    },
  });

  // Shortcut contexts lack reload(); dispatch through a command context.
  pi.registerShortcut("ctrl+alt+r", {
    description: "Reload Pi resources (same as /reload, when idle)",
    handler: (ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Pi is busy; reload when the current turn finishes.", "warning");
        return;
      }
      pi.sendUserMessage("/control-reload", { expandPromptTemplates: true });
    },
  });

  pi.registerCommand("clear", {
    description: "Start a fresh session (alias for /new)",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });

  pi.registerCommand("control-ui", {
    description: "Show minimal UI, detailed usage or prompt timing: /control-ui minimal|details|timing",
    getArgumentCompletions: (prefix) => ["minimal", "details", "timing"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const choice = args.trim();
      if (choice === "timing") {
        for (const line of renderTimingSummary(timing)) ctx.ui.notify(line, "info");
        return;
      }
      if (choice !== "minimal" && choice !== "details") {
        ctx.ui.notify("Usage: /control-ui minimal|details|timing", "info");
        return;
      }
      detailedUI = choice === "details";
      updateStatus(ctx);
    },
  });

  pi.registerCommand("context", {
    description: "Inspect the effective context (summary, diff, full, sources, toggle)",
    getArgumentCompletions: (prefix) => {
      const subs = ["diff", "full", "sources", "toggle ", "restore", "profile ", "recount"];
      const matches = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s.trim() })) : null;
    },
    handler: async (args, ctx) => {
      const command = parseContextArgs(args);
      switch (command.kind) {
        case "usage":
          emit("usage", USAGE.context);
          return;
        case "summary": {
          const snapshot = buildCurrentSnapshot(ctx);
          state.previousContextSnapshot = snapshot;
          persist();
          updateStatus(ctx);
          emit("context", renderContextSummary(snapshot, { compactHint: true }));
          return;
        }
        case "diff": {
          const current = buildCurrentSnapshot(ctx);
          const previous = state.previousContextSnapshot;
          if (previous === null) {
            state.previousContextSnapshot = current;
            persist();
            emit("context diff", [
              "No previous snapshot exists. This snapshot is now the baseline;",
              "run /context diff again after the context changes.",
            ]);
            return;
          }
          const diff = diffSnapshots(previous, current);
          emit("context diff", renderDiff(diff, diffIsEmpty(diff)));
          return;
        }
        case "full": {
          const snapshot = buildCurrentSnapshot(ctx);
          state.previousContextSnapshot = snapshot;
          persist();
          const lines: string[] = [SENSITIVE_OUTPUT_WARNING, ""];
          lines.push(...renderContextSummary(snapshot, { compactHint: true }));
          lines.push("");
          lines.push("Tools (with descriptions):");
          for (const tool of pi.getAllTools()) {
            lines.push(`  ${tool.name}: ${tool.description.split("\n")[0].slice(0, 120)}`);
          }
          let redactedPrompt: string | null = null;
          try {
            redactedPrompt = redactSecrets(ctx.getSystemPrompt()).text;
          } catch {
            redactedPrompt = null;
          }
          lines.push("");
          if (redactedPrompt === null) {
            lines.push("System prompt: Unavailable");
          } else {
            lines.push(`System prompt (redacted, first ${LIMITS.fullPromptPreview} chars):`);
            const preview =
              redactedPrompt.length > LIMITS.fullPromptPreview
                ? redactedPrompt.slice(0, LIMITS.fullPromptPreview) +
                  `\n[TRUNCATED: ${redactedPrompt.length - LIMITS.fullPromptPreview} more chars]`
                : redactedPrompt;
            lines.push(...preview.split("\n"));
          }
          emit("context full", lines);
          return;
        }
        case "sources": {
          emit("context sources", renderSources(buildCurrentSnapshot(ctx)));
          return;
        }
        case "restore": {
          if (contextOverlay === null) {
            ctx.ui.notify("No context override is active.", "info");
            return;
          }
          clearOverlay(ctx, "restored by /context restore");
          return;
        }
        case "recount": {
          if (lastProviderRequest === null) {
            ctx.ui.notify(
              "No provider request observed yet this session — send a message first, then /context recount.",
              "info",
            );
            return;
          }
          await refreshTokenCount(ctx);
          if (lastTokenCount === null) {
            emit("token recount", [
              "Exact count unavailable: the provider did not answer the token-counting",
              "endpoints (llama-swap /v1/messages/count_tokens or /upstream tokenize).",
              "The footer keeps showing pi's estimate, labeled as such.",
            ]);
            return;
          }
          const usage = ctx.getContextUsage();
          const window = usage?.contextWindow ?? 0;
          const lines = [
            `Exact tokens (last provider request): ${lastTokenCount.tokens.toLocaleString("en-US")}`,
            `Counted by:  ${lastTokenCount.source} (model's own tokenizer)`,
            `Model:       ${lastTokenCount.model}`,
            `Counted at:  ${lastTokenCount.countedAt}`,
            window > 0
              ? `Of window:   ${((lastTokenCount.tokens / window) * 100).toFixed(1)}% of ${window.toLocaleString("en-US")}`
              : "Of window:   Unavailable",
            usage?.tokens !== undefined && usage?.tokens !== null
              ? `Pi estimate: ${Number(usage.tokens).toLocaleString("en-US")} (for comparison)`
              : "Pi estimate: Unavailable",
            "",
            "Note: this counts what was actually sent on the LAST request; messages",
            "added since then are not included until the next request.",
          ];
          emit("token recount", lines);
          updateStatus(ctx);
          return;
        }
        case "profile": {
          const allTools = pi.getAllTools().map((t) => t.name);
          if (command.name === null) {
            const active = currentProfileName(profilesConfig, allTools, state.sourceToggles);
            const lines: string[] = [];
            if (profilesLoadError !== null) lines.push(profilesLoadError);
            lines.push(`Active: ${active ?? "(custom toggle state, matches no profile)"}`);
            lines.push("");
            lines.push(`  ${active === ALL_PROFILE ? "*" : " "} all — every tool enabled (built-in)`);
            for (const [name, profile] of Object.entries(profilesConfig?.profiles ?? {})) {
              lines.push(`  ${active === name ? "*" : " "} ${name} — ${profile.description}`);
              lines.push(`      tools: ${profile.tools.join(", ")}`);
            }
            lines.push("");
            lines.push("Apply with /context profile <name>. Define profiles in policy/profiles.json (then /reload).");
            emit("tool profiles", lines);
            return;
          }
          applyNamedProfile(ctx, command.name);
          return;
        }
        case "toggle": {
          const targets = knownToggleTargets(ctx);
          const resolved = resolveToggleTarget(command.name, targets);
          if ("error" in resolved) {
            ctx.ui.notify(resolved.error, "error");
            return;
          }
          if (!resolved.toggleable) {
            ctx.ui.notify(
              `"${resolved.name}" is not toggleable (Pi provides no honest way to exclude it).`,
              "warning",
            );
            return;
          }
          const nowEnabled = !(state.sourceToggles[resolved.name] !== false);
          if (nowEnabled) {
            delete state.sourceToggles[resolved.name];
          } else {
            state.sourceToggles[resolved.name] = false;
          }
          if (resolved.kind === "tool") {
            const bare = resolved.name.slice("tool:".length);
            if (nowEnabled) {
              const all = pi.getAllTools().map((t) => t.name);
              const active = pi.getActiveTools();
              if (all.includes(bare) && !active.includes(bare)) {
                pi.setActiveTools([...active, bare]);
              }
            } else {
              pi.setActiveTools(pi.getActiveTools().filter((t) => t !== bare));
            }
          }
          persist();
          updateStatus(ctx);
          const effect =
            resolved.kind === "tool"
              ? nowEnabled
                ? "restored to the model's tool list"
                : "removed from the model's tool list"
              : nowEnabled
                ? "will be included in the system prompt"
                : "will be excised from the system prompt (verified each turn; you'll be warned if excision fails)";
          ctx.ui.notify(`${resolved.name}: ${nowEnabled ? "enabled" : "disabled"} — ${effect}.`, "info");
          return;
        }
      }
    },
  });

  pi.registerCommand("mode", {
    description: "Show or set the mode (plan/manual/accept/auto)",
    getArgumentCompletions: (prefix) => {
      const subs = ["plan", "manual", "accept", "auto"];
      const matches = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const command = parseModeArgs(args);
      if (command.kind === "usage") {
        emit("usage", [`Unknown mode "${command.attempted ?? ""}".`, ...USAGE.mode]);
        return;
      }
      if (command.kind === "show") {
        emit("mode", [
          `Current mode: ${displayMode(state.phase, state.autonomy, policy !== null)}`,
          "",
          ...USAGE.mode,
        ]);
        return;
      }
      setMode(ctx, command.mode, command.sandboxAlias);
    },
  });

  const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  type EffortLevel = Parameters<typeof pi.setThinkingLevel>[0];
  pi.registerCommand("effort", {
    description: "Show or set the thinking level (off/minimal/low/medium/high/xhigh/max)",
    getArgumentCompletions: (prefix) => {
      const matches = EFFORT_LEVELS.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const requested = (args ?? "").trim().toLowerCase();
      if (requested === "") {
        emit("effort", [
          `Thinking level: ${pi.getThinkingLevel()}`,
          `Usage: /effort ${EFFORT_LEVELS.join("|")}`,
        ]);
        return;
      }
      if (!(EFFORT_LEVELS as readonly string[]).includes(requested)) {
        emit("effort", [
          `Unknown thinking level "${requested}".`,
          `Usage: /effort ${EFFORT_LEVELS.join("|")}`,
        ]);
        return;
      }
      pi.setThinkingLevel(requested as EffortLevel);
      emit("effort", [
        `Thinking level set to ${pi.getThinkingLevel()} (requested ${requested}; clamped to model capabilities).`,
      ]);
    },
  });

  pi.registerCommand("scratchpad", {
    description: "Structured working notes that survive /compact (show, add, remove, clear)",
    getArgumentCompletions: (prefix) => {
      const subs = ["add ", "remove ", "clear"];
      const matches = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s.trim() })) : null;
    },
    handler: async (args, ctx) => {
      const command = parseScratchpadArgs(args);
      switch (command.kind) {
        case "usage":
          emit("usage", [
            "Usage: /scratchpad [add <text>|remove <id>|clear]",
            "  /scratchpad          — list current notes",
            "  /scratchpad add <text>  — add a note (survives /compact)",
            "  /scratchpad remove <id> — remove one note by id",
            "  /scratchpad clear       — remove all notes (asks to confirm)",
          ]);
          return;
        case "show":
          emit("scratchpad", renderScratchpadList(scratchpad));
          return;
        case "add": {
          const id = generateNoteId(new Set(scratchpad.notes.map((n) => n.id)));
          const result = addNote(scratchpad, command.text, id);
          if (!result.ok) {
            ctx.ui.notify(result.error, "error");
            return;
          }
          scratchpad = result.scratchpad;
          persistScratchpad();
          ctx.ui.notify(`Note (${result.note.id}) added.`, "info");
          return;
        }
        case "remove": {
          const result = removeNote(scratchpad, command.id);
          if (!result.ok) {
            ctx.ui.notify(result.error, "error");
            return;
          }
          scratchpad = result.scratchpad;
          persistScratchpad();
          ctx.ui.notify(`Note (${command.id}) removed.`, "info");
          return;
        }
        case "clear": {
          if (scratchpad.notes.length === 0) {
            ctx.ui.notify("Scratchpad is already empty.", "info");
            return;
          }
          let confirmed = command.force;
          if (!confirmed && ctx.hasUI) {
            confirmed = await ctx.ui.confirm(
              "Clear the scratchpad?",
              `This removes all ${scratchpad.notes.length} note(s). This cannot be undone.`,
            );
          } else if (!confirmed) {
            ctx.ui.notify('No confirmation UI available. Use "/scratchpad clear force" to clear without a dialog.', "warning");
            return;
          }
          if (!confirmed) {
            ctx.ui.notify("Clear cancelled.", "info");
            return;
          }
          scratchpad = clearScratchpad();
          persistScratchpad();
          ctx.ui.notify("Scratchpad cleared.", "info");
          return;
        }
      }
    },
  });

  pi.registerCommand("bwrap", {
    description: "Real OS-level sandboxing for bash (bubblewrap)",
    getArgumentCompletions: (prefix) => {
      const subs = ["status", "on", "off", "network on", "network off"];
      const matches = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const command = parseBwrapArgs(args);
      switch (command.kind) {
        case "usage":
          emit("usage", [
            "Usage: /bwrap [status|on|off|network on|network off]",
            "  /bwrap             — show current sandbox status",
            "  /bwrap on          — wrap every allowed bash call in bubblewrap (unprivileged",
            "                       Linux namespaces): project root read-write, system",
            "                       toolchains + $HOME read-only, credential paths from",
            "                       policy/default-policy.json blanked, network unshared",
            "  /bwrap off         — stop wrapping bash calls (default)",
            "  /bwrap network on  — allow sandboxed commands to reach the network",
            "  /bwrap network off — unshare networking again (default when sandbox is on)",
            "",
            "This is real kernel-enforced isolation via bwrap, independent of the Pi-level",
            "tool-policy checks. See docs/SECURITY.md for exactly what bwrap does and does",
            "not guarantee.",
          ]);
          return;
        case "status": {
          const bwrapLine = isBwrapAvailable() ? "bwrap binary: found on PATH" : "bwrap binary: NOT found on PATH";
          emit("bwrap", [
            `Sandbox: ${sandbox.enabled ? "on" : "off"}`,
            `Network: ${sandbox.network ? "on (shared)" : "off (unshared)"}`,
            bwrapLine,
          ]);
          return;
        }
        case "on": {
          if (!isBwrapAvailable()) {
            ctx.ui.notify(
              "The `bwrap` (bubblewrap) binary was not found on PATH. Install it first - sandboxing cannot be enabled without it.",
              "error",
            );
            return;
          }
          sandbox = { ...sandbox, enabled: true };
          persistSandbox();
          updateStatus(ctx);
          ctx.ui.notify(
            `Bwrap sandbox enabled (network ${sandbox.network ? "on" : "off"}). Every allowed bash call now runs isolated.`,
            "info",
          );
          return;
        }
        case "off": {
          sandbox = { ...sandbox, enabled: false };
          persistSandbox();
          updateStatus(ctx);
          ctx.ui.notify("Bwrap sandbox disabled. Bash calls run directly on the host again.", "info");
          return;
        }
        case "network": {
          sandbox = { ...sandbox, network: command.on };
          persistSandbox();
          updateStatus(ctx);
          ctx.ui.notify(
            `Sandbox networking ${command.on ? "enabled" : "disabled"}.` +
              (sandbox.enabled ? "" : " (Sandbox is currently off; this takes effect once /bwrap on is run.)"),
            "info",
          );
          return;
        }
      }
    },
  });

  pi.registerCommand("harness-rules", {
    description: "Save, list, or revoke remembered soft-policy rules (Always-allow decisions)",
    getArgumentCompletions: (prefix) => {
      const subs = ["list", "allow ", "revoke ", "clear", "headless "];
      const matches = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s.trim() })) : null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      if (sub === "list" || parts.length === 0) {
        emit("harness-rules", [
          ...renderRulesList(rememberedRules),
          "",
          "Save: /harness-rules allow <tool> <path>   Revoke: /harness-rules revoke <id>   Clear: /harness-rules clear",
          `Apply without a confirmation UI: ${rememberedRules.applyWithoutUi === true ? "on" : "off"} (/harness-rules headless on|off)`,
        ]);
        return;
      }
      // The only switch that lets a confirm gate be satisfied with no UI. It
      // does not create approvals - it decides whether the ones the user
      // already saved apply when nobody can answer a dialog, which is what a
      // non-interactive or piped session needs.
      if (sub === "headless") {
        const target = (parts[1] ?? "").toLowerCase();
        if (target !== "on" && target !== "off") {
          ctx.ui.notify("Usage: /harness-rules headless on|off", "warning");
          return;
        }
        rememberedRules = { ...rememberedRules, applyWithoutUi: target === "on" };
        persistRules();
        emit("harness-rules", [
          target === "on"
            ? "Remembered rules now apply in sessions with no confirmation UI. Only calls matching a rule you already saved are allowed; everything else still fails closed."
            : "Remembered rules no longer apply without a confirmation UI (default). A no-UI session fails closed on every confirm.",
        ]);
        return;
      }
      if (sub === "allow") {
        const tool = parts[1];
        const rawTarget = parts.slice(2).join(" ");
        if (tool === undefined || rawTarget.length === 0) {
          ctx.ui.notify("Usage: /harness-rules allow <tool> <path>", "warning");
          return;
        }
        const canonical = canonicalizePath(rawTarget, ctx.cwd, pathOps);
        if (canonical === null) {
          ctx.ui.notify(`Could not resolve path "${rawTarget}".`, "warning");
          return;
        }
        // Sensitive reads stay unrememberable-as-allow (hard boundary).
        if (tool === "read" && isSensitiveReadTarget(canonical, agentDir(), sensitiveReadExtra())) {
          ctx.ui.notify(
            `Refused: "${canonical}" is a sensitive path; a sensitive read cannot be remembered as allow.`,
            "warning",
          );
          return;
        }
        const scopeRoot = rootOf(ctx as ExtensionContext);
        const result = addRule(rememberedRules, { tool, target: canonical, scopeRoot }, new Date().toISOString());
        if (result.rule === null) {
          ctx.ui.notify("Remembered-rule limit reached; not saved.", "warning");
          return;
        }
        if (result.duplicate) {
          ctx.ui.notify(`Already remembered: allow ${tool} on ${canonical} (rule ${result.rule.id}).`, "info");
          return;
        }
        rememberedRules = result.state;
        persistRules();
        pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
          kind: "remembered-rule-added",
          actor: "user",
          provenance: "harness-rules-command",
          ruleId: result.rule.id,
          toolName: tool,
          target: canonical,
          scopeRoot,
          at: new Date().toISOString(),
        });
        ctx.ui.notify(
          `Remembered: allow ${tool} on ${canonical} (rule ${result.rule.id}). Revoke with /harness-rules revoke ${result.rule.id}.`,
          "info",
        );
        return;
      }
      if (sub === "revoke" || sub === "remove") {
        const id = parts[1];
        if (id === undefined) {
          ctx.ui.notify("Usage: /harness-rules revoke <id>  (see /harness-rules list for ids)", "warning");
          return;
        }
        const result = removeRule(rememberedRules, id, new Date().toISOString());
        if (result.removed === null) {
          ctx.ui.notify(`No remembered rule with id "${id}".`, "warning");
          return;
        }
        rememberedRules = result.state;
        persistRules();
        pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
          kind: "remembered-rule-revoked",
          actor: "user",
          ruleId: id,
          at: new Date().toISOString(),
        });
        ctx.ui.notify(
          `Revoked rule ${id} (was: allow ${result.removed.tool} on ${result.removed.target}).`,
          "info",
        );
        return;
      }
      if (sub === "clear") {
        const count = rememberedRules.rules.length;
        rememberedRules = emptyRules(new Date().toISOString());
        persistRules();
        pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
          kind: "remembered-rules-cleared",
          actor: "user",
          count,
          at: new Date().toISOString(),
        });
        ctx.ui.notify(`Cleared ${count} remembered rule(s).`, "info");
        return;
      }
      ctx.ui.notify("Usage: /harness-rules [list|revoke <id>|clear]", "warning");
    },
  });

  // ---- web search tool (searxng-backed, see websearch.ts) ----
  // Named "local_web_search", not the more obvious "web_search": pi-web-access
  // (if installed) already registers a tool literally named "web_search", and
  // Pi's tool registry is last-registered-wins with no collision detection or
  // picker - reusing that name would silently shadow whichever one loads
  // second, not error or merge. See the note on READ_TOOLS in tool-policy.ts.

  if (TypeBoxType !== null) {
    const T = TypeBoxType;
    pi.registerTool({
      name: "local_web_search",
      label: "Local Web Search",
      description:
        "Search the web via the user's local searxng instance (free, no API key). Read-only: never mutates anything, available in every mode including read-only Plan.",
      promptSnippet: "local_web_search(query) — search the web via local searxng",
      parameters: T.Object({
        query: T.String({ description: "The search query." }),
      }) as never,
      execute: async (_toolCallId, params) => {
        const query = (params as { query: string }).query;
        const fetchGet: GetFetch = async (url) => {
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
          return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
        };
        const baseUrl = process.env.PI_CONTROL_PLANE_SEARXNG_URL ?? DEFAULT_SEARXNG_BASE_URL;
        const outcome = await searchSearxng(baseUrl, query, fetchGet, MAX_SEARCH_RESULTS);
        return { output: formatSearchResults(outcome) } as never;
      },
    });

    // ---- audio transcription tool (whisper-voicemail, see transcription.ts) ----
    // Backed by the `whisper-voicemail` llama-swap model. Read-only in the
    // same sense as local_web_search: it uploads a file the user pointed at
    // and returns text, mutating nothing.
    pi.registerTool({
      name: "transcribe_audio",
      label: "Transcribe Audio",
      // Pi executes sibling tool calls in parallel unless any tool in the
      // batch opts into sequential execution. whisper-server owns one mutable
      // model context: two simultaneous uploads both returned HTTP 200 in a
      // live directory test, but their text drifted from the deterministic
      // single-file baselines. Serialize the whole sibling batch whenever it
      // contains transcription so each result has an isolated inference.
      executionMode: "sequential",
      description:
        "Transcribe a voicemail, call recording or other audio/video file to plain text using the local whisper large-v3-turbo model. Accepts any ffmpeg-readable container (wav, mp3, mp4, m4a, ogg, opus, ...). Phone numbers come back as digits (555-1234), never spelled out as words. Read-only: uploads the file to a loopback service and returns text.",
      promptSnippet:
        "transcribe_audio(path) — transcribe a local audio/video file to text via the local whisper model",
      parameters: T.Object({
        path: T.String({
          description: "Path to the audio or video file to transcribe.",
        }),
        language: T.Optional(
          T.String({
            description:
              'Spoken-language hint such as "en", or "auto" to let the model detect it. Defaults to "en".',
          }),
        ),
      }) as never,
      execute: async (_toolCallId, params) => {
        const { path: audioPath, language } = params as { path: string; language?: string };
        const resolved = path.resolve(audioPath.replace(/^~(?=$|\/)/, os.homedir()));

        let bytes: Buffer;
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isFile()) {
            return {
              content: [{ type: "text", text: `Transcription failed: not a file: ${resolved}` }],
            } as never;
          }
          bytes = fs.readFileSync(resolved);
        } catch {
          return {
            content: [
              { type: "text", text: `Transcription failed: audio file not found: ${resolved}` },
            ],
          } as never;
        }

        // See TRANSCRIPTION_TIMEOUT_MS: a generous ceiling covering a
        // llama-swap cold start, not a typical HTTP call.
        const postAudio: PostAudio = async (url, request) => {
          const form = new FormData();
          form.append("file", new Blob([request.bytes]), request.filename);
          form.append("model", request.model);
          form.append("response_format", "json");
          form.append("temperature", "0");
          // Always sent, including the literal "auto": whisper-server runs
          // with `-l en`, so omitting it would mean English, not detection.
          form.append("language", request.language);
          const res = await fetch(url, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
          });
          return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
        };

        const baseUrl =
          process.env.PI_CONTROL_PLANE_TRANSCRIBE_URL ?? DEFAULT_TRANSCRIPTION_BASE_URL;
        const outcome = await transcribeAudio(
          baseUrl,
          {
            filename: path.basename(resolved),
            bytes,
            language: language ?? DEFAULT_TRANSCRIPTION_LANGUAGE,
            model: process.env.PI_CONTROL_PLANE_TRANSCRIBE_MODEL ?? DEFAULT_TRANSCRIPTION_MODEL,
          },
          postAudio,
        );
        return {
          content: [{ type: "text", text: formatTranscript(outcome) }],
        } as never;
      },
    });

    // ---- task tracking tool (see todo.ts) ----
    // Replaces rpiv-todo's same-named tool (that package was removed: it
    // could not be restyled or repositioned, and two tools named "todo" would
    // collide silently in Pi's flat last-registered-wins registry). One task
    // list, owned by this package: the model calls this tool, the user sees
    // the top-right widget, and the list is re-injected into the system prompt
    // every turn so open tasks survive compaction. Read-classified: it mutates
    // only its own state store and session entry.
    pi.registerTool({
      name: "todo",
      label: "Task List",
      description:
        "Track the tasks in the current workload. Ops: 'list' (show open tasks), 'add' (text: new task), 'done' (id: complete and remove), 'undo' (id: reopen a legacy completed task), 'remove' (id: delete), 'clear' (remove legacy completed tasks). Completing a task writes its completion to the conversation and removes it from the live widget and system prompt. Open tasks survive compaction. Structuring work with this tool is expected for multi-step tasks.",
      promptSnippet: "todo(op, id?, text?) — track tasks: list|add|done|undo|remove|clear",
      promptGuidelines: [
        "For multi-step work, use todo to add concrete tasks before execution, mark each task done immediately after completion, and keep unfinished tasks open.",
      ],
      parameters: T.Object({
        op: T.String({
          description: "One of: list, add, done, undo, remove, clear.",
        }),
        id: T.Optional(
          T.Number({ description: "Task id (for done, undo, remove)." }),
        ),
        text: T.Optional(
          T.String({ description: "Task text (for add)." }),
        ),
      }) as never,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const { op, id, text } = params as { op?: string; id?: number; text?: string };
        const now = new Date().toISOString();
        if (op === "list") {
          return { content: [{ type: "text", text: renderTodoList(todo).join("\n") }] } as never;
        }
        let result: TodoOpResult;
        switch (op) {
          case "add":
            result = addTodo(todo, text ?? "", now);
            break;
          case "done":
            result = completeTodo(todo, typeof id === "number" ? id : 0, now);
            break;
          case "undo":
            result = reopenTodo(todo, typeof id === "number" ? id : 0, now);
            break;
          case "remove":
            result = removeTodo(todo, typeof id === "number" ? id : 0, now);
            break;
          case "clear":
            result = clearCompleted(todo, now);
            break;
          default:
            result = { ok: false, error: `Unknown op "${op}". Use list, add, done, undo, remove or clear.` };
        }
        if (result.ok && result.state !== todo) {
          todo = result.state as TodoState;
          persistTodo(ctx);
          if (op === "done") {
            pi.appendEntry<TodoCompletionEntryData>(TODO_COMPLETION_ENTRY_TYPE, { message: result.message });
          }
          refreshTodoWidget();
        }
        const body = result.ok
          ? `${result.message}\n\n${renderTodoList(result.state).join("\n")}`
          : result.error;
        return { content: [{ type: "text", text: body }] } as never;
      },
    });
  }

  // ---- context editor (alt+e) ----

  const pickEditor = (): string | null => {
    for (const candidate of ["nvim", "vim"]) {
      try {
        const found = process.env.PATH?.split(path.delimiter).some((dir) =>
          fs.existsSync(path.join(dir, candidate)),
        );
        if (found) return candidate;
      } catch {
        // keep looking
      }
    }
    return null;
  };

  /**
   * Suspend the TUI, open the content in nvim/vim, resume, and return the
   * edited text (null on cancel/error). Uses the same stop/spawn/start
   * pattern as Pi's own external-editor support. The temp file holds raw
   * context (user-initiated), is chmod 600, and is always deleted.
   */
  const editInEditor = (ctx: ExtensionContext, initial: string): Promise<string | null> => {
    const uiAny = ctx.ui as { custom?: <T>(factory: unknown, options?: unknown) => Promise<T> };
    if (ctx.mode !== "tui" || typeof uiAny.custom !== "function") {
      ctx.ui.notify("The context editor needs the interactive TUI.", "error");
      return Promise.resolve(null);
    }
    const editor = pickEditor();
    if (editor === null) {
      ctx.ui.notify("Neither nvim nor vim was found on PATH.", "error");
      return Promise.resolve(null);
    }
    return uiAny.custom<string | null>((tui: { stop(): void; start(): void; requestRender(force?: boolean): void }, _theme: unknown, _kb: unknown, done: (r: string | null) => void) => {
      setTimeout(async () => {
        const tmpFile = path.join(os.tmpdir(), `pi-control-plane-ctx-${process.pid}-${Date.now()}.md`);
        let result: string | null = null;
        try {
          fs.writeFileSync(tmpFile, initial, { encoding: "utf8", mode: 0o600 });
          tui.stop();
          const code = await new Promise<number | null>((resolve) => {
            const child = spawn(editor, [tmpFile], { stdio: "inherit" });
            child.on("error", () => resolve(null));
            child.on("close", (c) => resolve(c));
          });
          if (code === 0) result = fs.readFileSync(tmpFile, "utf8");
        } catch {
          result = null;
        } finally {
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            // ignore cleanup failure
          }
          tui.start();
          tui.requestRender(true);
          done(result);
        }
      }, 10);
      return { render: () => [] };
    });
  };

  const runContextEditor = async (ctx: ExtensionContext, opts: { includeDraft: boolean }) => {
    // lastContextMessages is the merged view when an overlay is active, so
    // re-edits see previous edits plus any newer live messages.
    const baseMessages = lastContextMessages;
    let systemPrompt = contextOverlay?.systemPrompt ?? lastBaseSystemPrompt;
    if (systemPrompt === null) {
      try {
        systemPrompt = ctx.getSystemPrompt();
      } catch {
        systemPrompt = "";
      }
    }
    const messages = baseMessages ?? [];
    let draft: string | undefined;
    if (opts.includeDraft) {
      try {
        draft = ctx.ui.getEditorText();
      } catch {
        draft = "";
      }
    }
    const serialized =
      serializeContext(systemPrompt, messages, {
        draft,
        previewLines: opts.includeDraft
          ? [
              "──── appended automatically to the system prompt each turn (read-only preview): ────",
              ...buildInjectionBlock(state, policy !== null).split("\n"),
            ]
          : undefined,
      }) +
      (baseMessages === null
        ? "\n## Note: no LLM call has happened yet this session, so there are no messages to edit.\n"
        : "");
    const edited = await editInEditor(ctx, serialized);
    if (edited === null) {
      ctx.ui.notify("Context edit cancelled.", "info");
      return;
    }
    if (edited === serialized) {
      ctx.ui.notify("No changes made.", "info");
      return;
    }
    const parsed = parseEditedContext(edited, messages.length);
    if (!parsed.ok) {
      ctx.ui.notify(`Context edit rejected: ${parsed.error}`, "error");
      return;
    }
    const applied = applyEdits(messages, parsed.edit);
    const systemPromptChanged = parsed.edit.systemPrompt !== systemPrompt;
    const draftChanged =
      opts.includeDraft && parsed.edit.draft !== null && parsed.edit.draft !== (draft ?? "");
    if (draftChanged) {
      try {
        ctx.ui.setEditorText(parsed.edit.draft!);
      } catch {
        ctx.ui.notify("Could not update the draft in the input editor.", "warning");
      }
    }
    if (applied.editedCount === 0 && applied.droppedCount === 0 && !systemPromptChanged) {
      ctx.ui.notify(draftChanged ? "Draft updated; context unchanged." : "No effective changes.", "info");
      return;
    }
    contextOverlay = {
      messages: applied.messages,
      // Anchor to the live conversation length so future messages append cleanly.
      baseCount: lastIncomingCount,
      systemPrompt: systemPromptChanged ? parsed.edit.systemPrompt : (contextOverlay?.systemPrompt ?? null),
      createdAt: new Date().toISOString(),
    };
    lastContextMessages = applied.messages;
    updateStatus(ctx);
    const summary = [
      systemPromptChanged ? "system prompt edited" : null,
      applied.editedCount > 0 ? `${applied.editedCount} message(s) edited` : null,
      applied.droppedCount > 0 ? `${applied.droppedCount} message(s) removed` : null,
      draftChanged ? "draft updated" : null,
    ]
      .filter(Boolean)
      .join(", ");
    ctx.ui.notify(
      `Context override active (${summary}). Applies to future turns this session; "/context restore" undoes it.`,
      "info",
    );
  };

  // ---- hotkeys ----

  pi.registerShortcut("alt+e", {
    description: "Control plane: view/edit session context in nvim",
    handler: async (ctx) => {
      await runContextEditor(ctx, { includeDraft: false });
    },
  });

  pi.registerShortcut("alt+s", {
    description: "Control plane: send preview — everything the next message sends, editable",
    handler: async (ctx) => {
      await runContextEditor(ctx, { includeDraft: true });
    },
  });

  pi.registerShortcut("alt+c", {
    description: "Control plane: toggle context preview widget",
    handler: (ctx) => {
      if (widgetVisible) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        widgetVisible = false;
        return;
      }
      const snapshot = buildCurrentSnapshot(ctx);
      const lines = renderContextSummary(snapshot, { compactHint: false }).map((line) =>
        line.length > 0 ? line : " ",
      );
      (ctx.ui.setWidget as (key: string, factory: unknown, options?: unknown) => void)(
        WIDGET_KEY,
        (_tui: unknown) => ({ render: (w: number) => clipLines(lines, w), invalidate() {} }),
        { placement: "aboveEditor" },
      );
      widgetVisible = true;
    },
  });

  pi.registerShortcut("alt+h", {
    description: "Control plane: hotkey cheat sheet (modal)",
    handler: async (ctx) => {
      const uiAny = ctx.ui as {
        custom?: <T>(factory: unknown, options?: unknown) => Promise<T>;
      };
      if (ctx.mode !== "tui" || typeof uiAny.custom !== "function") {
        emit("hotkeys", renderHotkeyCheatsheet());
        return;
      }
      if (hotkeysModalOpen) return;
      hotkeysModalOpen = true;
      try {
        await uiAny.custom<void>(
          (_tui: unknown, theme: { fg(color: string, text: string): string }, _kb: unknown, done: (r: void) => void) => ({
            render: (width: number) => {
              const lines = renderHotkeyCheatsheet();
              const inner = Math.max(20, Math.min(width - 6, Math.max(...lines.map((l) => l.length)) + 2));
              const top = "╭" + "─".repeat(inner + 2) + "╮";
              const bottom = "╰" + "─".repeat(inner + 2) + "╯";
              const body = lines.map((line, i) => {
                const clipped = line.length > inner ? line.slice(0, inner - 1) + "…" : line;
                const padded = clipped.padEnd(inner);
                return "│ " + (i === 0 ? theme.fg("accent", padded) : padded) + " │";
              });
              return clipLines([top, ...body, bottom], width);
            },
            handleInput: () => done(undefined),
          }),
          { overlay: true, overlayOptions: { width: "85%", maxHeight: "90%" } },
        );
      } finally {
        hotkeysModalOpen = false;
      }
    },
  });

  // Diagnostics panel. Workspace dimming is NOT available in pi-tui (no
  // scrim/backdrop primitive; overlays composite over content), so the
  // terminal-native equivalent is an opaque panel: every line is painted with
  // customMessageBg after padding to the panel width, so nothing beneath shows
  // through its region. Hover is not implemented either: pi-tui routes mouse
  // events only in fullscreen mode, which this extension does not enable;
  // focus is conveyed by the selected row alone (selectedBg + accent glyph).
  let diagnosticsModalOpen = false;
  pi.registerShortcut("alt+i", {
    description: "Control plane: diagnostics panel (modal)",
    handler: async (ctx) => {
      const uiAny = ctx.ui as { custom?: <T>(factory: unknown, options?: unknown) => Promise<T> };
      const rows = (ctx.sessionManager.getBranch() as unknown as CustomEntryLike[])
        .filter((e) => e.customType === DIAGNOSTIC_ENTRY_TYPE)
        .map((e) => describeDiagnostic(e.data as Record<string, unknown> | undefined));
      if (ctx.mode !== "tui" || typeof uiAny.custom !== "function") {
        emit(
          "diagnostics",
          rows.length
            ? rows.map((r) => `${r.glyph} ${r.label}${r.subject ? ` ${r.subject}` : ""}${r.at ? `  ${r.at}` : ""}`)
            : ["(no diagnostics this session)"],
        );
        return;
      }
      if (diagnosticsModalOpen) return;
      diagnosticsModalOpen = true;
      try {
        await uiAny.custom<void>(
          (
            tui: { requestRender(force?: boolean): void },
            theme: { fg(color: string, text: string): string; bg?(color: string, text: string): string },
            _kb: unknown,
            done: (r: void) => void,
          ) => {
            let selectedIndex = Math.max(0, rows.length - 1);
            const bg = (color: string, s: string) => (typeof theme.bg === "function" ? theme.bg(color, s) : s);
            const paint = {
              bg: (s: string) => bg("customMessageBg", s),
              selectedBg: (s: string) => bg("selectedBg", s),
              fg: (color: string, s: string) => theme.fg(color, s),
            };
            return {
              render: (width: number) => {
                // Overlay maxHeight is 60% of the terminal; 7 chrome rows.
                const maxRows = Math.max(1, Math.floor((process.stdout.rows ?? 24) * 0.6) - 7);
                return clipLines(
                  renderDiagnosticsPanel(rows, selectedIndex, width, paint, maxRows, measureWidth, clipLine),
                  width,
                );
              },
              handleInput: (data: string) => {
                if (keyIs(data, "up", ["\x1b[A", "k"])) {
                  selectedIndex = Math.max(0, selectedIndex - 1);
                  tui.requestRender();
                } else if (keyIs(data, "down", ["\x1b[B", "j"])) {
                  selectedIndex = Math.min(Math.max(0, rows.length - 1), selectedIndex + 1);
                  tui.requestRender();
                } else if (
                  keyIs(data, "enter", ["\r", "\n"]) ||
                  keyIs(data, "escape", ["\x1b"]) ||
                  keyIs(data, "ctrl+c", ["\x03"]) ||
                  data === "q"
                ) {
                  done(undefined);
                }
              },
            };
          },
          { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 40, maxHeight: "60%" } },
        );
      } finally {
        diagnosticsModalOpen = false;
      }
    },
  });

  let profileModalOpen = false;
  pi.registerShortcut("ctrl+alt+t", {
    description: "Control plane: tool-profile picker (modal)",
    handler: async (ctx) => {
      const uiAny = ctx.ui as { custom?: <T>(factory: unknown, options?: unknown) => Promise<T> };
      if (ctx.mode !== "tui" || typeof uiAny.custom !== "function") {
        ctx.ui.notify("The profile picker needs the interactive TUI. Use /context profile instead.", "warning");
        return;
      }
      if (profileModalOpen) return;
      const allTools = pi.getAllTools().map((t) => t.name);
      const active = currentProfileName(profilesConfig, allTools, state.sourceToggles);
      const defaultName = profilesConfig?.defaultProfile ?? null;
      const items: ProfilePickerItem[] = [
        {
          name: ALL_PROFILE,
          description: "Every tool enabled (built-in).",
          tools: [...allTools].sort(),
          active: active === ALL_PROFILE,
          isDefault: defaultName === ALL_PROFILE,
        },
        ...Object.entries(profilesConfig?.profiles ?? {}).map(([name, profile]) => ({
          name,
          description: profile.description,
          tools: [...profile.tools].sort(),
          active: active === name,
          isDefault: defaultName === name,
        })),
      ];
      profileModalOpen = true;
      try {
        type PickerChoice = { kind: "session" | "default"; name: string } | null;
        const chosen = await uiAny.custom<PickerChoice>(
          (
            tui: { requestRender(force?: boolean): void },
            _theme: unknown,
            _kb: unknown,
            done: (r: PickerChoice) => void,
          ) => {
            let selectedIndex = Math.max(0, items.findIndex((item) => item.active));
            return {
              render: (width: number) =>
                clipLines(renderProfilePicker(items, selectedIndex, Math.min(width, 100)), width),
              handleInput: (data: string) => {
                if (keyIs(data, "up", ["\x1b[A", "k"])) {
                  selectedIndex = (selectedIndex + items.length - 1) % items.length;
                  tui.requestRender();
                } else if (keyIs(data, "down", ["\x1b[B", "j", "\t"])) {
                  selectedIndex = (selectedIndex + 1) % items.length;
                  tui.requestRender();
                } else if (keyIs(data, "enter", ["\r", "\n"])) {
                  done({ kind: "session", name: items[selectedIndex].name });
                } else if (keyIs(data, "space", [" "])) {
                  done({ kind: "default", name: items[selectedIndex].name });
                } else if (
                  keyIs(data, "escape", ["\x1b"]) ||
                  keyIs(data, "ctrl+c", ["\x03"]) ||
                  data === "q"
                ) {
                  done(null);
                }
              },
            };
          },
          { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
        );
        if (chosen !== null) {
          if (chosen.kind === "default") {
            // Space = make it the default for new sessions AND switch to it now.
            if (setDefaultProfile(ctx, chosen.name)) applyNamedProfile(ctx, chosen.name);
          } else {
            applyNamedProfile(ctx, chosen.name);
          }
        }
      } finally {
        profileModalOpen = false;
      }
    },
  });

  const cycleModeHandler = (ctx: ExtensionContext) => {
    // Combos with no mode (restored old sessions) enter the cycle at plan.
    const current = modeOf(state.phase, state.autonomy) ?? "plan";
    setMode(ctx, cycleMode(current), false);
  };

  pi.registerShortcut("alt+p", {
    description: "Control plane: cycle mode",
    handler: cycleModeHandler,
  });

  // shift+tab is pi's default "cycle thinking level" binding; that keybinding
  // is unbound in ~/.pi/agent/keybindings.json ("app.thinking.cycle": []) so
  // this shortcut can claim the key. Thinking level moves to /effort.
  pi.registerShortcut("shift+tab", {
    description: "Control plane: cycle mode",
    handler: cycleModeHandler,
  });
}
