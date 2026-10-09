import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COOLDOWN_MESSAGES,
  initialThinkingState,
  onAssistantMessageStart,
  overexpansionFix,
  recordThinking,
  thinkingBudgetFor,
} from "../src/control-plane/thinking-budget.ts";

test("budget by level: chosen values, off/unknown/undefined unlimited", () => {
  assert.equal(thinkingBudgetFor("low"), 2000);
  assert.equal(thinkingBudgetFor("medium"), 4000);
  assert.equal(thinkingBudgetFor("xhigh"), 8000);
  assert.equal(thinkingBudgetFor("off"), null);
  assert.equal(thinkingBudgetFor("bogus"), null);
  assert.equal(thinkingBudgetFor(undefined), null);
});

test("trips exactly once when a message crosses the budget", () => {
  let s = onAssistantMessageStart(initialThinkingState());
  let v = recordThinking(s, 3000, 4000);
  assert.equal(v.exceeded, false);
  v = recordThinking(v.state, 1000, 4000); // exactly at budget: allowed
  assert.equal(v.exceeded, false);
  v = recordThinking(v.state, 1, 4000);
  assert.equal(v.exceeded, true);
  assert.equal(v.state.chars, 4001);
  v = recordThinking(v.state, 500, 4000); // deltas still arriving before abort lands
  assert.equal(v.exceeded, false, "no second trip in the same message");
  s = v.state;
  assert.equal(s.cooldown, COOLDOWN_MESSAGES);
});

test("cooldown raises the limit to 2x for COOLDOWN_MESSAGES messages, then back to 1x", () => {
  let s = onAssistantMessageStart(initialThinkingState());
  s = recordThinking(s, 101, 100).state; // trip at 1x
  for (let i = 0; i < COOLDOWN_MESSAGES; i++) {
    s = onAssistantMessageStart(s);
    const v = recordThinking(s, 200, 100);
    assert.equal(v.exceeded, false, `message ${i + 1} after trip allows up to 2x`);
    assert.equal(v.limit, 200);
    s = v.state;
  }
  s = onAssistantMessageStart(s);
  const back = recordThinking(s, 101, 100);
  assert.equal(back.exceeded, true, "1x again after cooldown");
  assert.equal(back.limit, 100);
});

test("a runaway inside cooldown is still cut at 2x and restarts the cooldown", () => {
  let s = onAssistantMessageStart(initialThinkingState());
  s = recordThinking(s, 101, 100).state; // trip
  s = onAssistantMessageStart(s);
  const v = recordThinking(s, 201, 100);
  assert.equal(v.exceeded, true);
  assert.equal(v.limit, 200);
  assert.equal(v.state.cooldown, COOLDOWN_MESSAGES);
});

test("count resets per message; unlimited budget never trips", () => {
  let s = onAssistantMessageStart(initialThinkingState());
  s = recordThinking(s, 3000, 4000).state;
  s = onAssistantMessageStart(s);
  assert.equal(s.chars, 0);
  assert.equal(recordThinking(s, 3000, 4000).exceeded, false);
  assert.equal(recordThinking(s, 1_000_000, null).exceeded, false);
});

test("fix message names the rule and the action, and stays short", () => {
  const m = overexpansionFix(8123, 8000, "medium");
  assert.match(m, /Rule: thinking-budget/);
  assert.match(m, /8000 chars \(medium\)/);
  assert.match(m, /ONE hypothesis/);
  assert.ok(m.length < 300, `fix message is ${m.length} chars`);
});
