/**
 * Context editor: serialize the current session context (system prompt +
 * messages) to an editable text document, parse the edited result, and apply
 * it as an in-memory override for subsequent LLM calls.
 *
 * Pure module — no Pi imports, no I/O. The extension entry handles the nvim
 * spawn and the temp file.
 *
 * Safety properties:
 * - Marker lines are the only structure; anything the user cannot round-trip
 *   is rejected with an error instead of guessed at.
 * - Non-text content blocks (tool calls, tool results, images, thinking) are
 *   preserved verbatim; only text is editable.
 * - The override is memory-only. Raw context is never persisted to session
 *   entries by this feature.
 */

export const SYSTEM_MARKER = "#### PI-CTX SYSTEM-PROMPT ####";
const MESSAGE_MARKER = /^#### PI-CTX MESSAGE (\d+) ([A-Za-z]+) ####$/;
const ANY_MARKER = /^#### PI-CTX /;

export const EDITOR_HEADER = [
  "## PI CONTROL PLANE — CONTEXT EDITOR",
  "## Save and quit (:wq) to apply. Quit without saving (:q!) to cancel (no changes = no override).",
  "## - Text under each marker is editable.",
  "## - Delete an entire MESSAGE section (marker line + body) to remove that message.",
  "##   (Careful: removing one half of a tool call/result pair can make the provider reject the request.)",
  "## - Do not edit marker lines. Tool calls, tool results, and images are preserved automatically",
  "##   and shown as [non-text: ...] placeholders. Placeholder lines are ignored on save.",
  "## - Edits apply to FUTURE turns in this session only. Run \"/context restore\" to undo.",
  "",
].join("\n");

/** Minimal structural view of an agent message. */
export interface MessageLike {
  role?: string;
  content?: unknown;
}

interface ContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export function extractText(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return (message.content as ContentBlock[])
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
}

function nonTextSummary(message: MessageLike): string[] {
  if (!Array.isArray(message.content)) return [];
  return (message.content as ContentBlock[])
    .filter((b) => b?.type !== "text")
    .map((b) => `[non-text: ${b?.type ?? "unknown"}${typeof b?.name === "string" ? ` ${b.name}` : ""}]`);
}

export function serializeContext(systemPrompt: string, messages: MessageLike[]): string {
  const parts: string[] = [EDITOR_HEADER, SYSTEM_MARKER, systemPrompt, ""];
  messages.forEach((message, index) => {
    parts.push(`#### PI-CTX MESSAGE ${index} ${message.role ?? "unknown"} ####`);
    const placeholders = nonTextSummary(message);
    if (placeholders.length > 0) parts.push(...placeholders);
    const text = extractText(message);
    if (text.length > 0) parts.push(text);
    parts.push("");
  });
  return parts.join("\n");
}

export interface ParsedEdit {
  systemPrompt: string;
  /** Message index -> edited text. Missing index means the message was deleted. */
  messages: Map<number, string>;
}

export type ParseResult = { ok: true; edit: ParsedEdit } | { ok: false; error: string };

function cleanBody(lines: string[]): string {
  const kept = lines.filter((line) => !/^\[non-text: [^\]]*\]$/.test(line));
  while (kept.length > 0 && kept[0].trim() === "") kept.shift();
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return kept.join("\n");
}

export function parseEditedContext(text: string, originalMessageCount: number): ParseResult {
  const lines = text.split(/\r?\n/);
  let systemPrompt: string | null = null;
  const messages = new Map<number, string>();
  let current: { kind: "system" } | { kind: "message"; index: number } | null = null;
  let body: string[] = [];

  const flush = (): string | null => {
    if (current === null) return null;
    const content = cleanBody(body);
    if (current.kind === "system") {
      if (systemPrompt !== null) return "duplicate SYSTEM-PROMPT section";
      systemPrompt = content;
    } else {
      if (messages.has(current.index)) return `duplicate MESSAGE ${current.index} section`;
      if (current.index >= originalMessageCount) {
        return `MESSAGE ${current.index} does not exist in the original context (adding messages is not supported)`;
      }
      messages.set(current.index, content);
    }
    body = [];
    return null;
  };

  for (const line of lines) {
    if (line === SYSTEM_MARKER) {
      const err = flush();
      if (err) return { ok: false, error: err };
      current = { kind: "system" };
      continue;
    }
    const match = MESSAGE_MARKER.exec(line);
    if (match) {
      const err = flush();
      if (err) return { ok: false, error: err };
      current = { kind: "message", index: Number(match[1]) };
      continue;
    }
    if (ANY_MARKER.test(line)) {
      return { ok: false, error: `unrecognized marker line: "${line.slice(0, 60)}"` };
    }
    if (current !== null) body.push(line);
    // Content before the first marker (the header) is ignored.
  }
  const err = flush();
  if (err) return { ok: false, error: err };
  if (systemPrompt === null) {
    return { ok: false, error: "the SYSTEM-PROMPT section is missing; aborted (nothing applied)" };
  }
  return { ok: true, edit: { systemPrompt, messages } };
}

export interface ApplyResult {
  messages: MessageLike[];
  editedCount: number;
  droppedCount: number;
}

/** Rebuild a message with its text replaced, preserving non-text blocks. */
function withText(message: MessageLike, newText: string): MessageLike {
  if (typeof message.content === "string" || message.content === undefined) {
    return { ...message, content: newText };
  }
  if (!Array.isArray(message.content)) return message;
  const out: ContentBlock[] = [];
  let replaced = false;
  for (const block of message.content as ContentBlock[]) {
    if (block?.type === "text") {
      if (!replaced && newText.length > 0) {
        out.push({ ...block, text: newText });
        replaced = true;
      }
      // additional text blocks collapse into the first
    } else {
      out.push(block);
    }
  }
  if (!replaced && newText.length > 0) out.push({ type: "text", text: newText });
  return { ...message, content: out };
}

export function applyEdits(original: MessageLike[], edit: ParsedEdit): ApplyResult {
  const messages: MessageLike[] = [];
  let editedCount = 0;
  let droppedCount = 0;
  original.forEach((message, index) => {
    if (!edit.messages.has(index)) {
      droppedCount++;
      return;
    }
    const newText = edit.messages.get(index)!;
    if (newText === extractText(message)) {
      messages.push(message);
    } else {
      messages.push(withText(message, newText));
      editedCount++;
    }
  });
  return { messages, editedCount, droppedCount };
}

export interface Overlay {
  messages: MessageLike[];
  /** Number of messages that existed when the override was created. */
  baseCount: number;
  systemPrompt: string | null;
  createdAt: string;
}

export type OverlayMergeResult =
  | { ok: true; messages: MessageLike[] }
  | { ok: false; reason: string };

/**
 * Merge the overlay with the incoming message list: the overlay replaces the
 * first `baseCount` messages; anything newer is appended unchanged. If the
 * conversation shrank below baseCount (compaction, tree navigation), the
 * overlay no longer lines up and must be invalidated.
 */
export function mergeOverlay(overlay: Overlay, incoming: MessageLike[]): OverlayMergeResult {
  if (incoming.length < overlay.baseCount) {
    return { ok: false, reason: "conversation was rewritten (compaction or branch change)" };
  }
  return { ok: true, messages: [...overlay.messages, ...incoming.slice(overlay.baseCount)] };
}
