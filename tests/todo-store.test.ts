import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { addTodo, emptyTodoState } from "../src/control-plane/todo.ts";
import {
  newerTodo,
  readWorkspaceTodo,
  todoStateDirectory,
  todoStatePath,
  writeWorkspaceTodo,
} from "../src/control-plane/todo-store.ts";

test("default store follows PI_CODING_AGENT_DIR", () => {
  const previousOverride = process.env.PI_CONTROL_PLANE_STATE_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CONTROL_PLANE_STATE_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-test";
  try {
    assert.equal(todoStateDirectory(), "/tmp/pi-agent-test/state/control-plane");
  } finally {
    if (previousOverride === undefined) delete process.env.PI_CONTROL_PLANE_STATE_DIR;
    else process.env.PI_CONTROL_PLANE_STATE_DIR = previousOverride;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("workspace store round-trips state atomically and separates workspaces", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cp-todo-store-"));
  const previous = process.env.PI_CONTROL_PLANE_STATE_DIR;
  process.env.PI_CONTROL_PLANE_STATE_DIR = directory;
  try {
    const first = "/work/first";
    const second = "/work/second";
    const todo = addTodo(emptyTodoState("2026-09-17T10:00:00Z"), "persist me", "2026-09-17T10:01:00Z").state;
    assert.equal(writeWorkspaceTodo(first, todo), null);
    assert.deepEqual(readWorkspaceTodo(first), { todo, malformed: false });
    assert.deepEqual(readWorkspaceTodo(second), { todo: null, malformed: false });
    assert.notEqual(todoStatePath(first), todoStatePath(second));
    assert.equal(fs.readdirSync(path.dirname(todoStatePath(first))).some((name) => name.endsWith(".tmp")), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CONTROL_PLANE_STATE_DIR;
    else process.env.PI_CONTROL_PLANE_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace store rejects malformed JSON; newest timestamp wins", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cp-todo-store-"));
  const previous = process.env.PI_CONTROL_PLANE_STATE_DIR;
  process.env.PI_CONTROL_PLANE_STATE_DIR = directory;
  try {
    const workspace = "/work/project";
    const file = todoStatePath(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json");
    assert.deepEqual(readWorkspaceTodo(workspace), { todo: null, malformed: true });
    const older = emptyTodoState("2026-09-17T10:00:00Z");
    const newer = emptyTodoState("2026-09-17T10:01:00Z");
    assert.equal(newerTodo(older, newer), newer);
    assert.equal(newerTodo(newer, older), newer);
  } finally {
    if (previous === undefined) delete process.env.PI_CONTROL_PLANE_STATE_DIR;
    else process.env.PI_CONTROL_PLANE_STATE_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
