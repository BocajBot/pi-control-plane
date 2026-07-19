import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateTokens,
  formatDraftCounter,
  formatFooterStats,
  formatTokenCount,
} from "../src/control-plane/ui.ts";

test("estimateTokens: ~4 chars per token, zero only for empty", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("hi"), 1);
  assert.equal(estimateTokens("a".repeat(8)), 2);
  assert.equal(estimateTokens("a".repeat(9)), 3);
});

test("formatDraftCounter right-aligns within the width", () => {
  const line = formatDraftCounter("hello world!", 40);
  assert.equal(line.length, 40);
  assert.ok(line.endsWith("Token Counter: ~3"));
  assert.ok(line.startsWith(" "));
  // Narrow width: label survives untruncated even if wider than the box.
  assert.equal(formatDraftCounter("", 5), "Token Counter: ~0");
});

test("formatTokenCount matches pi's footer formatting", () => {
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(4200), "4.2k");
  assert.equal(formatTokenCount(49000), "49k");
  assert.equal(formatTokenCount(1500000), "1.5M");
  assert.equal(formatTokenCount(12000000), "12M");
});

test("formatFooterStats spells out every segment in plain words", () => {
  const { stats, context } = formatFooterStats({
    input: 4200,
    output: 30,
    cacheRead: 4200,
    cacheWrite: 1000,
    cost: 0.123,
    cacheHitPercent: 99.2,
    contextPercent: 8.6,
    contextWindow: 49000,
  });
  assert.equal(
    stats,
    "sent 4.2k · received 30 · cache 4.2k reused, 1.0k stored (99.2% hits) · cost $0.123",
  );
  assert.equal(context, "context ~8.6% of 49k (estimated)");
  const exact = formatFooterStats({
    input: 4200,
    output: 30,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    cacheHitPercent: null,
    contextPercent: 8.6,
    contextWindow: 49152,
    exactTokens: 17243,
  });
  assert.equal(exact.context, "context 17,243 of 49,152 tokens at last request (model tokenizer)");
});

test("formatFooterStats omits zero segments and unknown values", () => {
  const empty = formatFooterStats({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    cacheHitPercent: null,
    contextPercent: null,
    contextWindow: 49000,
  });
  assert.equal(empty.stats, "");
  assert.equal(empty.context, "context ? of 49k (estimated)");

  const noHit = formatFooterStats({
    input: 100,
    output: 0,
    cacheRead: 500,
    cacheWrite: 0,
    cost: 0,
    cacheHitPercent: null,
    contextPercent: 12,
    contextWindow: 49000,
  });
  assert.equal(noHit.stats, "sent 100 · cache 500 reused");
  assert.equal(noHit.context, "context ~12.0% of 49k (estimated)");
});
