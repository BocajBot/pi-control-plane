import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBashOutput,
  backgroundTaskName,
  isDoublePress,
  markBackgrounded,
  endBashStream,
  extractStreamText,
  formatElapsed,
  renderBashStream,
  startBashStream,
} from "../src/control-plane/bash-stream.ts";

const paint = { fg: (_color: string, text: string) => text };
const opts = {
  measure: (text: string) => Array.from(text).length,
  clip: (text: string, max: number) => {
    const chars = Array.from(text);
    return chars.length > max ? chars.slice(0, Math.max(0, max - 1)).join("") + "…" : text;
  },
};

test("extractStreamText reads pi's cumulative tool_execution payload", () => {
  // Shapes observed from pi 0.85.1 on 2026-09-17.
  assert.equal(extractStreamText({ content: [{ type: "text", text: "line-1\n" }], details: {} }), "line-1\n");
  assert.equal(extractStreamText({ content: [] }), null);
  assert.equal(extractStreamText({}), null);
  assert.equal(extractStreamText(undefined), null);
  assert.equal(
    extractStreamText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    "ab",
  );
});

test("applyBashOutput keeps a bounded tail and is idempotent per snapshot", () => {
  let state = startBashStream("call-1", "npm test", 1000);
  state = applyBashOutput(state, "one\ntwo\n");
  assert.deepEqual(state.lines, ["one", "two"]);
  assert.equal(state.dropped, 0);

  // Same snapshot again (pi re-sends cumulative output) must not duplicate.
  state = applyBashOutput(state, "one\ntwo\n");
  assert.deepEqual(state.lines, ["one", "two"]);

  // Partial last line (no trailing newline) is kept as a line.
  state = applyBashOutput(state, "one\ntwo\nthr");
  assert.deepEqual(state.lines, ["one", "two", "thr"]);

  const many = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n") + "\n";
  state = applyBashOutput(state, many, 4);
  assert.deepEqual(state.lines, ["l6", "l7", "l8", "l9"]);
  assert.equal(state.dropped, 6);
});

test("formatElapsed pads minutes and seconds, adds hours past 60 minutes", () => {
  assert.equal(formatElapsed(0), "00:00");
  assert.equal(formatElapsed(7_000), "00:07");
  assert.equal(formatElapsed(62_000), "01:02");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
});

test("renderBashStream draws a width-bounded box with status and tail", () => {
  let state = startBashStream("call-1", "npm   test", 1000);
  state = applyBashOutput(state, "ok 1\nok 2\nok 3\n");
  const lines = renderBashStream(state, 40, 8000, paint, opts, 2);
  for (const line of lines) assert.equal(opts.measure(line), 40, line);
  assert.match(lines[0], /bash · npm test/);
  assert.match(lines[0], /running 00:07/);
  // tailRows=2 keeps only the last two output lines.
  assert.match(lines[1], /ok 2/);
  assert.match(lines[2], /ok 3/);
  assert.match(lines[lines.length - 1], /alt\+o hide/);

  const done = renderBashStream(endBashStream(state, 4000, false), 40, 90_000, paint, opts);
  // Elapsed freezes at completion instead of tracking wall clock.
  assert.match(done[0], /done 00:03/);
  const failed = renderBashStream(endBashStream(state, 4000, true), 40, 9000, paint, opts);
  assert.match(failed[0], /failed 00:03/);
});

test("renderBashStream collapses to nothing without a stream or room", () => {
  assert.deepEqual(renderBashStream(null, 80, 0, paint, opts), []);
  const state = applyBashOutput(startBashStream("c", "ls", 0), "x\n");
  assert.deepEqual(renderBashStream(state, 10, 0, paint, opts), []);
});

test("renderBashStream reports dropped lines and strips control characters", () => {
  let state = startBashStream("call-1", "yes", 0);
  const many = Array.from({ length: 8 }, (_, i) => `l${i}`).join("\n") + "\n";
  state = applyBashOutput(state, many, 3);
  const lines = renderBashStream(state, 40, 1000, paint, opts);
  assert.match(lines[1], /5 earlier lines dropped/);

  const noisy = applyBashOutput(startBashStream("c", "build", 0), "a\u0007b\tc\n");
  const rendered = renderBashStream(noisy, 40, 0, paint, opts);
  assert.match(rendered[1], /ab {2}c/);
  for (const line of rendered) assert.equal(opts.measure(line), 40, line);
});

test("renderBashStream shows a placeholder before the first output arrives", () => {
  const state = startBashStream("call-1", "sleep 10", 0);
  const lines = renderBashStream(state, 40, 2000, paint, opts);
  assert.match(lines[1], /no output yet/);
});

test("isDoublePress accepts only a second press inside the window", () => {
  assert.equal(isDoublePress(null, 1000), false);
  assert.equal(isDoublePress(1000, 1400, 800), true);
  assert.equal(isDoublePress(1000, 1801, 800), false);
  assert.equal(isDoublePress(1000, 1000, 800), true);
  // A clock that jumped backwards must not count as a double press.
  assert.equal(isDoublePress(2000, 1000, 800), false);
});

test("backgroundTaskName shortens the command to a dock label", () => {
  assert.equal(backgroundTaskName("npm   test"), "npm test");
  assert.equal(backgroundTaskName(""), "bash task");
  assert.equal(
    backgroundTaskName("for i in 1 2 3 4 5 6; do echo x; done"),
    "for i in 1 2 3",
  );
  const long = backgroundTaskName("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(long.length, 40);
  assert.match(long, /…$/);
});

test("marking after the abort's end event still reports background", () => {
  // Real ordering: ctx.abort() -> tool_execution_end (isError) -> task id.
  let state = applyBashOutput(startBashStream("call-1", "npm test", 0), "building\n");
  state = endBashStream(state, 5000, true);
  state = markBackgrounded(state, "task-9");
  assert.equal(state.isError, false);
  const lines = renderBashStream(state, 60, 9000, paint, opts);
  assert.match(lines[0], /background 00:05/);
  assert.match(lines.join("\n"), /restarted as background task task-9/);
});

test("a backgrounded call reports background, not failed, when the abort lands", () => {
  let state = markBackgrounded(
    applyBashOutput(startBashStream("call-1", "npm test", 0), "building\n"),
    "task-7",
  );
  // ctx.abort() makes pi deliver an error result for the aborted call.
  state = endBashStream(state, 5000, true);
  assert.equal(state.isError, false);
  const lines = renderBashStream(state, 60, 9000, paint, opts);
  assert.match(lines[0], /background 00:05/);
  assert.match(lines.join("\n"), /restarted as background task task-7/);
  for (const line of lines) assert.equal(opts.measure(line), 60, line);
});
