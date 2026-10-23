/**
 * Unit tests for prefill progress parsing (src/control-plane/prefill-progress.ts):
 * incremental line feeding across chunk boundaries, progress extraction from
 * llama.cpp "prompt processing" lines, rejection of unrelated lines, and the
 * working-message formatting.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPrefillProgressParser,
  formatWorkingMessage,
} from "../src/control-plane/prefill-progress.ts";

const LINE = (p: number, tokens = 2048) =>
  `2.03.052.495 I slot print_timing: id  0 | task 267 | prompt processing, n_tokens = ${String(tokens).padStart(6)} , progress = ${p}, t =   4.55 s / 450.26 tokens per second\n`;

test("feed: extracts progress from a complete line", () => {
  const p = createPrefillProgressParser();
  assert.equal(p.feed(LINE(0.02)), 0.02);
});

test("feed: returns null for chunks without a progress line", () => {
  const p = createPrefillProgressParser();
  assert.equal(p.feed("1.24.548.834 I llama_context: n_ctx                 = 524288\n"), null);
  assert.equal(p.feed("no newline at all"), null);
});

test("feed: handles a line split across chunks", () => {
  const p = createPrefillProgressParser();
  const line = LINE(0.42, 10240);
  const cut = line.indexOf("progress");
  assert.equal(p.feed(line.slice(0, cut)), null);
  assert.equal(p.feed(line.slice(cut)), 0.42);
});

test("feed: handles a chunk ending mid-value", () => {
  const p = createPrefillProgressParser();
  const line = LINE(0.75);
  const cut = line.indexOf("0.75") + 2; // after "0."
  assert.equal(p.feed(line.slice(0, cut)), null);
  assert.equal(p.feed(line.slice(cut)), 0.75);
});

test("feed: latest progress wins within one chunk", () => {
  const p = createPrefillProgressParser();
  assert.equal(p.feed(LINE(0.1) + LINE(0.2, 4096) + LINE(0.3, 6144)), 0.3);
});

test("feed: ignores non-prefill lines containing 'progress'", () => {
  const p = createPrefillProgressParser();
  assert.equal(p.feed("some other tool: progress = 0.99\n"), null);
});

test("feed: clamps out-of-range values into [0, 1]", () => {
  const p = createPrefillProgressParser();
  assert.equal(p.feed(LINE(1)), 1);
  const q = createPrefillProgressParser();
  assert.equal(q.feed(LINE(0.999)), 0.999);
});

test("reset: drops a buffered partial line", () => {
  const p = createPrefillProgressParser();
  p.feed("prompt processing, n_tokens =     1024, progress = 0.");
  p.reset();
  assert.equal(p.feed("5\n"), null); // "0." was dropped; "5" alone is not a line match
});

test("formatWorkingMessage: renders a percentage", () => {
  assert.equal(formatWorkingMessage(0.42), "Working 42%");
  assert.equal(formatWorkingMessage(0), "Working 0%");
  assert.equal(formatWorkingMessage(1), "Working 100%");
  assert.equal(formatWorkingMessage(0.995), "Working 100%");
});
