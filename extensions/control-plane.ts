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
import { evaluateToolCall, validatePolicy, type PathOps } from "../src/control-plane/tool-policy.ts";
import {
  buildInjectionBlock,
  formatDenial,
  formatStatus,
  LIMITS,
  renderContextSummary,
  renderDiff,
  renderHotkeyCheatsheet,
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
const HOTKEYS_WIDGET_KEY = "control-plane-hotkeys";

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
  try {
    const piPkg = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      formatSkillsForPrompt: typeof formatSkillsForPrompt;
    };
    formatSkillsForPrompt = piPkg.formatSkillsForPrompt;
  } catch {
    formatSkillsForPrompt = null;
  }
  try {
    const tui = (await import("@earendil-works/pi-tui")) as unknown as { Box: typeof Box; Text: typeof Text };
    Box = tui.Box;
    Text = tui.Text;
  } catch {
    Box = null;
    Text = null;
  }

  let state: ControlPlaneState = defaultState();
  let policy: RestrictedPolicy | null = null;
  let policyLoadError: string | null = null;
  let lastPayloadMeta: { length: number; hash: string } | null = null;
  let projectRoot: string | null = null;
  let widgetVisible = false;
  let hotkeysWidgetVisible = false;
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
    ctx.ui.setStatus(STATUS_KEY, contextOverlay !== null ? `${base} | CTX-EDITED` : base);
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
      const subs = ["diff", "full", "sources", "toggle ", "restore"];
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

  const runContextEditor = async (ctx: ExtensionContext) => {
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
    const serialized =
      serializeContext(systemPrompt, messages) +
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
    if (applied.editedCount === 0 && applied.droppedCount === 0 && !systemPromptChanged) {
      ctx.ui.notify("No effective changes.", "info");
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
      await runContextEditor(ctx);
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
    description: "Control plane: toggle hotkey cheat sheet",
    handler: (ctx) => {
      if (hotkeysWidgetVisible) {
        ctx.ui.setWidget(HOTKEYS_WIDGET_KEY, undefined);
        hotkeysWidgetVisible = false;
        return;
      }
      ctx.ui.setWidget(
        HOTKEYS_WIDGET_KEY,
        renderHotkeyCheatsheet().map((line) => (line.length > 0 ? line : " ")),
        { placement: "aboveEditor" },
      );
      hotkeysWidgetVisible = true;
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
