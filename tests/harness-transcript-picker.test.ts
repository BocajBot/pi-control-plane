import assert from "node:assert/strict";
import test from "node:test";

import { parseTranscriptHeader, renderTranscriptPicker } from "../src/harness/transcript-picker.ts";

const HEADER = [
  "# delegate transcript dlg_abc",
  "# kind: subagent  model: llama-swap/qwen3-8-27b  started: 2026-08-25T01:58:12.859Z",
  "# objective: Summarize the template",
  "",
  "[delegate turn started]",
].join("\n");

test("header parses into a picker entry", () => {
  const entry = parseTranscriptHeader("dlg_abc", HEADER);
  assert.equal(entry.kind, "subagent");
  assert.equal(entry.model, "llama-swap/qwen3-8-27b");
  assert.equal(entry.objective, "Summarize the template");
  assert.equal(entry.startedAt, "2026-08-25T01:58:12.859Z");
});

test("a truncated or foreign file stays selectable with placeholders", () => {
  const entry = parseTranscriptHeader("dlg_x", "garbage\nlines");
  assert.equal(entry.id, "dlg_x");
  assert.equal(entry.objective, "(unknown objective)");
});

test("picker renders a cursor row per entry and clips to width", () => {
  const entries = [parseTranscriptHeader("dlg_abc", HEADER), parseTranscriptHeader("dlg_def", HEADER)];
  const lines = renderTranscriptPicker(entries, 1, 40);
  assert.equal(lines.filter((l) => l.startsWith("→ ")).length, 1);
  assert.ok(lines.some((l) => l.startsWith("→ ") && lines.indexOf(l) === 3), "cursor on second entry");
  assert.ok(lines.every((l) => l.length <= 40));
});

test("empty list renders a close hint, not a crash", () => {
  const lines = renderTranscriptPicker([], 0, 60);
  assert.ok(lines.some((l) => /none recorded/.test(l)));
});
