/**
 * Pure formatting for status lines, command output, denial messages, and the
 * per-turn instruction injection block. No Pi imports, no I/O.
 *
 * "Observed" vs "Unavailable" vs "Inferred" labeling happens here: values the
 * runtime could not obtain are printed as "Unavailable", never invented.
 */

import { neutralizeDelimiters } from "./interpretation.ts";
import type {
  Autonomy,
  ContextSnapshot,
  ControlPlaneState,
  Phase,
  SnapshotDiff,
  SnapshotItem,
  ToolDecision,
} from "./types.ts";

export const SENSITIVE_OUTPUT_WARNING =
  "Detailed context may contain sensitive project information. Known credential patterns have been redacted, but redaction cannot be guaranteed to identify every secret.";

export const SANDBOX_ALIAS_WARNING =
  "This mode provides Pi-level policy restrictions, not operating-system isolation. It is not a security sandbox.";

/** Limits applied to rendered output and injected instructions. */
export const LIMITS = {
  injectionField: 700,
  injectionTotal: 6000,
  outputLines: 400,
  rawInterpretation: 20000,
  fullPromptPreview: 12000,
};

function displayPhase(phase: Phase): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function displayAutonomy(autonomy: Autonomy): string {
  switch (autonomy) {
    case "read-only":
      return "Read-only";
    case "attended":
      return "Attended";
    case "restricted":
      return "Restricted";
  }
}

/** Token counts formatted the way pi's built-in footer formats them. */
export function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export interface FooterStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Cache hit rate of the latest turn, or null when unknown. */
  cacheHitPercent: number | null;
  contextPercent: number | null;
  contextWindow: number;
}

/**
 * Plain-words replacement for pi's compact footer stats line
 * ("↑4.2k ↓30 R4.2k CH99.2% 8.6%/49k"). The context segment is returned
 * separately so the caller can colorize it by usage level.
 */
export function formatFooterStats(s: FooterStats): { stats: string; context: string } {
  const parts: string[] = [];
  if (s.input > 0) parts.push(`sent ${formatTokenCount(s.input)}`);
  if (s.output > 0) parts.push(`received ${formatTokenCount(s.output)}`);
  if (s.cacheRead > 0 || s.cacheWrite > 0) {
    const cache: string[] = [];
    if (s.cacheRead > 0) cache.push(`${formatTokenCount(s.cacheRead)} reused`);
    if (s.cacheWrite > 0) cache.push(`${formatTokenCount(s.cacheWrite)} stored`);
    const hits = s.cacheHitPercent !== null ? ` (${s.cacheHitPercent.toFixed(1)}% hits)` : "";
    parts.push(`cache ${cache.join(", ")}${hits}`);
  }
  if (s.cost > 0) parts.push(`cost $${s.cost.toFixed(3)}`);
  const pct = s.contextPercent !== null ? `${s.contextPercent.toFixed(1)}%` : "?";
  const context = `context ${pct} of ${formatTokenCount(s.contextWindow)}`;
  return { stats: parts.join(" · "), context };
}

export function formatStatus(
  state: ControlPlaneState,
  contextPercent: number | null,
  policyValid: boolean,
): string {
  const autonomy =
    state.autonomy === "restricted" && !policyValid
      ? "Read-only (policy fallback)"
      : displayAutonomy(state.autonomy);
  const task =
    state.acceptedTask !== null
      ? "Task accepted"
      : state.pendingInterpretation !== null
        ? "Task pending review"
        : "No task";
  const ctx =
    contextPercent !== null ? `Context ${Math.round(contextPercent)}% full` : "Context unknown";
  const guard = state.interpretGuard?.active ? " | Interpreting (tools disabled)" : "";
  return `Phase: ${displayPhase(state.phase)} | Mode: ${autonomy} | ${task} | ${ctx}${guard}`;
}

function unavailable(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "Unavailable" : String(value);
}

export function renderContextSummary(
  snapshot: ContextSnapshot,
  opts: { compactHint: boolean },
): string[] {
  const lines: string[] = [];
  lines.push(`Context snapshot — ${snapshot.timestamp}`);
  lines.push("");
  lines.push(`Provider:        ${unavailable(snapshot.provider)}`);
  lines.push(`Model:           ${unavailable(snapshot.model)}`);
  lines.push(`Context window:  ${unavailable(snapshot.contextWindow)} tokens`);
  lines.push(`Tokens used:     ${unavailable(snapshot.tokens)}`);
  lines.push(
    `Context used:    ${snapshot.percent !== null ? `${Math.round(snapshot.percent)}%` : "Unavailable"}`,
  );
  lines.push(`Messages:        ${unavailable(snapshot.messageCount)}`);
  const roles = Object.entries(snapshot.messagesByRole);
  if (roles.length > 0) {
    lines.push(`  by type:       ${roles.map(([r, n]) => `${r}=${n}`).join(", ")}`);
  }
  lines.push("");
  const byKind = (kind: SnapshotItem["kind"]) => snapshot.sources.filter((s) => s.kind === kind);
  const files = byKind("context-file");
  const skills = byKind("skill");
  const templates = byKind("prompt-template");
  lines.push(`Context files (${files.length}):`);
  for (const f of files) lines.push(`  ${f.enabled ? "[on] " : "[OFF]"} ${f.name}`);
  lines.push(`Skills (${skills.length}):`);
  for (const s of skills) lines.push(`  ${s.enabled ? "[on] " : "[OFF]"} ${s.name}`);
  lines.push(`Prompt templates (${templates.length}):`);
  for (const t of templates) lines.push(`  ${t.name}`);
  lines.push(`Active tools (${snapshot.tools.length}): ${snapshot.tools.join(", ") || "Unavailable"}`);
  lines.push("");
  lines.push(`Phase:           ${displayPhase(snapshot.phase)}`);
  lines.push(`Autonomy:        ${displayAutonomy(snapshot.autonomy)}`);
  lines.push(`Accepted task:   ${snapshot.hasAcceptedTask ? "yes" : "no"}`);
  lines.push("");
  lines.push(
    `System prompt:   ${unavailable(snapshot.systemPromptLength)} chars, sha256 ${shortHash(snapshot.systemPromptHash)} (redacted view)`,
  );
  lines.push(
    `Provider payload:${" "}${unavailable(snapshot.providerPayloadLength)} chars, sha256 ${shortHash(snapshot.providerPayloadHash)} (redacted view${snapshot.providerPayloadHash === null ? "; observed after the first LLM call" : ""})`,
  );
  if (opts.compactHint && snapshot.percent !== null && snapshot.percent > 75) {
    lines.push("");
    lines.push(
      "Context is above 75%. Pi's built-in /compact summarizes older context; /new starts a fresh session.",
    );
  }
  return lines;
}

function shortHash(hash: string | null): string {
  return hash === null ? "Unavailable" : hash.slice(0, 12);
}

export function renderDiff(diff: SnapshotDiff, isEmpty: boolean): string[] {
  const lines: string[] = [];
  lines.push(`Context diff — ${diff.previousAt} -> ${diff.currentAt}`);
  lines.push("");
  if (isEmpty) {
    lines.push("No meaningful changes since the previous snapshot.");
    return lines;
  }
  if (diff.providerChange) {
    lines.push(`Provider: ${diff.providerChange.from ?? "?"} -> ${diff.providerChange.to ?? "?"}`);
  }
  if (diff.modelChange) {
    lines.push(`Model: ${diff.modelChange.from ?? "?"} -> ${diff.modelChange.to ?? "?"}`);
  }
  const list = (label: string, items: string[]) => {
    if (items.length > 0) lines.push(`${label}: ${items.join(", ")}`);
  };
  list("Added sources", diff.addedSources);
  list("Removed sources", diff.removedSources);
  list("Changed sources", diff.changedSources);
  list("Added tools", diff.addedTools);
  list("Removed tools", diff.removedTools);
  list("Added skills", diff.addedSkills);
  list("Removed skills", diff.removedSkills);
  if (diff.messageCountDelta !== null && diff.messageCountDelta !== 0) {
    lines.push(`Message count: ${delta(diff.messageCountDelta)}`);
  }
  if (diff.tokenDelta !== null && diff.tokenDelta !== 0) {
    lines.push(`Token use: ${delta(diff.tokenDelta)}`);
  }
  if (diff.systemPromptHashChanged) lines.push("System prompt hash changed.");
  if (diff.providerPayloadHashChanged) lines.push("Provider payload hash changed.");
  return lines;
}

function delta(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function renderSources(snapshot: ContextSnapshot): string[] {
  const lines: string[] = [];
  lines.push("Prompt sources (toggle with /context toggle <name>):");
  lines.push("");
  for (const s of snapshot.sources) {
    const status = !s.toggleable ? "not toggleable" : s.enabled ? "enabled" : "disabled";
    lines.push(`  [${status}] ${s.name}${s.detail ? ` — ${truncate(s.detail, 80)}` : ""}`);
  }
  lines.push("");
  lines.push("Notes: tools toggle off for real (removed from the model's tool list).");
  lines.push("Context files and skills are excised from the system prompt with verification;");
  lines.push("if excision cannot be verified, the source is reported as still enabled.");
  return lines;
}

export function renderTask(state: ControlPlaneState): string[] {
  const lines: string[] = [];
  const task = state.acceptedTask;
  if (task === null) {
    lines.push("No accepted task brief exists.");
  } else {
    lines.push(`Accepted task (source: ${task.source}, updated ${task.updatedAt}):`);
    lines.push("");
    lines.push(`Objective: ${task.objective || "(empty)"}`);
    const section = (label: string, items: string[]) => {
      if (items.length === 0) return;
      lines.push(`${label}:`);
      for (const item of items) lines.push(`  - ${item}`);
    };
    section("Deliverables", task.deliverables);
    section("Included scope", task.includedScope);
    section("Excluded scope", task.excludedScope);
    section("Constraints", task.constraints);
    section("Assumptions", task.assumptions);
    section("Unknowns", task.unknowns);
    section("Completion criteria", task.completionCriteria);
    section("Approval boundaries", task.approvalBoundaries);
  }
  lines.push("");
  const pending = state.pendingInterpretation;
  if (pending === null) {
    lines.push("No pending interpretation.");
  } else if (pending.valid) {
    lines.push(`Pending interpretation from ${pending.createdAt} (valid).`);
    lines.push("Run /task accept to adopt it, or /task reject to discard it.");
  } else {
    lines.push(
      `Pending interpretation from ${pending.createdAt} is INVALID — missing sections: ${pending.missingSections.join(", ")}.`,
    );
    lines.push("It cannot be accepted. Re-run /interpret, or /task reject to discard.");
  }
  return lines;
}

export function formatDenial(decision: ToolDecision, toolName: string): string {
  const parts = [
    `[control plane] Blocked tool "${toolName}" (${decision.riskCategory}).`,
    `Rule: ${decision.rule}.`,
    decision.reason,
  ];
  if (decision.hint) parts.push(decision.hint);
  return parts.join(" ");
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function truncateField(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + " [TRUNCATED]" : text;
}

/**
 * Build the per-turn control-plane block appended to the system prompt.
 * Ephemeral: recomputed every turn, never persisted, never duplicated.
 * Task text is delimiter-neutralized and size-limited.
 */
export function buildInjectionBlock(state: ControlPlaneState, policyValid: boolean): string {
  const lines: string[] = [];
  lines.push("[PI CONTROL PLANE]");
  lines.push("");
  lines.push(`Phase: ${displayPhase(state.phase)}`);
  const autonomyLine =
    state.autonomy === "restricted" && !policyValid
      ? "Read-only (Restricted policy failed validation; fail-closed)"
      : displayAutonomy(state.autonomy);
  lines.push(`Autonomy: ${autonomyLine}`);
  const taskStatus =
    state.acceptedTask !== null ? "Accepted" : state.pendingInterpretation !== null ? "Pending" : "None";
  lines.push(`Task status: ${taskStatus}`);
  const task = state.acceptedTask;
  if (task !== null) {
    const field = (label: string, value: string | string[]) => {
      const text = Array.isArray(value) ? value.map((v) => `- ${v}`).join("\n") : value;
      if (text.trim().length === 0) return;
      lines.push("");
      lines.push(`${label}:`);
      lines.push(truncateField(neutralizeDelimiters(text), LIMITS.injectionField));
    };
    field("Accepted objective", task.objective);
    field("Included scope", task.includedScope);
    field("Excluded scope", task.excludedScope);
    field("Constraints", task.constraints);
    field("Unknowns", task.unknowns);
    field("Completion criteria", task.completionCriteria);
    field("Approval boundaries", task.approvalBoundaries);
  }
  lines.push("");
  lines.push("Behavioral requirements:");
  lines.push("- Obey the active phase.");
  lines.push("- Obey the active autonomy policy.");
  lines.push("- Do not broaden the accepted task.");
  lines.push("- Distinguish observations, inferences, assumptions, and recommendations.");
  lines.push(
    "- Do not claim completion without verification evidence. A queued, pending, or blocked action is not a completed action and must never be described as done.",
  );
  let block = lines.join("\n");
  if (block.length > LIMITS.injectionTotal) {
    block = block.slice(0, LIMITS.injectionTotal) + "\n[TRUNCATED]";
  }
  return block;
}

export interface ProfilePickerItem {
  name: string;
  description: string;
  tools: string[];
  active: boolean;
  /** This profile is applied automatically at the start of fresh sessions. */
  isDefault: boolean;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word.slice(0, width);
    } else if (line.length + 1 + word.length <= width) {
      line += " " + word;
    } else {
      lines.push(line);
      line = word.slice(0, width);
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * Profile picker modal layout (alt+t). Rectangular; left column = 1/5 of the
 * modal width listing profile names, right side = two rows (description on
 * top, enabled tools below). Pure: returns plain text lines.
 */
export function renderProfilePicker(
  items: ProfilePickerItem[],
  selectedIndex: number,
  width: number,
): string[] {
  const inner = Math.max(40, width - 2);
  const leftWidth = Math.max(10, Math.floor(inner / 5));
  const rightWidth = inner - leftWidth - 1;
  const selected = items[selectedIndex] ?? items[0];

  const title = " Tool Profiles — enter apply (session) · space set default · esc close";
  const leftLines: string[] = ["Profiles", ""];
  items.forEach((item, index) => {
    const marker = index === selectedIndex ? "> " : "  ";
    const star = item.active ? "*" : " ";
    const name = item.isDefault ? `${item.name} (default)` : item.name;
    leftLines.push(`${marker}${star}${name}`.slice(0, leftWidth));
  });

  const descLines = ["Description", ...wrapText(selected?.description ?? "", rightWidth - 2).map((l) => "  " + l)];
  if (selected?.isDefault) {
    descLines.push(
      ...wrapText("Default profile — applied automatically when a new session starts.", rightWidth - 2).map(
        (l) => "  " + l,
      ),
    );
  }
  const toolsHeader = `Tools (${selected?.tools.length ?? 0})`;
  const toolsLines = [
    toolsHeader,
    ...wrapText((selected?.tools ?? []).join(", ") || "(none)", rightWidth - 2).map((l) => "  " + l),
  ];
  // Right side: two rows — description row, horizontal rule, tools row.
  const rightLines = [...descLines, "─".repeat(rightWidth), ...toolsLines];

  const bodyHeight = Math.max(leftLines.length, rightLines.length);
  const row = (left: string, right: string) =>
    "│" + left.padEnd(leftWidth).slice(0, leftWidth) + "│" + right.padEnd(rightWidth).slice(0, rightWidth) + "│";

  const lines: string[] = [];
  lines.push("╭" + "─".repeat(inner) + "╮");
  lines.push("│" + title.padEnd(inner).slice(0, inner) + "│");
  lines.push("├" + "─".repeat(leftWidth) + "┬" + "─".repeat(rightWidth) + "┤");
  for (let i = 0; i < bodyHeight; i++) {
    lines.push(row(leftLines[i] ?? "", rightLines[i] ?? ""));
  }
  lines.push("╰" + "─".repeat(leftWidth) + "┴" + "─".repeat(rightWidth) + "╯");
  return lines;
}

/** Cheat-sheet shown by the alt+h hotkey widget. Pure data, testable. */
export function renderHotkeyCheatsheet(): string[] {
  return [
    "Hotkeys — press any key to close",
    "",
    "Control plane:",
    "  alt+c  toggle context-preview widget",
    "  alt+e  view/edit session context in nvim (:wq apply, :q! cancel)",
    "  alt+s  send preview: everything the next message will send, editable, incl. your draft",
    "  alt+t  tool-profile picker (enter: apply this session · space: set as default)",
    "  alt+p  cycle phase: Discuss > Plan > Execute > Verify",
    "  alt+a  cycle autonomy: Read-only > Attended > Restricted",
    "  alt+h  this cheat sheet",
    "",
    "Pi essentials:",
    "  ctrl+g     edit prompt in external editor",
    "  shift+tab  cycle thinking level",
    "  ctrl+t     collapse/expand thinking blocks",
    "  ctrl+o     collapse/expand tool output",
    "  ctrl+l     model selector    ctrl+p  cycle model",
    "  alt+enter  queue follow-up   alt+up  restore queued message",
    "  ctrl+x     copy last assistant message",
    "  escape     interrupt         ctrl+c  clear editor   ctrl+d  exit",
    "",
    "Commands: /context /task /phase /autonomy /interpret /hotkeys /compact /new",
  ];
}

export const USAGE = {
  context: [
    "Usage: /context [diff|full|sources|toggle <name>|restore]",
    "  /context          — redacted summary of the effective context",
    "  /context diff     — changes since the last /context or /context full",
    "  /context full     — detailed redacted view (size-limited)",
    "  /context sources  — list prompt sources with toggle status",
    "  /context toggle <name> — enable/disable a source (e.g. tool:bash, file:/path, skill:foo)",
    "  /context restore  — remove the alt+e context override (undo edits)",
    "  /context profile  — list tool profiles; /context profile <name> applies one",
    "                      (\"all\" re-enables every tool; edit policy/profiles.json to define profiles)",
  ],
  task: [
    "Usage: /task [set <text>|clear|accept|reject]",
    "  /task             — show the accepted task and any pending interpretation",
    "  /task set <text>  — create a task brief directly from your text",
    "  /task accept      — adopt the pending /interpret result",
    "  /task reject      — discard the pending /interpret result",
    "  /task clear       — clear accepted and pending task state (asks to confirm)",
  ],
  phase: [
    "Usage: /phase [discuss|plan|execute|verify]",
    "  Discuss/Plan/Verify block all mutating tools. Execute defers to /autonomy.",
  ],
  autonomy: [
    "Usage: /autonomy [read-only|attended|restricted]",
    "  read-only  — only read/grep/find/ls; everything else blocked",
    "  attended   — risky operations require your confirmation",
    "  restricted — project-bound policy from policy/default-policy.json",
    "  (\"sandboxed\" is accepted as an alias for restricted, with a warning)",
  ],
  interpret: [
    "Usage: /interpret <task request>",
    "  Runs a no-tools interpretation turn and produces a pending task brief.",
    "  Afterwards run /task accept or /task reject.",
  ],
};
