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
    case "auto":
      return "Auto";
    case "restricted":
      return "Restricted";
    case "unattended":
      return "Unattended";
  }
}

/** One label for the merged mode setting. Legacy combos are shown honestly. */
export function displayMode(
  phase: Phase,
  autonomy: Autonomy,
  policyValid: boolean,
  hasAcceptedTask?: boolean,
): string {
  if (phase === "execute") {
    if (autonomy === "attended") return "Execute (attended)";
    if (autonomy === "auto") return "Execute (auto)";
    if (autonomy === "restricted") {
      return policyValid
        ? "Execute (restricted)"
        : "Execute (restricted — policy invalid, enforcing read-only)";
    }
    if (autonomy === "unattended") {
      if (!policyValid) return "Execute (unattended — policy invalid, enforcing read-only)";
      return hasAcceptedTask === false
        ? "Execute (unattended — no accepted task, mutation blocked)"
        : "Execute (unattended)";
    }
    return "Execute (read-only)";
  }
  const base = displayPhase(phase);
  return autonomy === "read-only" ? base : `${base} (${displayAutonomy(autonomy)})`;
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
  /** Exact token count of the last provider request from the model's own
   * tokenizer (via llama-swap), or null when unavailable. */
  exactTokens?: number | null;
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
  let context: string;
  if (s.exactTokens !== undefined && s.exactTokens !== null) {
    const tokens = s.exactTokens.toLocaleString("en-US");
    const window = s.contextWindow > 0 ? s.contextWindow.toLocaleString("en-US") : "?";
    context = `context ${tokens} of ${window} tokens at last request (model tokenizer)`;
  } else {
    const pct = s.contextPercent !== null ? `~${s.contextPercent.toFixed(1)}%` : "?";
    context = `context ${pct} of ${formatTokenCount(s.contextWindow)} (estimated)`;
  }
  return { stats: parts.join(" · "), context };
}

/**
 * Rough token estimate for draft text (~4 chars/token). No tokenizer is
 * available in-process, so this is always presented with a "~" prefix.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function rightAlign(label: string, width: number): string {
  if (label.length >= width) return label;
  return " ".repeat(width - label.length) + label;
}

/** Right-aligned draft token counter line shown under the input box. */
export function formatDraftCounter(text: string, width: number): string {
  return rightAlign(`Token Counter: ~${estimateTokens(text)}`, width);
}

/**
 * "Added Context" line under the token counter: the tokens that accompany the
 * draft when it is sent (system prompt, history, tool definitions). Exact when
 * the model's tokenizer counted the last request; "~" when only pi's estimate
 * exists; "?" before anything is known.
 */
export function formatAddedContext(
  addedTokens: number | null,
  exact: boolean,
  width: number,
): string {
  const value =
    addedTokens === null
      ? "?"
      : `${exact ? "" : "~"}${addedTokens.toLocaleString("en-US")}`;
  return rightAlign(`Added Context: ${value}`, width);
}

/** Context-fullness warning thresholds, applied to the EXACT (model-tokenizer)
 * count — pi's own auto-compaction watches its internal estimate instead,
 * which can be off by a large margin (46% observed), so the control plane
 * warns from the accurate number. */
export const CONTEXT_WARN_THRESHOLDS = { warn: 75, urgent: 90 };

export function contextWarningLevel(percent: number): "urgent" | "warn" | null {
  if (percent >= CONTEXT_WARN_THRESHOLDS.urgent) return "urgent";
  if (percent >= CONTEXT_WARN_THRESHOLDS.warn) return "warn";
  return null;
}

export function formatContextWarning(
  level: "urgent" | "warn",
  tokens: number,
  window: number,
): string {
  const pct = ((tokens / window) * 100).toFixed(1);
  const counts = `${tokens.toLocaleString("en-US")} of ${window.toLocaleString("en-US")} tokens`;
  return level === "urgent"
    ? `Context ${pct}% full by the model's own tokenizer (${counts}). Pi's auto-compaction watches its own estimate and may not have triggered — run /compact now, or /new for a fresh session.`
    : `Context ${pct}% full by the model's own tokenizer (${counts}). Consider /compact soon; pi's own meter may show a different number.`;
}

export function formatStatus(
  state: ControlPlaneState,
  contextPercent: number | null,
  policyValid: boolean,
  sandboxLabel: string = "",
): string {
  const task =
    state.acceptedTask !== null
      ? "Task accepted"
      : state.pendingInterpretation !== null
        ? "Task pending review"
        : "No task";
  const ctx =
    contextPercent !== null ? `Context ${Math.round(contextPercent)}% full` : "Context unknown";
  const guard = state.interpretGuard?.active ? " | Interpreting (tools disabled)" : "";
  const sandbox = sandboxLabel.length > 0 ? ` | ${sandboxLabel}` : "";
  const mode = displayMode(state.phase, state.autonomy, policyValid, state.acceptedTask !== null);
  return `Mode: ${mode} | ${task} | ${ctx}${guard}${sandbox}`;
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
  lines.push(`Mode:            ${displayMode(snapshot.phase, snapshot.autonomy, true, snapshot.hasAcceptedTask)}`);
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
  const hasAcceptedTask = state.acceptedTask !== null;
  lines.push("[PI CONTROL PLANE]");
  lines.push("");
  lines.push(`Mode: ${displayMode(state.phase, state.autonomy, policyValid, hasAcceptedTask)}`);
  lines.push(
    state.phase === "execute"
      ? state.autonomy === "restricted" && policyValid
        ? "Mutating tools are policy-enforced: project-root writes only, credential paths and shell blocked."
        : state.autonomy === "unattended" && policyValid
          ? hasAcceptedTask
            ? "Mutating tools are policy-enforced (same rules as restricted) with no human reviewing in real time. Stay strictly within the accepted task's scope."
            : "Mutating tools are blocked: unattended mode requires an accepted task brief first."
          : state.autonomy === "auto"
            ? "File writes and edits inside the project root apply without asking. Shell, deletion, writes outside the root, protected paths and harness tools still require user confirmation."
            : state.autonomy === "attended"
              ? "Risky tool calls (writes, shell, out-of-root reads) require user confirmation."
              : "Mutating tools are blocked in this mode."
      : "Mutating tools are blocked in this mode.",
  );
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
  lines.push("- Obey the active mode's restrictions.");
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
    "  alt+p / shift+tab  cycle mode: Discuss > Plan > Execute (attended)",
    "         > Execute (restricted) > Execute (unattended) > Verify",
    "  alt+h  this cheat sheet",
    "",
    "Pi essentials:",
    "  ctrl+g     edit prompt in external editor",
    "  /effort    set thinking level (off|minimal|low|medium|high|xhigh|max)",
    "  ctrl+t     collapse/expand thinking blocks",
    "  ctrl+o     collapse/expand tool output",
    "  ctrl+l     model selector    ctrl+p  cycle model",
    "  alt+enter  queue follow-up   alt+up  restore queued message",
    "  ctrl+x     copy last assistant message",
    "  escape     interrupt         ctrl+c  clear editor   ctrl+d  exit",
    "",
    "Commands: /context /task /mode /interpret /hotkeys /compact /new",
  ];
}

export const USAGE = {
  context: [
    "Usage: /context [diff|full|sources|toggle <name>|restore|profile [name]|recount]",
    "  /context          — redacted summary of the effective context",
    "  /context diff     — changes since the last /context or /context full",
    "  /context full     — detailed redacted view (size-limited)",
    "  /context sources  — list prompt sources with toggle status",
    "  /context toggle <name> — enable/disable a source (e.g. tool:bash, file:/path, skill:foo)",
    "  /context restore  — remove the alt+e context override (undo edits)",
    "  /context profile  — list tool profiles; /context profile <name> applies one",
    "                      (\"all\" re-enables every tool; edit policy/profiles.json to define profiles)",
    "  /context recount  — re-count the last provider request with the model's own tokenizer",
  ],
  task: [
    "Usage: /task [set <text>|clear|accept|reject]",
    "  /task             — show the accepted task and any pending interpretation",
    "  /task set <text>  — create a task brief directly from your text",
    "  /task accept      — adopt the pending /interpret result",
    "  /task reject      — discard the pending /interpret result",
    "  /task clear       — clear accepted and pending task state (asks to confirm)",
  ],
  mode: [
    "Usage: /mode [discuss|plan|execute|auto|execute-restricted|execute-unattended|verify]",
    "  discuss             — talk only; every mutating tool blocked, reads allowed",
    "  plan                — same permissions as discuss, framed for planning",
    "  execute             — changes allowed; risky operations ask for confirmation",
    "  auto                — edits inside the project root apply without asking;",
    "                        shell, deletion, writes outside the root, protected",
    "                        paths and harness tools still confirm (accept-edits)",
    "  execute-restricted  — changes allowed inside the project root under",
    "                        policy/default-policy.json; no confirmations, shell blocked",
    "  execute-unattended  — same policy enforcement as execute-restricted, but requires",
    "                        an accepted task brief first (/interpret + /task accept, or",
    "                        /task set) and logs every allowed call as a diagnostic entry",
    "                        for later review — meant for running with nobody watching",
    "  verify              — read-only again, framed for checking the work",
    "  (\"restricted\" means execute-restricted; \"sandboxed\" too, with a warning:",
    "   it is policy enforcement, not an OS sandbox; \"unattended\" means execute-unattended)",
  ],
  interpret: [
    "Usage: /interpret <task request>",
    "  Runs a no-tools interpretation turn and produces a pending task brief.",
    "  Afterwards run /task accept or /task reject.",
  ],
};
