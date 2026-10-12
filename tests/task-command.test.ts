import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskArgs } from "../src/control-plane/commands.ts";

test("/task parser accepts add with text and preserves internal whitespace", () => {
  assert.deepEqual(parseTaskArgs(" add  Test  this\nthen that  "), { kind: "add", text: "Test  this\nthen that" });
  assert.deepEqual(parseTaskArgs("ADD a task"), { kind: "add", text: "a task" });
  for (const args of ["", "add", "add  ", "remove 1", "list", "addition text"]) {
    assert.deepEqual(parseTaskArgs(args), { kind: "usage" });
  }
});

test("/task parser accepts clear with no extra args, case-insensitive", () => {
  assert.deepEqual(parseTaskArgs("clear"), { kind: "clear" });
  assert.deepEqual(parseTaskArgs(" CLEAR "), { kind: "clear" });
  for (const args of ["clear now", "clear all", "cleared"]) {
    assert.deepEqual(parseTaskArgs(args), { kind: "usage" });
  }
});
