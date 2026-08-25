import assert from "node:assert/strict";
import test from "node:test";

import { transcriptLinesFor, transcriptTail } from "../src/harness/delegate-transcript.ts";

test("assistant message_end renders text and a thinking preview; user echo does not", () => {
  const lines = transcriptLinesFor({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "consider the file layout\nmore thoughts" },
        { type: "text", text: "Found it.\nSecond line." },
      ],
    },
  });
  assert.deepEqual(lines, ["[thinking] consider the file layout", "assistant: Found it.", "assistant: Second line."]);
  assert.deepEqual(transcriptLinesFor({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "the prompt" }] } }), []);
});

test("tool start and end become one line each, with args and status", () => {
  assert.deepEqual(transcriptLinesFor({ type: "tool_execution_start", toolName: "scoped_read", args: { file_path: "/x" } }), [
    'tool> scoped_read {"file_path":"/x"}',
  ]);
  const end = transcriptLinesFor({
    type: "tool_execution_end",
    toolName: "scoped_read",
    result: { isError: false, content: [{ type: "text", text: "line one\nline two" }] },
  });
  assert.deepEqual(end, ["tool< scoped_read [ok] line one"]);
});

test("streaming partials are dropped - the transcript records completions only", () => {
  assert.deepEqual(transcriptLinesFor({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "par" }] } }), []);
  assert.deepEqual(transcriptLinesFor({ type: "tool_execution_update", toolName: "x" }), []);
});

test("oversized args are truncated, not dumped", () => {
  const [line] = transcriptLinesFor({ type: "tool_execution_start", toolName: "t", args: { blob: "x".repeat(500) } });
  assert.ok(line.length < 200, `line was ${line.length} chars`);
  assert.match(line, /…$/);
});

test("the live tail keeps the last lines and says how many came before", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
  const tail = transcriptTail(lines, 5);
  assert.match(tail, /15 earlier lines/);
  assert.match(tail, /line 19$/);
  assert.equal(transcriptTail([]), "[delegate starting…]");
});
