/**
 * Task tracking: the model's to-do list, rendered as a top-right widget.
 *
 * The model calls the `todo` tool to add, complete, reopen, remove or clear
 * tasks. State lives in its own session entry (TODO_ENTRY_TYPE), the same
 * pattern as the scratchpad: excluded from LLM context, untouched by
 * `/compact`, and injected into the system prompt every turn so the model
 * actually sees its open tasks across compaction. The widget shows the same
 * list to the human, top-right, with radial bullets that fill when a task
 * completes (○ -> ●), a rounded border, and theme-painted colors (cyberpunk
 * palette on the shipped theme).
 *
 * Pure module: state machine, validation, restoration, and rendering here;
 * the tool registration, pinned-widget wiring and injection live in the entry.
 */

export const TODO_SCHEMA_VERSION = 1;
export const TODO_ENTRY_TYPE = "pi-control-plane-todo";

/** Widget cap: how many items the pinned box shows before "+N more". */
export const TODO_WIDGET_MAX_ITEMS = 6;
/** Widgets cap: box width budget (terminal cells, including borders). */
export const TODO_WIDGET_MAX_WIDTH = 44;

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  addedAt: string;
  /** Set when completed; cleared when reopened. */
  doneAt: string | null;
}

export interface TodoState {
  schemaVersion: typeof TODO_SCHEMA_VERSION;
  /** Next id to hand out; monotonic within the session, never reused. */
  nextId: number;
  /** Insertion order; rendering never reorders. */
  items: TodoItem[];
  updatedAt: string;
}

export function emptyTodoState(now: string = new Date().toISOString()): TodoState {
  return { schemaVersion: TODO_SCHEMA_VERSION, nextId: 1, items: [], updatedAt: now };
}

/** Single line of visible text for one item (shared by every surface). */
export function todoLine(item: TodoItem): string {
  const bullet = item.done ? "●" : "○";
  return `${bullet} [${item.id}] ${item.text}`;
}

/** One operational step; usage errors are data, not exceptions. */
export type TodoOpResult =
  | { ok: true; state: TodoState; message: string }
  | { ok: false; error: string };

export function addTodo(state: TodoState, text: string, now: string): TodoOpResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, error: "Empty task text." };
  if (trimmed.length > 500) return { ok: false, error: "Task text too long (500 chars max)." };
  const item: TodoItem = {
    id: state.nextId,
    text: trimmed,
    done: false,
    addedAt: now,
    doneAt: null,
  };
  return {
    ok: true,
    state: {
      ...state,
      nextId: state.nextId + 1,
      items: [...state.items, item],
      updatedAt: now,
    },
    message: `Added [${item.id}] ${trimmed}`,
  };
}

function findItem(state: TodoState, id: number): TodoItem | null {
  return state.items.find((item) => item.id === id) ?? null;
}

export function completeTodo(state: TodoState, id: number, now: string): TodoOpResult {
  const item = findItem(state, id);
  if (item === null) return { ok: false, error: `No task [${id}].` };
  if (item.done) return { ok: true, state, message: `[${id}] is already done.` };
  const items = state.items.map((i) =>
    i.id === id ? { ...i, done: true, doneAt: now } : i,
  );
  return { ok: true, state: { ...state, items, updatedAt: now }, message: `Done [${id}] ${item.text}` };
}

export function reopenTodo(state: TodoState, id: number, now: string): TodoOpResult {
  const item = findItem(state, id);
  if (item === null) return { ok: false, error: `No task [${id}].` };
  if (!item.done) return { ok: true, state, message: `[${id}] is not done.` };
  const items = state.items.map((i) => (i.id === id ? { ...i, done: false, doneAt: null } : i));
  return { ok: true, state: { ...state, items, updatedAt: now }, message: `Reopened [${id}] ${item.text}` };
}

export function removeTodo(state: TodoState, id: number, now: string): TodoOpResult {
  const item = findItem(state, id);
  if (item === null) return { ok: false, error: `No task [${id}].` };
  return {
    ok: true,
    state: { ...state, items: state.items.filter((i) => i.id !== id), updatedAt: now },
    message: `Removed [${id}] ${item.text}`,
  };
}

/** Remove completed items (open tasks are never touched). */
export function clearCompleted(state: TodoState, now: string): TodoOpResult {
  const removed = state.items.filter((i) => i.done).length;
  if (removed === 0) return { ok: true, state, message: "No completed tasks to clear." };
  return {
    ok: true,
    state: { ...state, items: state.items.filter((i) => !i.done), updatedAt: now },
    message: `Cleared ${removed} completed task${removed === 1 ? "" : "s"}.`,
  };
}

/** The list as returned to the model after any tool call. */
export function renderTodoList(state: TodoState): string[] {
  if (state.items.length === 0) return ["No tasks. Use add to create one."];
  const done = state.items.filter((i) => i.done).length;
  return [
    `Tasks (${done}/${state.items.length} done):`,
    ...state.items.map((i) => `${i.done ? "●" : "○"} [${i.id}] ${i.text}`),
  ];
}

/**
 * System-prompt injection block (before_agent_start, after the scratchpad).
 * Null when empty — no per-turn noise for a session that tracks nothing.
 */
export function renderTodoBlock(state: TodoState, maxChars: number): string | null {
  if (state.items.length === 0) return null;
  const lines = [
    "[PI CONTROL PLANE TASKS]",
    ...state.items.map((i) => `[${i.id}] ${i.done ? "done" : "todo"} — ${i.text}`),
  ];
  let block = lines.join("\n");
  if (block.length > maxChars) block = block.slice(0, maxChars) + "\n[TRUNCATED]";
  return block;
}

/** Minimal structural view of a session entry, matching Pi's CustomEntry. */
export interface CustomEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

function isItem(value: unknown): value is TodoItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "number" || !Number.isInteger(item.id) || item.id < 1) return false;
  if (typeof item.text !== "string" || item.text.trim().length === 0) return false;
  if (typeof item.done !== "boolean") return false;
  if (typeof item.addedAt !== "string") return false;
  if (item.doneAt !== null && typeof item.doneAt !== "string") return false;
  if (item.done && item.doneAt === null) return false; // done implies doneAt
  return true;
}

/** Strict validation. Anything malformed -> null (list starts empty). */
export function validateTodoState(value: unknown): TodoState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== TODO_SCHEMA_VERSION) return null;
  if (typeof record.nextId !== "number" || !Number.isInteger(record.nextId) || record.nextId < 1) {
    return null;
  }
  if (typeof record.updatedAt !== "string") return null;
  if (!Array.isArray(record.items) || !record.items.every(isItem)) return null;
  const items = record.items as TodoItem[];
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length) return null; // ids are unique
  // nextId must be above every existing id (it is "next", never reused).
  if (items.some((i) => i.id >= record.nextId)) return null;
  return { schemaVersion: TODO_SCHEMA_VERSION, nextId: record.nextId, items, updatedAt: record.updatedAt };
}

/**
 * Restore from session entries (newest-last order). Walks backward, takes the
 * first valid todo entry; malformed ones are ignored (counted, warned once by
 * the caller). No valid entry: an empty list, not an error.
 */
export function restoreTodoFromEntries(
  entries: CustomEntryLike[],
  entryType: string,
): { todo: TodoState; restored: boolean; ignoredMalformed: number } {
  let ignoredMalformed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== entryType) continue;
    const validated = validateTodoState(entry.data);
    if (validated !== null) {
      return { todo: validated, restored: true, ignoredMalformed };
    }
    ignoredMalformed++;
  }
  return { todo: emptyTodoState(), restored: false, ignoredMalformed };
}

/** Theme paint as injected by the wiring; colors fall back gracefully. */
export interface TodoPaint {
  fg(color: string, text: string): string;
}

export interface TodoWidgetMeasure {
  measure: (text: string) => number;
  clip: (text: string, max: number) => string;
}

/**
 * The top-right widget: rounded border, radial bullets (○ open, ● done),
 * theme-painted. Pure: returns plain lines padded to `width` cells so the
 * caller can place them in Pi's persistent widget region; empty when there is
 * nothing to show.
 *
 * Right-aligned: every line is padded on the LEFT so the box hugs the right
 * edge of the terminal.
 */
export function renderTodoWidget(
  state: TodoState,
  width: number,
  paint: TodoPaint,
  opts: TodoWidgetMeasure,
): string[] {
  if (state.items.length === 0 || width < 12) return [];
  const done = state.items.filter((i) => i.done).length;
  const shown = state.items.slice(0, TODO_WIDGET_MAX_ITEMS);
  const hidden = state.items.length - shown.length;

  // Box width: the exact width a row needs (leading space + bullet + id +
  // text), or the title, whichever is wider — clamped.
  const contentBudget = shown.reduce(
    (max, i) => Math.max(max, opts.measure(` ${i.done ? "●" : "○"} [${i.id}] ${i.text}`)),
    opts.measure(` ${"Tasks ${done}/${state.items.length}"}`) + 2,
  );
  const inner = Math.max(
    8,
    Math.min(TODO_WIDGET_MAX_WIDTH - 2, contentBudget, width - 2),
  );
  const boxWidth = inner + 2;

  const title = ` Tasks ${done}/${state.items.length} `;
  const titleWidth = opts.measure(title);
  if (inner < titleWidth) return []; // too narrow for the title; no box
  // Title after the corner: "╭─── Tasks 2/5 ─────╮" style.
  const leftRule = Math.max(0, Math.min(3, inner - titleWidth));
  const rightRule = Math.max(0, inner - titleWidth - leftRule);
  const top = `╭${"─".repeat(leftRule)}${title}${"─".repeat(rightRule)}╮`;
  const bottom = `╰${"─".repeat(inner)}╯`;

  // Right-align: left-pad every line so the box hugs the right edge. Paint
  // per segment so styles never cross the padding; each color falls back to
  // a stock-theme-safe one when the theme lacks the token.
  const padWidth = Math.max(0, width - boxWidth);
  const padding = " ".repeat(padWidth);
  const paintOr = (color: string, text: string, fallback: string): string => {
    try {
      return paint.fg(color, text);
    } catch {
      return paint.fg(fallback, text);
    }
  };
  const border = (text: string) => paintOr("borderAccent", text, "dim");

  const painted: string[] = [padding + border(top)];
  for (const item of shown) {
    const bullet = item.done ? "●" : "○";
    const bulletColor = item.done ? "success" : "footerYellow";
    const textColor = item.done ? "muted" : "text";
    let content = `[${item.id}] ${item.text}`;
    if (opts.measure(`${bullet} ${content}`) + 1 > inner) {
      content = opts.clip(content, inner - 5);
    }
    const pad = Math.max(0, inner - opts.measure(`${bullet} ${content}`) - 1);
    painted.push(
      padding +
        border("│") +
        " " +
        paintOr(bulletColor, bullet, "muted") +
        " " +
        paintOr(textColor, content, "muted") +
        " ".repeat(pad) +
        border("│"),
    );
  }
  if (hidden > 0) {
    const more = `+${hidden} more`;
    const pad = Math.max(0, inner - opts.measure(more) - 1);
    painted.push(padding + border("│") + " " + paintOr("dim", more, "muted") + " ".repeat(pad) + border("│"));
  }
  painted.push(padding + border(bottom));
  return painted;
}
