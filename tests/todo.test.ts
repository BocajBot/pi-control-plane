/**
 * Unit tests for task tracking (src/control-plane/todo.ts): the state machine
 * (add/complete/reopen/remove/clear), strict validation and restoration, the
 * system-prompt block, the list rendering, and the top-right widget (rounded
 * border, radial bullets, right alignment, cap, painting with fallbacks).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
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
  TODO_ENTRY_TYPE,
  type TodoPaint,
  type TodoState,
  validateTodoState,
} from "../src/control-plane/todo.ts";

const now = "2026-09-17T00:00:00Z";

function withItems(count: number): TodoState {
  let state = emptyTodoState(now);
  for (let i = 1; i <= count; i++) {
    state = addTodo(state, `task ${i}`, now).state;
  }
  return state;
}

test("state machine: add assigns monotonic ids; complete removes task; remove keeps ids monotonic", () => {
  let state = emptyTodoState(now);
  const added = addTodo(state, "read config", now);
  assert.equal(added.ok, true);
  assert.equal(added.state.items[0]!.id, 1);
  state = addTodo(added.state, "write tests", now).state;
  state = addTodo(state, "update docs", now).state;
  assert.deepEqual(
    state.items.map((i) => i.id),
    [1, 2, 3],
  );

  const done = completeTodo(state, 2, now);
  assert.equal(done.ok, true);
  assert.deepEqual(done.state.items.map((item) => item.id), [1, 3]);
  assert.equal(done.message, "Task [2] - write tests has completed.");
  assert.equal(completeTodo(done.state, 2, now).ok, false, "completed task is no longer live");
  assert.equal(reopenTodo(done.state, 2, now).ok, false, "completed task cannot return to the live list");

  const removed = removeTodo(state, 1, now);
  assert.deepEqual(
    removed.state.items.map((i) => i.id),
    [2, 3],
  );
  // Ids are never reused after a remove.
  const readded = addTodo(removed.state, "new task", now).state;
  assert.equal(readded.items.at(-1)!.id, 4);

  assert.equal(removeTodo(state, 99, now).ok, false);
  assert.equal(completeTodo(state, 99, now).ok, false);

  const legacy = withItems(3);
  let cleared = {
    ...legacy,
    items: legacy.items.map((item) => item.id === 1 ? { ...item, done: true, doneAt: now } : item),
  };
  const clearedResult = clearCompleted(cleared, now);
  assert.equal(clearedResult.ok, true);
  cleared = clearedResult.state;
  assert.deepEqual(
    cleared.items.map((i) => i.id),
    [2, 3],
  );
  assert.equal(clearCompleted(emptyTodoState(now), now).message, "No completed tasks to clear.");
});

test("state machine: rejects empty and oversized text", () => {
  const state = emptyTodoState(now);
  assert.equal(addTodo(state, "   ", now).ok, false);
  assert.equal(addTodo(state, "x".repeat(501), now).ok, false);
  assert.equal(addTodo(state, "x".repeat(500), now).ok, true);
});

test("renderTodoList and renderTodoBlock: open tasks only, and empty renders nothing", () => {
  const state = withItems(3);
  const list = renderTodoList(state);
  assert.deepEqual(list, [
    "Tasks (0/3 done):",
    "○ [1] task 1",
    "○ [2] task 2",
    "○ [3] task 3",
  ]);
  assert.deepEqual(renderTodoList(emptyTodoState(now)), ["No tasks. Use add to create one."]);

  const block = renderTodoBlock(state, 1000);
  assert.match(block!, /^\[PI CONTROL PLANE TASKS\]$/m);
  assert.match(block!, /\[2\] todo — task 2/);
  assert.match(block!, /\[1\] todo — task 1/);
  assert.equal(renderTodoBlock(emptyTodoState(now), 1000), null);
  // Truncation honors the cap, marked.
  const truncated = renderTodoBlock(state, 30)!;
  assert.match(truncated, /\[TRUNCATED\]$/);
});

test("validateTodoState: strict — schema, ids, monotonic nextId, done/doneAt consistency", () => {
  const base = withItems(2);
  const good = {
    ...base,
    items: base.items.map((item) => item.id === 1 ? { ...item, done: true, doneAt: now } : item),
  };
  assert.notEqual(validateTodoState(good), null);
  assert.equal(validateTodoState(null), null);
  assert.equal(validateTodoState({ ...good, schemaVersion: 2 }), null);
  assert.equal(validateTodoState({ ...good, nextId: 0 }), null);
  assert.equal(validateTodoState({ ...good, nextId: 1 }), null); // below an existing id
  assert.equal(validateTodoState({ ...good, updatedAt: 3 }), null);
  assert.equal(validateTodoState({ ...good, items: "no" }), null);
  assert.equal(
    validateTodoState({ ...good, items: [{ ...good.items[0]!, id: 0 }] }),
    null,
  );
  // duplicate ids
  assert.equal(
    validateTodoState({ ...good, items: [good.items[0]!, { ...good.items[1]!, id: 1 }] }),
    null,
  );
  // done without doneAt is inconsistent (items[0] is the completed one)
  assert.equal(
    validateTodoState({ ...good, items: [{ ...good.items[0]!, doneAt: null }, good.items[1]!] }),
    null,
  );
  // empty list is valid
  assert.notEqual(validateTodoState(emptyTodoState(now)), null);
});

test("restore: newest valid entry wins; malformed counted; none -> empty", () => {
  const older = withItems(1);
  const newer = withItems(3);
  const entry = (data: unknown) => ({ type: "custom", customType: TODO_ENTRY_TYPE, data });
  const restored = restoreTodoFromEntries(
    [entry(older), entry(newer), entry("junk")],
    TODO_ENTRY_TYPE,
  );
  assert.equal(restored.restored, true);
  assert.equal(restored.todo.items.length, 3);
  assert.equal(restored.ignoredMalformed, 1);
  const none = restoreTodoFromEntries(
    [{ type: "custom", customType: "other", data: newer }],
    TODO_ENTRY_TYPE,
  );
  assert.equal(none.restored, false);
  assert.equal(none.todo.items.length, 0);
  const allBad = restoreTodoFromEntries([entry("x"), entry(null)], TODO_ENTRY_TYPE);
  assert.equal(allBad.restored, false);
  assert.equal(allBad.ignoredMalformed, 2);
});

const plainMeasure = (text: string) => Array.from(text).length;
/** Measure ignoring paint markers, so width assertions see real cells. */
const markedMeasure = (text: string) => plainMeasure(text.replace(/\{[^}]*\}/g, ""));
const plainClip = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, Math.max(0, max - 1)).join("") + "…" : text;
};
/** Paint that marks applied colors so assertions can see them. */
const markingPaint: TodoPaint = {
  fg(color: string, text: string) {
    if (color === "nope") throw new Error("unknown token");
    return `{${color}}${text}`;
  },
};

test("renderTodoWidget: rounded border, open bullets, right-aligned, capped", () => {
  const state = withItems(8);
  const lines = renderTodoWidget(state, 80, markingPaint, { measure: plainMeasure, clip: plainClip });
  assert.equal(lines.length, 1 + 6 + 1 + 1); // top + 6 shown + "+2 more" + bottom
  assert.match(lines[0]!.replace(/\{[^}]*\}/g, ""), /╭─* Tasks 0\/8 ─*╮$/);
  assert.match(lines.at(-1)!, /╰─+╯$/);
  // Right-aligned: every line ends at the right edge (80 cells, markers stripped).
  for (const line of lines) {
    assert.equal(markedMeasure(line), 80);
  }
  // Completed items leave the widget; open-task bullets are yellow.
  const row = (id: number) => lines.find((l) => l.includes(`[${id}]`))!;
  assert.match(row(1), /○/);
  assert.match(row(1), /\{footerYellow\}○/);
  assert.match(row(1), /\{text\}\[1\] task 1/);
  assert.match(lines.find((l) => l.includes("more"))!, /\{dim\}\+2 more/);
  // Border uses To-Do's neon-purple theme token; open-task bullets are yellow; title is blue.
  assert.match(lines[0]!, /\{todoBorder\}╭/);
  assert.match(lines[0]!, /\{todoTitle\} Tasks 0\/8 /);
  // Empty state renders nothing.
  assert.deepEqual(renderTodoWidget(emptyTodoState(now), 80, markingPaint, { measure: plainMeasure, clip: plainClip }), []);
  // Long text wraps, never truncates or widens the box.
  const longText = "x".repeat(80);
  const long = addTodo(emptyTodoState(now), longText, now).state;
  const longLines = renderTodoWidget(long, 80, markingPaint, { measure: plainMeasure, clip: plainClip });
  for (const line of longLines) {
    assert.equal(markedMeasure(line), 80);
  }
  assert.doesNotMatch(longLines.join("\n"), /…/);
  assert.ok(longLines.length > 3, "long task needs continuation rows");
  assert.equal(
    longLines.join("").replace(/\{[^}]*\}/g, "").match(/x/g)?.length,
    longText.length,
    "all task text remains visible",
  );
});

test("renderTodoWidget: color fallback when the theme lacks a token", () => {
  const state = withItems(1);
  const fallbackPaint: TodoPaint = {
    fg(color: string, text: string) {
      if (color !== "muted" && color !== "dim" && color !== "text") throw new Error("no token");
      return `<${color}>${text}`;
    },
  };
  const lines = renderTodoWidget(state, 40, fallbackPaint, { measure: plainMeasure, clip: plainClip });
  // todoBorder, footerYellow, success all fall back without throwing.
  assert.match(lines[0]!, /<dim>╭/);
  assert.match(lines[1]!, /<muted>○/);
  assert.equal(lines.length, 3);
});

test("renderTodoWidget: too-narrow terminal renders nothing", () => {
  const state = withItems(1);
  assert.deepEqual(
    renderTodoWidget(state, 10, markingPaint, { measure: plainMeasure, clip: plainClip }),
    [],
  );
});
