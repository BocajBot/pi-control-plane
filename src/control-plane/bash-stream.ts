/**
 * Live view of the bash tool's output stream.
 *
 * Pi emits `tool_execution_update` while a bash call runs, carrying the
 * CUMULATIVE output so far (observed 2026-09-17: `partialResult.content[0].text`
 * grows with each flush). This module keeps a bounded tail of that text and
 * renders it as a widget above the editor, so the stream can be watched live
 * without any of it entering the conversation transcript.
 *
 * Pure: no Pi imports, no I/O.
 */

/** Output lines retained for the current call. Older lines are dropped. */
export const BASH_STREAM_MAX_LINES = 400;

/** Lines shown in the widget body. */
export const BASH_STREAM_TAIL_ROWS = 12;

export interface BashStreamState {
  toolCallId: string;
  command: string;
  /** Tail of the output, most recent last. */
  lines: string[];
  /** Lines dropped off the front because the buffer filled. */
  dropped: number;
  startedAt: number;
  /** Null while the command is still running. */
  endedAt: number | null;
  isError: boolean;
  /**
   * Background task id when this command was handed to pi-background-tasks
   * with (ctrl+alt+b)x2. Pi has no per-tool-call detach, so backgrounding aborts
   * the foreground call and RE-RUNS the command from the start as a task; its
   * output then goes to the task's log, not to this widget.
   */
  backgroundTaskId: string | null;
}

export function startBashStream(
  toolCallId: string,
  command: string,
  at: number,
): BashStreamState {
  return {
    toolCallId,
    command,
    lines: [],
    dropped: 0,
    startedAt: at,
    endedAt: null,
    isError: false,
    backgroundTaskId: null,
  };
}

/**
 * Pull the streamed text out of a `tool_execution_update` / `_end` payload.
 * Returns null when the payload carries no text yet (the first update of a
 * call has an empty content array).
 */
export function extractStreamText(payload: unknown): string | null {
  const content = (payload as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) {
    const text = (part as { type?: string; text?: unknown }).text;
    if (typeof text === "string") texts.push(text);
  }
  return texts.length > 0 ? texts.join("") : null;
}

/**
 * Replace the buffer with the tail of `cumulativeText`. The payload is a
 * snapshot rather than a delta, so this is idempotent for a repeated update.
 */
export function applyBashOutput(
  state: BashStreamState,
  cumulativeText: string,
  maxLines: number = BASH_STREAM_MAX_LINES,
): BashStreamState {
  const all = cumulativeText.split("\n");
  // A trailing newline produces an empty final element; it is not a line yet.
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const dropped = Math.max(0, all.length - maxLines);
  return { ...state, lines: all.slice(dropped), dropped };
}

export function endBashStream(
  state: BashStreamState,
  at: number,
  isError: boolean,
): BashStreamState {
  // Backgrounding aborts the foreground call on purpose; the resulting error
  // result is not a command failure and must not be shown as one.
  if (state.backgroundTaskId !== null) return { ...state, endedAt: at, isError: false };
  return { ...state, endedAt: at, isError };
}

/**
 * Record that the command was relaunched as background task `taskId`.
 *
 * The foreground call is aborted first, so its `tool_execution_end` usually
 * lands before the background task id comes back; clearing `isError` here
 * keeps that deliberate abort from being shown as a command failure.
 */
export function markBackgrounded(state: BashStreamState, taskId: string): BashStreamState {
  return { ...state, backgroundTaskId: taskId, isError: false };
}

/** Milliseconds within which a second ctrl+alt+b counts as the backgrounding gesture. */
export const BACKGROUND_DOUBLE_PRESS_MS = 800;

export function isDoublePress(
  lastPressAt: number | null,
  now: number,
  windowMs: number = BACKGROUND_DOUBLE_PRESS_MS,
): boolean {
  return lastPressAt !== null && now - lastPressAt >= 0 && now - lastPressAt <= windowMs;
}

/** Short human label for the task dock: first few words of the command. */
export function backgroundTaskName(command: string, maxChars = 40): string {
  const flat = command.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "bash task";
  const words = flat.split(" ").slice(0, 6).join(" ");
  return words.length > maxChars ? words.slice(0, maxChars - 1) + "…" : words;
}

/** mm:ss, or h:mm:ss past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export interface BashStreamPaint {
  fg(color: string, text: string): string;
}

export interface BashStreamMeasure {
  measure(text: string): number;
  clip(text: string, max: number): string;
}

/**
 * Widget body: a bordered box carrying the command, elapsed time, and the tail
 * of the stream. Returns [] when there is nothing to show or the terminal is
 * too narrow, which collapses the widget to zero height.
 */
export function renderBashStream(
  state: BashStreamState | null,
  width: number,
  now: number,
  paint: BashStreamPaint,
  opts: BashStreamMeasure,
  tailRows: number = BASH_STREAM_TAIL_ROWS,
): string[] {
  if (state === null || width < 24) return [];
  const inner = width - 2;
  const paintOr = (color: string, text: string, fallback: string): string => {
    try {
      return paint.fg(color, text);
    } catch {
      return paint.fg(fallback, text);
    }
  };
  const border = (text: string) => paintOr("todoBorder", text, "dim");
  const elapsed = formatElapsed((state.endedAt ?? now) - state.startedAt);
  const backgrounded = state.backgroundTaskId !== null;
  const status = backgrounded
    ? "background"
    : state.endedAt === null
      ? "running"
      : state.isError
        ? "failed"
        : "done";
  const statusColor = backgrounded
    ? "accent"
    : state.endedAt === null
      ? "footerYellow"
      : state.isError
        ? "error"
        : "success";

  // Title row: "bash · <command>" on the left, status + elapsed on the right.
  const right = ` ${status} ${elapsed} `;
  const rightWidth = opts.measure(right);
  const titleBudget = Math.max(4, inner - rightWidth - 2);
  const command = state.command.replace(/\s+/g, " ").trim();
  const title = opts.clip(` bash · ${command} `, titleBudget);
  const rule = Math.max(0, inner - opts.measure(title) - rightWidth);

  const lines: string[] = [];
  lines.push(
    border("╭") + paintOr("todoTitle", title, "text") + border("─".repeat(rule)) +
      paintOr(statusColor, right, "muted") + border("╮"),
  );

  const body = state.lines.slice(-Math.max(1, tailRows));
  if (state.dropped > 0) {
    body.unshift(`… ${state.dropped} earlier line${state.dropped === 1 ? "" : "s"} dropped`);
  }
  if (body.length === 0) body.push("(no output yet)");
  if (backgrounded) {
    body.push(`↳ restarted as background task ${state.backgroundTaskId} — /logs ${state.backgroundTaskId}`);
  }
  for (const raw of body) {
    // Control characters (carriage returns from progress bars, tabs) would
    // corrupt the box; flatten them before measuring.
    const flat = raw.replace(/\t/g, "  ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    const text = opts.clip(flat, inner - 2);
    const pad = " ".repeat(Math.max(0, inner - 1 - opts.measure(text)));
    lines.push(border("│") + " " + paintOr("text", text, "text") + pad + border("│"));
  }

  const hint = " alt+b hide ";
  const hintPad = Math.max(0, inner - opts.measure(hint));
  lines.push(border("╰") + border("─".repeat(hintPad)) + paintOr("dim", hint, "muted") + border("╯"));
  return lines;
}
