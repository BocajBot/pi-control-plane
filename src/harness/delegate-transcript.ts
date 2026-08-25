/**
 * Delegate sub-session transcript (spec section 26 visibility).
 *
 * A delegate used to be a black box: the coordinator saw only the final text,
 * and the user saw a spinner. This module turns the child session's event
 * stream into transcript lines that serve both consumers:
 *
 *  - live: the tail is streamed into the tool-output panel while the delegate
 *    runs (pi renders onUpdate partials there, expandable with ctrl+o), the
 *    way Claude Code shows a subagent working;
 *  - after: the full transcript is written to a durable file and re-read by
 *    /harness transcript <contract-id>.
 *
 * Pure: event objects in, strings out. The extension owns I/O.
 */

interface MessageLike {
  role?: string;
  content?: unknown;
}

function textOf(message: MessageLike | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part as { type?: string })?.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

function thinkingOf(message: MessageLike | undefined): string {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part as { type?: string })?.type === "thinking")
    .map((part) => (part as { thinking?: string }).thinking ?? "")
    .join("");
}

const ARGS_PREVIEW_LIMIT = 160;
const RESULT_PREVIEW_LIMIT = 200;

function previewArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  let rendered: string;
  try {
    rendered = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    return "(unserializable args)";
  }
  return rendered.length > ARGS_PREVIEW_LIMIT ? `${rendered.slice(0, ARGS_PREVIEW_LIMIT)}…` : rendered;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > RESULT_PREVIEW_LIMIT ? `${line.slice(0, RESULT_PREVIEW_LIMIT)}…` : line;
}

/**
 * One event -> zero or more transcript lines.
 *
 * Streaming partials (message_update, tool_execution_update) are deliberately
 * dropped: the transcript records what happened, and the completed events
 * carry the final content. Keeping partials would make the file quadratic.
 */
export function transcriptLinesFor(event: unknown): string[] {
  const e = event as {
    type?: string;
    message?: MessageLike;
    toolName?: string;
    args?: unknown;
    result?: { content?: unknown; isError?: boolean };
  };
  switch (e?.type) {
    case "message_end": {
      const role = e.message?.role;
      if (role === "assistant") {
        const lines: string[] = [];
        const thinking = thinkingOf(e.message).trim();
        if (thinking.length > 0) lines.push(`[thinking] ${firstLine(thinking)}`);
        const text = textOf(e.message).trim();
        if (text.length > 0) lines.push(...text.split("\n").map((line) => `assistant: ${line}`));
        return lines;
      }
      return [];
    }
    case "tool_execution_start":
      return [`tool> ${e.toolName ?? "?"} ${previewArgs(e.args)}`.trimEnd()];
    case "tool_execution_end": {
      const text = textOf(e.result as MessageLike).trim();
      const status = e.result?.isError === true ? "error" : "ok";
      return [`tool< ${e.toolName ?? "?"} [${status}] ${firstLine(text)}`.trimEnd()];
    }
    case "agent_start":
      return ["[delegate turn started]"];
    case "agent_end":
      return ["[delegate turn finished]"];
    default:
      return [];
  }
}

/** Rolling tail shown in the live tool panel while the delegate runs. */
export function transcriptTail(lines: readonly string[], limit = 12): string {
  if (lines.length === 0) return "[delegate starting…]";
  const tail = lines.slice(-limit);
  const skipped = lines.length - tail.length;
  return [
    ...(skipped > 0 ? [`… ${skipped} earlier lines (full transcript: /harness transcript)`] : []),
    ...tail,
  ].join("\n");
}
