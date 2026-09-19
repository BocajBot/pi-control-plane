import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextWarningLevel,
  compactFooterState,
  estimateTokens,
  formatAddedContext,
  formatContextWarning,
  formatDraftCounter,
  formatCacheRates,
  formatFooterStats,
  formatTokenCount,
  renderActiveTools,
  renderDiagnosticsPanel,
} from "../src/control-plane/ui.ts";

test("contextWarningLevel thresholds: warn at 75, urgent at 90", () => {
  assert.equal(contextWarningLevel(74.9), null);
  assert.equal(contextWarningLevel(75), "warn");
  assert.equal(contextWarningLevel(89.9), "warn");
  assert.equal(contextWarningLevel(90), "urgent");
  assert.equal(contextWarningLevel(120), "urgent");
});

test("formatContextWarning states source, counts, and next step", () => {
  const warn = formatContextWarning("warn", 38000, 49152);
  assert.ok(warn.includes("77.3% full"));
  assert.ok(warn.includes("model's own tokenizer"));
  assert.ok(warn.includes("38,000 of 49,152"));
  assert.ok(warn.includes("/compact"));
  const urgent = formatContextWarning("urgent", 45000, 49152);
  assert.ok(urgent.includes("91.6% full"));
  assert.ok(urgent.includes("auto-compaction watches its own estimate"));
  assert.ok(urgent.includes("/compact now"));
});

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

test("formatAddedContext: exact plain, estimate tilded, unknown as ?", () => {
  const exact = formatAddedContext(2897, true, 40);
  assert.equal(exact.length, 40);
  assert.ok(exact.endsWith("Added Context: 2,897"));
  assert.ok(formatAddedContext(4222, false, 40).endsWith("Added Context: ~4,222"));
  assert.ok(formatAddedContext(null, false, 40).endsWith("Added Context: ?"));
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
    "sent 4.2k · received 30 · cache 4.2k reused, 1.0k stored (99.2% hits, 0.8% misses) · cost $0.123",
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

test("formatCacheRates reports hit and miss as complements", () => {
  assert.equal(formatCacheRates(99.2), "cache 99.2% hit, 0.8% miss");
  assert.equal(formatCacheRates(0), "cache 0.0% hit, 100.0% miss");
  assert.equal(formatCacheRates(null), null);
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


test("minimal footer exposes only contextual state and preserves restriction reasons", async () => {
  const { defaultState } = await import("../src/control-plane/state.ts");
  const state = defaultState();
  assert.deepEqual(compactFooterState(state, true, 10, false), {
    mode: "Plan", attention: [], // discuss/read-only -> the sole read-only mode "Plan"
  });
  assert.match(compactFooterState(state, true, 75, false).attention.map((item) => item.text).join(), /~75% estimated.*compact/);
  assert.match(compactFooterState(state, true, 90, true).attention.map((item) => item.text).join(), /90% at last request/);
  assert.equal(compactFooterState(state, true, 90, true).attention[0].color, "error");
  assert.equal(compactFooterState(state, true, 75, false).attention[0].color, "warning");
  state.phase = "execute";
  state.autonomy = "unattended";
  const blocked = compactFooterState(state, false, null, false);
  assert.equal(blocked.mode, "Read-only");
  assert.match(blocked.attention.map((item) => item.text).join(), /policy invalid/);
});


test("context tool list is complete, stable, left-grid aligned and width bounded", () => {
  const lines = renderActiveTools(["write", "read", "read", "bash"], 80, undefined, "minimal");
  assert.deepEqual(lines.map((line) => line.trim()), [
    "PROFILE minimal  ·  TOOLS 3  bash · read · write  ·  ctrl+alt+t",
  ]);
  assert.ok(lines.every((line) => line.length <= 80));
  assert.ok(lines[0].startsWith(" PROFILE "), "left grid: one leading pad column");
  assert.match(renderActiveTools([], 40)[0].trim(), /^PROFILE custom  ·  TOOLS 0  None/);
  assert.deepEqual(renderActiveTools(["read"], 0), []);
  // header is a single clipped line now (point 15); full list lives in ctrl+alt+t / /context full
  for (const width of [1, 12, 40]) {
    const rows = renderActiveTools(["very_long_custom_tool_name", "read"], width);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].length <= width);
  }
  const wide = renderActiveTools(["very_long_custom_tool_name", "read"], 80);
  assert.equal(wide.length, 1);
  assert.ok(wide[0].includes("very_long_custom_tool_name"));
  assert.ok(renderActiveTools(["very_long_custom_tool_name", "read"], 12)[0].endsWith("…"), "clipped, not wrapped");
});

test("renderActiveTools caps the header at 7 names", () => {
  const nine = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"];
  const rows = renderActiveTools(nine, 120);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trim(), "PROFILE custom  ·  TOOLS 9  t1 · t2 · t3 · t4 · t5 · t6 · t7 · +2 more  ·  ctrl+alt+t");
  const seven = renderActiveTools(nine.slice(0, 7), 120);
  assert.equal(seven[0].trim(), "PROFILE custom  ·  TOOLS 7  t1 · t2 · t3 · t4 · t5 · t6 · t7  ·  ctrl+alt+t");
  assert.ok(!seven[0].includes("more"));
});

test("renderDiagnosticsPanel: opaque, bordered, shadowed, width-bounded, content-fit", () => {
  const paint = {
    bg: (s: string) => `<bg>${s}</bg>`,
    selectedBg: (s: string) => `<sel>${s}</sel>`,
    fg: (_color: string, s: string) => s,
  };
  const strip = (line: string) => line.replace(/<\/?(bg|sel)>/g, "");
  const rows = [
    { glyph: "✗", tone: "error", label: "Blocked: read before edit", subject: '"write"', at: "T1" },
    { glyph: "◐", tone: "warning", label: "Advisor consult", subject: "", at: "T2" },
    { glyph: "✓", tone: "success", label: "Backup before edit", subject: "/very/long/path/to/some/file.txt", at: "T3" },
  ];
  for (const width of [8, 12, 40, 80, 120]) {
    const lines = renderDiagnosticsPanel(rows, 1, width, paint);
    // 7 chrome rows (top, title, blank, blank, hint, bottom, shadow) + 3 diagnostics
    assert.equal(lines.length, 10, `height fits content at width ${width}`);
    for (const line of lines) assert.equal(Array.from(strip(line)).length, width, `line width at ${width}: ${line}`);
    assert.ok(strip(lines[0]).startsWith("╭"));
    assert.ok(strip(lines[0]).endsWith(" "), "top border has no shadow");
    for (const line of lines.slice(1, -1)) assert.ok(strip(line).endsWith("░"), `shadow column: ${line}`);
    assert.equal(strip(lines.at(-1)!), " " + "░".repeat(width - 1), "bottom shadow row");
    // Every panel line is painted (opaque); only the selected diagnostic row uses selectedBg.
    for (const line of lines.slice(0, -1)) assert.ok(line.includes("<bg>"), `opaque: ${line}`);
    const body = lines.slice(3, 6);
    assert.ok(body[1].includes("<sel>") && body[1].includes("◐"));
    assert.ok(!body[0].includes("<sel>") && !body[2].includes("<sel>"));
  }
  const wide = renderDiagnosticsPanel(rows, 0, 80, paint).map(strip);
  assert.match(wide[1], /Control plane diagnostics \(3\)/);
  assert.match(wide[3], /✗ Blocked: read before edit "write"\s+T1/);
  assert.match(wide[7], /↑↓ move · enter\/esc close/);
  const empty = renderDiagnosticsPanel([], 0, 40, paint).map(strip);
  assert.equal(empty.length, 8, "title + blank + placeholder + blank + hint + 2 borders + shadow");
  assert.match(empty[3], /\(no diagnostics this session\)/);
  assert.deepEqual(renderDiagnosticsPanel(rows, 0, 7, paint), []);
  // Row window: more rows than the cap keeps the panel at the cap, around the selection.
  const many = Array.from({ length: 20 }, (_, i) => ({ glyph: "○", tone: "dim", label: `row${i}`, subject: "", at: "" }));
  const capped = renderDiagnosticsPanel(many, 19, 60, paint, 5).map(strip);
  assert.equal(capped.length, 7 + 5);
  assert.match(capped[7], /row19/);
});
