/**
 * Pi Control Plane — extension entry point.
 *
 * Registers the /context, /task, /phase, /autonomy, and /interpret commands,
 * the tool-authorization hook, per-turn state injection, session persistence,
 * the footer status segment, and three hotkeys (alt+c context preview,
 * alt+p phase cycle, alt+a autonomy cycle).
 *
 * All decision logic lives in ../src/control-plane/ and is unit-tested
 * without Pi. This file is wiring only.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import {
  parseAutonomyArgs,
  parseContextArgs,
  parseInterpretArgs,
  parsePhaseArgs,
  parseTaskArgs,
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
import {
  buildInterpretationPrompt,
  directBrief,
  pendingFromResponse,
} from "../src/control-plane/interpretation.ts";
import { redactSecrets } from "../src/control-plane/redaction.ts";
import {
  type CustomEntryLike,
  cycleAutonomy,
  cyclePhase,
  defaultState,
  restoreFromEntries,
} from "../src/control-plane/state.ts";
import { applyContextFileToggles, replaceSkillsBlock, toggleName } from "../src/control-plane/toggles.ts";
import {
  ALL_PROFILE,
  applyProfile,
  clearToolToggles,
  currentProfileName,
  type ProfilesConfig,
  validateProfiles,
} from "../src/control-plane/profiles.ts";
import { evaluateToolCall, validatePolicy, type PathOps } from "../src/control-plane/tool-policy.ts";
import {
  buildInjectionBlock,
  formatDenial,
  formatFooterStats,
  formatStatus,
  LIMITS,
  type ProfilePickerItem,
  renderContextSummary,
  renderDiff,
  renderHotkeyCheatsheet,
  renderProfilePicker,
  renderSources,
  renderTask,
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
  type SnapshotItem,
  STATE_ENTRY_TYPE,
} from "../src/control-plane/types.ts";

const STATUS_KEY = "control-plane";
const WIDGET_KEY = "control-plane-context";

interface OutputEntryData {
  title: string;
  lines: string[];
}

export default async function controlPlaneExtension(pi: ExtensionAPI) {
  // Pi-provided modules are imported dynamically so the entry can also be
  // loaded by the unit-test harness outside of Pi. Inside Pi both imports
  // resolve; outside, the affected features degrade explicitly (skill toggles
  // report as not applied, entry renderers render nothing).
  let formatSkillsForPrompt: ((skills: { name: string; description: string }[]) => string) | null = null;
  let Box: (new (px?: number, py?: number) => { addChild(c: unknown): void }) | null = null;
  let Text: (new (text: string, px?: number, py?: number) => unknown) | null = null;
  let matchesKey: ((data: string, keyId: string) => boolean) | null = null;
  let visibleWidth: ((text: string) => number) | null = null;
  let truncateToWidth: ((text: string, width: number, ellipsis?: string) => string) | null = null;
  try {
    const piPkg = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      formatSkillsForPrompt: typeof formatSkillsForPrompt;
    };
    formatSkillsForPrompt = piPkg.formatSkillsForPrompt;
  } catch {
    formatSkillsForPrompt = null;
  }
  try {
    const tui = (await import("@earendil-works/pi-tui")) as unknown as {
      Box: typeof Box;
      Text: typeof Text;
      matchesKey: (data: string, keyId: string) => boolean;
      visibleWidth: (text: string) => number;
      truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
    };
    Box = tui.Box;
    Text = tui.Text;
    matchesKey = tui.matchesKey;
    visibleWidth = tui.visibleWidth;
    truncateToWidth = tui.truncateToWidth;
  } catch {
    Box = null;
    Text = null;
    matchesKey = null;
    visibleWidth = null;
    truncateToWidth = null;
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
  let policy: RestrictedPolicy | null = null;
  let policyLoadError: string | null = null;
  let lastPayloadMeta: { length: number; hash: string } | null = null;
  let projectRoot: string | null = null;
  let widgetVisible = false;
  let hotkeysModalOpen = false;
  // Guards against a stale agent_end from a previous turn being mistaken for
  // the interpretation turn: only an agent turn that started while the guard
  // was active may complete the interpretation.
  let interpretTurnStarted = false;
  // Context-editor state (memory only; raw context is never persisted).
  let lastContextMessages: MessageLike[] | null = null;
  /** Length of the live (unmerged) conversation at the last context event. */
  let lastIncomingCount = 0;
  let lastBaseSystemPrompt: string | null = null;
  let contextOverlay: Overlay | null = null;

  const pathOps: PathOps = {
    realpath: (p) => fs.realpathSync(p),
    exists: (p) => fs.existsSync(p),
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

  const updateStatus = (ctx: ExtensionContext) => {
    const percent = ctx.getContextUsage()?.percent ?? null;
    const base = formatStatus(state, percent, policy !== null);
    ctx.ui.setStatus(STATUS_KEY, contextOverlay !== null ? `${base} | Context edited` : base);
  };

  // ---- readable footer ----
  // Replaces pi's compact stats line ("↑4.2k ↓30 R4.2k CH99.2% 8.6%/49k")
  // with plain words. Same data sources as pi's built-in footer; values the
  // extension cannot observe (e.g. the auto-compact toggle) are omitted, not
  // guessed.
  let footerInstalled = false;

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
    const width = (text: string) => (visibleWidth !== null ? visibleWidth(text) : text.length);
    const clip = (text: string, max: number, ellipsis: string) =>
      truncateToWidth !== null ? truncateToWidth(text, max, ellipsis) : text.slice(0, max);
    footerInstalled = true;
    ui.setFooter((_tui, theme, footerData) => ({
      render: (cols: number): string[] => {
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
        const { stats, context } = formatFooterStats({
          input,
          output,
          cacheRead,
          cacheWrite,
          cost,
          cacheHitPercent,
          contextPercent,
          contextWindow,
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
        const pwdLine = clip(
          theme.fg("dim", cwd),
          cols,
          theme.fg("dim", "..."),
        );

        // Line 2: stats left, model right.
        const leftPlain = stats.length > 0 ? `${stats} · ${context}` : context;
        const pct = contextPercent ?? 0;
        const contextColored =
          pct > 90 ? theme.fg("error", context) : pct > 70 ? theme.fg("warning", context) : null;
        let left =
          contextColored !== null
            ? (stats.length > 0 ? theme.fg("dim", `${stats} · `) : "") + contextColored
            : theme.fg("dim", leftPlain);
        let leftWidth = width(leftPlain);
        if (leftWidth > cols) {
          left = clip(theme.fg("dim", leftPlain), cols, theme.fg("dim", "..."));
          leftWidth = cols;
        }
        let right = model?.id ?? "no-model";
        if (model?.reasoning === true) {
          let level = "off";
          try {
            level = pi.getThinkingLevel();
          } catch {
            level = "off";
          }
          right = `${right} · thinking ${level}`;
        }
        if (footerData.getAvailableProviderCount() > 1 && model?.provider !== undefined) {
          const withProvider = `(${model.provider}) ${right}`;
          if (leftWidth + 2 + width(withProvider) <= cols) right = withProvider;
        }
        let statsLine: string;
        if (leftWidth + 2 + width(right) <= cols) {
          const padding = " ".repeat(cols - leftWidth - width(right));
          statsLine = left + theme.fg("dim", padding + right);
        } else {
          statsLine = left;
        }

        // Line 3: extension statuses (includes our own status segment).
        const lines = [pwdLine, statsLine];
        const statuses = Array.from(footerData.getExtensionStatuses().entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
        if (statuses.length > 0) {
          lines.push(clip(statuses.join(" "), cols, theme.fg("dim", "...")));
        }
        return lines;
      },
    }));
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
      hasAcceptedTask: state.acceptedTask !== null,
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

  const setPhase = (ctx: ExtensionContext, phase: ControlPlaneState["phase"]) => {
    state.phase = phase;
    persist();
    updateStatus(ctx);
    const note =
      phase === "execute"
        ? state.acceptedTask === null
          ? " (note: no accepted task brief — consider /interpret or /task set)"
          : ""
        : " (mutating tools are blocked in this phase)";
    ctx.ui.notify(`Phase: ${phase}${note}`, "info");
  };

  const setAutonomy = (ctx: ExtensionContext, autonomy: ControlPlaneState["autonomy"], sandboxAlias: boolean) => {
    state.autonomy = autonomy;
    persist();
    updateStatus(ctx);
    if (sandboxAlias) {
      ctx.ui.notify(SANDBOX_ALIAS_WARNING, "warning");
    }
    if (autonomy === "restricted" && policy === null) {
      ctx.ui.notify(
        "Restricted selected but the policy failed to load/validate — enforcement falls back to Read-only.",
        "warning",
      );
    } else {
      ctx.ui.notify(`Autonomy: ${autonomy}`, "info");
    }
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

  /** Apply a profile by name ("all" included). Notifies on success and failure. */
  const applyNamedProfile = (ctx: ExtensionContext, name: string): boolean => {
    const allTools = pi.getAllTools().map((t) => t.name);
    if (name === ALL_PROFILE) {
      state.sourceToggles = clearToolToggles(state.sourceToggles);
      pi.setActiveTools(allTools);
      persist();
      updateStatus(ctx);
      ctx.ui.notify(`Profile "all": every tool enabled (${allTools.length}).`, "info");
      return true;
    }
    const profile = profilesConfig?.profiles[name];
    if (profile === undefined) {
      const known = [ALL_PROFILE, ...Object.keys(profilesConfig?.profiles ?? {})].join(", ");
      ctx.ui.notify(profilesLoadError ?? `Unknown profile "${name}". Available: ${known}`, "error");
      return false;
    }
    const result = applyProfile(profile.tools, allTools, state.sourceToggles);
    state.sourceToggles = result.toggles;
    pi.setActiveTools(result.enabled);
    persist();
    updateStatus(ctx);
    const missingNote =
      result.missing.length > 0
        ? ` Not present in this session (skipped): ${result.missing.join(", ")}.`
        : "";
    ctx.ui.notify(
      `Profile "${name}": ${result.enabled.length} tool(s) enabled, ${result.disabled.length} disabled.${missingNote}`,
      "info",
    );
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

  pi.registerEntryRenderer<{ kind: string; toolName: string; at: string }>(
    DIAGNOSTIC_ENTRY_TYPE,
    (entry, _options, theme) => {
      if (Text === null) return undefined;
      const data = entry.data;
      return new Text(
        theme.fg(
          "dim",
          `[control plane] diagnostic: blocked tool "${data?.toolName ?? "?"}" during interpretation (${data?.at ?? ""})`,
        ),
        0,
        0,
      ) as never;
    },
  );

  // ---- session lifecycle ----

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch() as unknown as CustomEntryLike[];
    const result = restoreFromEntries(entries, STATE_ENTRY_TYPE);
    state = result.state;
    if (result.ignoredMalformed > 0) {
      ctx.ui.notify(
        `Control plane: ignored ${result.ignoredMalformed} malformed state entr${result.ignoredMalformed === 1 ? "y" : "ies"}; ${result.restored ? "restored an earlier valid state" : "using safe defaults (Discuss + Read-only)"}.`,
        "warning",
      );
    }
    if (policyLoadError !== null) {
      ctx.ui.notify(`Control plane: ${policyLoadError}`, "warning");
    }
    reapplyToolToggles();
    // Fresh sessions (no saved control-plane state) start on the default
    // profile, if one is configured. Restored sessions keep their own toggles.
    const defaultProfile = profilesConfig?.defaultProfile ?? null;
    if (!result.restored && defaultProfile !== null && defaultProfile !== ALL_PROFILE) {
      applyNamedProfile(ctx, defaultProfile);
    }
    installFooter(ctx);
    // Editor state is process/session scoped; a new or resumed session starts clean.
    contextOverlay = null;
    lastContextMessages = null;
    lastBaseSystemPrompt = null;
    updateStatus(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => updateStatus(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));

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

  pi.on("before_provider_request", (event) => {
    try {
      const json = JSON.stringify(event.payload);
      const redacted = redactSecrets(json).text;
      lastPayloadMeta = { length: redacted.length, hash: sha256(redacted) };
    } catch {
      lastPayloadMeta = null;
    }
    // Never persist or return the payload; metadata only.
  });

  // ---- per-turn injection + source toggles ----

  pi.on("before_agent_start", (event, ctx) => {
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
    if (state.interpretGuard?.active) {
      interpretTurnStarted = true;
      prompt +=
        "\n\nINTERPRETATION TURN: every tool is disabled for this turn. Produce only the required interpretation sections. Do not attempt tool calls.";
    }
    updateStatus(ctx);
    return { systemPrompt: prompt };
  });

  // ---- interpretation completion ----

  pi.on("agent_end", (event, ctx) => {
    const guard = state.interpretGuard;
    if (!guard?.active) return;
    if (!interpretTurnStarted) return; // stale agent_end from an earlier turn
    interpretTurnStarted = false;
    let responseText = "";
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const message = event.messages[i] as { role?: string; content?: unknown };
      if (message.role !== "assistant") continue;
      if (typeof message.content === "string") {
        responseText = message.content;
      } else if (Array.isArray(message.content)) {
        responseText = message.content
          .filter((b): b is { type: string; text: string } =>
            typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
          )
          .map((b) => b.text)
          .join("\n");
      }
      break;
    }
    const redacted = redactSecrets(responseText).text;
    const pending = pendingFromResponse(redacted, guard.taskRequest, LIMITS.rawInterpretation);
    state.pendingInterpretation = pending;
    state.phase = guard.savedPhase;
    state.autonomy = guard.savedAutonomy;
    state.interpretGuard = null;
    persist();
    updateStatus(ctx);
    if (pending.valid) {
      ctx.ui.notify(
        "Interpretation ready. Review it above, then run /task accept to adopt it or /task reject to discard it.",
        "info",
      );
    } else {
      ctx.ui.notify(
        `Interpretation is INVALID (missing sections: ${pending.missingSections.join(", ")}). /task accept is disabled; re-run /interpret or /task reject.`,
        "warning",
      );
    }
  });

  // ---- tool authorization ----

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    const decision = evaluateToolCall({
      toolName: event.toolName,
      toolInput: event.input as Record<string, unknown>,
      guardActive: state.interpretGuard?.active ?? false,
      phase: state.phase,
      autonomy: state.autonomy,
      projectRoot: rootOf(ctx),
      cwd: ctx.cwd,
      policy,
      ops: pathOps,
    });

    if (decision.action === "allow") return;

    if (decision.action === "confirm") {
      if (!ctx.hasUI) {
        return {
          block: true,
          reason:
            formatDenial(decision, event.toolName) +
            " No confirmation UI is available in this mode; failing closed.",
        };
      }
      const input = event.input as Record<string, unknown>;
      const command = typeof input.command === "string" ? input.command : null;
      const target = typeof input.path === "string" ? input.path : null;
      const detail = [
        `Tool: ${event.toolName}`,
        `Risk: ${decision.riskCategory}`,
        target !== null ? `Target: ${target}` : null,
        command !== null ? `Command: ${command.length > 200 ? command.slice(0, 200) + "…" : command}` : null,
        `Inside project root: ${decision.insideRoot === null ? "Unavailable" : decision.insideRoot ? "yes" : "no"}`,
        "Model's stated reason: Unavailable (Pi does not expose tool-call rationale)",
        "",
        decision.reason,
      ]
        .filter((line): line is string => line !== null)
        .join("\n");
      const approved = await ctx.ui.confirm(`Allow ${event.toolName}?`, detail);
      if (approved) return;
      return {
        block: true,
        reason: `[control plane] Denied by user confirmation (${decision.rule}). The operation did not run.`,
      };
    }

    // Blocked.
    if (state.interpretGuard?.active) {
      pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, {
        kind: "blocked-tool-during-interpret",
        toolName: event.toolName,
        at: new Date().toISOString(),
      });
    }
    return { block: true, reason: formatDenial(decision, event.toolName) };
  });

  // ---- commands ----

  pi.registerCommand("context", {
    description: "Inspect the effective context (summary, diff, full, sources, toggle)",
    getArgumentCompletions: (prefix) => {
      const subs = ["diff", "full", "sources", "toggle ", "restore", "profile "];
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

  pi.registerCommand("task", {
    description: "Show, set, accept, reject, or clear the control-plane task brief",
    getArgumentCompletions: (prefix) => {
      const subs = ["set ", "accept", "reject", "clear"];
      const matches = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s.trim() })) : null;
    },
    handler: async (args, ctx) => {
      const command = parseTaskArgs(args);
      switch (command.kind) {
        case "usage":
          emit("usage", USAGE.task);
          return;
        case "show":
          emit("task", renderTask(state));
          return;
        case "set": {
          state.acceptedTask = directBrief(command.text);
          persist();
          updateStatus(ctx);
          ctx.ui.notify("Task brief set directly from your text (objective only; nothing fabricated).", "info");
          return;
        }
        case "accept": {
          const pending = state.pendingInterpretation;
          if (pending === null) {
            ctx.ui.notify("No pending interpretation to accept. Run /interpret <request> first.", "error");
            return;
          }
          if (!pending.valid || pending.brief === null) {
            ctx.ui.notify(
              `The pending interpretation is invalid (missing: ${pending.missingSections.join(", ")}) and cannot be accepted. Re-run /interpret or /task reject.`,
              "error",
            );
            return;
          }
          state.acceptedTask = { ...pending.brief, updatedAt: new Date().toISOString() };
          state.pendingInterpretation = null;
          persist();
          updateStatus(ctx);
          ctx.ui.notify("Interpretation accepted as the active task brief.", "info");
          return;
        }
        case "reject": {
          if (state.pendingInterpretation === null) {
            ctx.ui.notify("No pending interpretation to reject.", "info");
            return;
          }
          state.pendingInterpretation = null;
          persist();
          updateStatus(ctx);
          ctx.ui.notify("Pending interpretation discarded. The accepted task (if any) is unchanged.", "info");
          return;
        }
        case "clear": {
          if (state.acceptedTask === null && state.pendingInterpretation === null) {
            ctx.ui.notify("Task state is already empty.", "info");
            return;
          }
          let confirmed = command.force;
          if (!confirmed && ctx.hasUI) {
            confirmed = await ctx.ui.confirm(
              "Clear task state?",
              "This discards the accepted task brief and any pending interpretation.",
            );
          } else if (!confirmed) {
            ctx.ui.notify("No confirmation UI available. Use \"/task clear force\" to clear without a dialog.", "warning");
            return;
          }
          if (!confirmed) {
            ctx.ui.notify("Clear cancelled.", "info");
            return;
          }
          state.acceptedTask = null;
          state.pendingInterpretation = null;
          persist();
          updateStatus(ctx);
          ctx.ui.notify("Task state cleared.", "info");
          return;
        }
      }
    },
  });

  pi.registerCommand("phase", {
    description: "Show or set the workflow phase (discuss/plan/execute/verify)",
    getArgumentCompletions: (prefix) => {
      const subs = ["discuss", "plan", "execute", "verify"];
      const matches = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const command = parsePhaseArgs(args);
      if (command.kind === "usage") {
        emit("usage", [`Unknown phase "${command.attempted ?? ""}".`, ...USAGE.phase]);
        return;
      }
      if (command.kind === "show") {
        emit("phase", [
          `Current phase: ${state.phase}`,
          "",
          ...USAGE.phase,
        ]);
        return;
      }
      setPhase(ctx, command.phase);
    },
  });

  pi.registerCommand("autonomy", {
    description: "Show or set the autonomy level (read-only/attended/restricted)",
    getArgumentCompletions: (prefix) => {
      const subs = ["read-only", "attended", "restricted"];
      const matches = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const command = parseAutonomyArgs(args);
      if (command.kind === "usage") {
        emit("usage", [`Unknown autonomy level "${command.attempted ?? ""}".`, ...USAGE.autonomy]);
        return;
      }
      if (command.kind === "show") {
        emit("autonomy", [
          `Current autonomy: ${state.autonomy}${state.autonomy === "restricted" && policy === null ? " (policy invalid — enforcing Read-only)" : ""}`,
          "",
          ...USAGE.autonomy,
        ]);
        return;
      }
      setAutonomy(ctx, command.autonomy, command.sandboxAlias);
    },
  });

  pi.registerCommand("interpret", {
    description: "Run a no-tools interpretation of a task request (then /task accept|reject)",
    handler: async (args, ctx) => {
      const command = parseInterpretArgs(args);
      if (command.kind === "usage") {
        emit("usage", USAGE.interpret);
        return;
      }
      if (state.interpretGuard?.active) {
        ctx.ui.notify("An interpretation turn is already in progress.", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("The agent is busy. Wait for the current turn to finish, then run /interpret.", "error");
        return;
      }
      state.interpretGuard = {
        active: true,
        savedPhase: state.phase,
        savedAutonomy: state.autonomy,
        taskRequest: command.request,
        startedAt: new Date().toISOString(),
      };
      interpretTurnStarted = false;
      persist();
      updateStatus(ctx);
      pi.sendUserMessage(buildInterpretationPrompt(command.request));
    },
  });

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
      ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
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
              return [top, ...body, bottom];
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

  let profileModalOpen = false;
  pi.registerShortcut("alt+t", {
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
              render: (width: number) => renderProfilePicker(items, selectedIndex, Math.min(width, 100)),
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

  pi.registerShortcut("alt+p", {
    description: "Control plane: cycle workflow phase",
    handler: (ctx) => {
      setPhase(ctx, cyclePhase(state.phase));
    },
  });

  pi.registerShortcut("alt+a", {
    description: "Control plane: cycle autonomy level",
    handler: (ctx) => {
      setAutonomy(ctx, cycleAutonomy(state.autonomy), false);
    },
  });
}
