import assert from "node:assert/strict";
import test from "node:test";

import { parseTranscriptHeader, renderTranscriptPicker } from "../src/harness/transcript-picker.ts";

const HEADER = [
  "# delegate transcript dlg_abc",
  "# kind: subagent  model: llama-swap/qwen3-8-27b  started: 2026-08-25T01:58:12.859Z",
  "# objective: Summarize the template",
  "# session: /home/u/.pi/agent/sessions/x/child.jsonl",
  "",
  "[delegate turn started]",
].join("\n");

test("header parses into a picker entry", () => {
  const entry = parseTranscriptHeader("dlg_abc", HEADER);
  assert.equal(entry.kind, "subagent");
  assert.equal(entry.model, "llama-swap/qwen3-8-27b");
  assert.equal(entry.objective, "Summarize the template");
  assert.equal(entry.startedAt, "2026-08-25T01:58:12.859Z");
  assert.equal(entry.sessionFile, "/home/u/.pi/agent/sessions/x/child.jsonl");
});

test("a pre-sub-session transcript (no session line) parses with sessionFile null", () => {
  const entry = parseTranscriptHeader("dlg_old", "# delegate transcript dlg_old\n# objective: O\n");
  assert.equal(entry.sessionFile, null);
});

test("a truncated or foreign file stays selectable with placeholders", () => {
  const entry = parseTranscriptHeader("dlg_x", "garbage\nlines");
  assert.equal(entry.id, "dlg_x");
  assert.equal(entry.objective, "(unknown objective)");
});

test("picker renders a bordered, fully padded box with one cursor row", () => {
  const entries = [parseTranscriptHeader("dlg_abc", HEADER), parseTranscriptHeader("dlg_def", HEADER)];
  const lines = renderTranscriptPicker(entries, 1, 60);
  assert.equal(lines.filter((l) => l.includes("→ ")).length, 1);
  // Every row painted to the same full width: pi overlays composite over the
  // chat, so an unpadded cell shows the text underneath (seen live as a
  // "graphical bug").
  const widths = new Set(lines.map((l) => l.length));
  assert.equal(widths.size, 1, `ragged rows: ${[...widths].join(",")}`);
  assert.ok(lines[0].startsWith("╭") && lines.at(-1)!.startsWith("╰"), "bordered");
});

test("empty list renders a close hint inside the same box", () => {
  const lines = renderTranscriptPicker([], 0, 60);
  assert.ok(lines.some((l) => /none recorded/.test(l)));
  assert.equal(new Set(lines.map((l) => l.length)).size, 1);
});
