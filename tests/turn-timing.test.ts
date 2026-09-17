/**
 * Unit tests for workload timing (src/control-plane/turn-timing.ts): turn
 * recording and accumulation, the recent-turn cap, strict validation and
 * backward-walking restoration, duration formatting, and rendering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTimingState,
  formatDuration,
  recordTurn,
  renderTimingSummary,
  restoreTimingFromEntries,
  TIMING_ENTRY_TYPE,
  timingFooterSegment,
  validateTimingState,
  type TimingState,
} from "../src/control-plane/turn-timing.ts";

const turn = (totalMs: number, firstTextMs: number | null = null, endedAt = "2026-09-17T00:00:00Z"): {
  firstTextMs: number | null;
  totalMs: number;
  endedAt: string;
} => ({ firstTextMs, totalMs, endedAt });

test("recordTurn: accumulates count, total and slowest; keeps recent oldest-first", () => {
  let state: TimingState = emptyTimingState();
  assert.equal(state.turns, 0);
  assert.equal(state.slowestMs, null);
  state = recordTurn(state, turn(2_000, 500), "t1");
  state = recordTurn(state, turn(30_000, 900), "t2");
  state = recordTurn(state, turn(5_000, null), "t3");
  assert.equal(state.turns, 3);
  assert.equal(state.totalMs, 37_000);
  assert.equal(state.slowestMs, 30_000);
  assert.deepEqual(
    state.recent.map((r) => r.totalMs),
    [2_000, 30_000, 5_000],
  );
  assert.equal(state.updatedAt, "t3");
});

test("recordTurn: recent is capped, older turns fall off, totals keep them", () => {
  let state: TimingState = emptyTimingState();
  for (let i = 1; i <= 14; i++) {
    state = recordTurn(state, turn(i * 1_000), `t${i}`);
  }
  assert.equal(state.turns, 14);
  assert.equal(state.totalMs, (14 * 15) / 2 * 1_000); // 1..14 sum
  assert.equal(state.recent.length, 10);
  // The newest ten remain, oldest first.
  assert.deepEqual(
    state.recent.map((r) => r.totalMs),
    [5_000, 6_000, 7_000, 8_000, 9_000, 10_000, 11_000, 12_000, 13_000, 14_000],
  );
});

test("validateTimingState: strict — schema, types, ranges, cap, consistency", () => {
  const good = emptyTimingState("now");
  assert.notEqual(validateTimingState(good), null);
  assert.equal(validateTimingState(null), null);
  assert.equal(validateTimingState("x"), null);
  assert.equal(validateTimingState({ ...good, schemaVersion: 2 }), null);
  assert.equal(validateTimingState({ ...good, turns: -1 }), null);
  assert.equal(validateTimingState({ ...good, turns: 1.5 }), null);
  assert.equal(validateTimingState({ ...good, totalMs: -3 }), null);
  assert.equal(validateTimingState({ ...good, slowestMs: "x" }), null);
  assert.equal(validateTimingState({ ...good, updatedAt: 5 }), null);
  assert.equal(validateTimingState({ ...good, recent: "nope" }), null);
  assert.equal(validateTimingState({ ...good, recent: [{ totalMs: -1, endedAt: "x" }] }), null);
  assert.equal(
    validateTimingState({ ...good, recent: [{ totalMs: 1, firstTextMs: "no", endedAt: "x" }] }),
    null,
  );
  // turns below the recent length is inconsistent: recent is a suffix.
  assert.equal(
    validateTimingState({ ...good, turns: 1, recent: [turn(1), turn(2)] }),
    null,
  );
  // slowestMs null is fine (before any turn); a number must be non-negative.
  assert.notEqual(validateTimingState({ ...good, slowestMs: 0 }), null);
});

test("restore: newest valid entry wins; malformed ignored; empty otherwise", () => {
  const older = recordTurn(emptyTimingState("a"), turn(1_000), "a");
  const newer = recordTurn(recordTurn(older, turn(2_000), "b"), turn(4_000), "c");
  const entry = (data: unknown) => ({ type: "custom", customType: TIMING_ENTRY_TYPE, data });
  // The walk goes newest-first: the malformed "junk" AFTER the valid newer
  // entry is what ignoredMalformed counts. (The null before older is never
  // reached — once a valid entry is taken, older ones don't matter.)
  const restored = restoreTimingFromEntries(
    [entry(null), entry(older), entry(newer), entry("junk")],
    TIMING_ENTRY_TYPE,
  );
  assert.equal(restored.restored, true);
  assert.equal(restored.timing.turns, 3);
  assert.equal(restored.timing.totalMs, 7_000);
  assert.equal(restored.ignoredMalformed, 1);
  // Only malformed entries and no valid one: not restored, all counted.
  const allBad = restoreTimingFromEntries([entry(null), entry("junk")], TIMING_ENTRY_TYPE);
  assert.equal(allBad.restored, false);
  assert.equal(allBad.ignoredMalformed, 2);
  // Wrong entry type is skipped entirely.
  const none = restoreTimingFromEntries(
    [{ type: "custom", customType: "other", data: newer }],
    TIMING_ENTRY_TYPE,
  );
  assert.equal(none.restored, false);
  assert.equal(none.timing.turns, 0);
  const empty = restoreTimingFromEntries([], TIMING_ENTRY_TYPE);
  assert.equal(empty.restored, false);
});

test("formatDuration: seconds, minutes, hours, clamps negative", () => {
  assert.equal(formatDuration(34_200), "34.2s");
  assert.equal(formatDuration(9_400), "9.4s");
  assert.equal(formatDuration(245_000), "4m 05s");
  assert.equal(formatDuration(60_000), "1m 00s");
  assert.equal(formatDuration(3_785_000), "1h 03m 05s");
  assert.equal(formatDuration(-5), "0.0s");
});

test("timingFooterSegment and renderTimingSummary: empty vs populated", () => {
  assert.equal(timingFooterSegment(emptyTimingState()), "");
  const empty = renderTimingSummary(emptyTimingState());
  assert.deepEqual(empty, ["No completed turns yet in this session."]);

  let state: TimingState = emptyTimingState();
  state = recordTurn(state, turn(2_000, 500), "a");
  state = recordTurn(state, turn(30_000, 900), "b");
  assert.equal(timingFooterSegment(state), "time 32.0s · 2 turns");
  const lines = renderTimingSummary(state);
  assert.match(lines[0]!, /Last turn: first text 0\.90s · total 30\.0s/);
  assert.match(lines[1]!, /Workload: 2 turns · 32\.0s model time · avg 16\.0s\/turn · slowest 30\.0s/);
  assert.match(lines[2]!, /^Recent: 2\.0s, 30\.0s$/);
  state = recordTurn(state, turn(5_000), "c");
  const lines3 = renderTimingSummary(state);
  assert.match(lines3[2]!, /^Recent: 2\.0s, 30\.0s, 5\.0s$/);
});
