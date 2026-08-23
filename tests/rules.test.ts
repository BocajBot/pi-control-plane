import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addRule,
  emptyRules,
  matchRule,
  removeRule,
  renderRulesList,
  restoreRulesFromEntries,
  validateRules,
} from "../src/control-plane/rules.ts";
import { RULES_ENTRY_TYPE } from "../src/control-plane/types.ts";

const NOW = "2026-08-23T00:00:00.000Z";

test("addRule adds, returns the rule, and de-duplicates by (tool,target,scope)", () => {
  const a = addRule(emptyRules(NOW), { tool: "edit", target: "/p/f.ts", scopeRoot: "/p" }, NOW);
  assert.ok(a.rule);
  assert.equal(a.state.rules.length, 1);
  const b = addRule(a.state, { tool: "edit", target: "/p/f.ts", scopeRoot: "/p" }, NOW);
  assert.equal(b.duplicate, true);
  assert.equal(b.state.rules.length, 1, "same tool+target+scope is not duplicated");
});

test("matchRule requires exact tool, target, and scope", () => {
  const s = addRule(emptyRules(NOW), { tool: "edit", target: "/p/f.ts", scopeRoot: "/p" }, NOW).state;
  assert.ok(matchRule(s, "edit", "/p/f.ts", "/p"));
  assert.equal(matchRule(s, "write", "/p/f.ts", "/p"), null, "different tool does not match");
  assert.equal(matchRule(s, "edit", "/p/other.ts", "/p"), null, "different target does not match");
  assert.equal(matchRule(s, "edit", "/p/f.ts", "/other"), null, "different scope does not match");
});

test("removeRule removes by id and leaves the rest", () => {
  let s = addRule(emptyRules(NOW), { tool: "edit", target: "/p/a", scopeRoot: "/p" }, NOW).state;
  const added = addRule(s, { tool: "edit", target: "/p/b", scopeRoot: "/p" }, NOW);
  s = added.state;
  const removed = removeRule(s, added.rule!.id, NOW);
  assert.ok(removed.removed);
  assert.equal(removed.state.rules.length, 1);
  assert.equal(removeRule(s, "nope", NOW).removed, null);
});

test("restore takes the newest valid entry and ignores malformed ones", () => {
  const good = addRule(emptyRules(NOW), { tool: "edit", target: "/p/f", scopeRoot: "/p" }, NOW).state;
  const entries = [
    { type: "custom", customType: RULES_ENTRY_TYPE, data: { schemaVersion: 1, rules: [], updatedAt: NOW } },
    { type: "custom", customType: RULES_ENTRY_TYPE, data: { garbage: true } },
    { type: "custom", customType: RULES_ENTRY_TYPE, data: good },
  ];
  const r = restoreRulesFromEntries(entries, RULES_ENTRY_TYPE, NOW);
  assert.equal(r.restored, true);
  assert.equal(r.rules.rules.length, 1);
  assert.equal(r.ignoredMalformed, 0, "the newest valid entry wins before any malformed one is reached");
});

test("validateRules rejects a malformed rule set", () => {
  assert.equal(validateRules({ schemaVersion: 1, rules: [{ tool: "edit" }], updatedAt: NOW }), null);
  assert.equal(validateRules({ schemaVersion: 2, rules: [], updatedAt: NOW }), null);
  assert.ok(validateRules({ schemaVersion: 1, rules: [], updatedAt: NOW }));
});

test("renderRulesList is legible and handles the empty case", () => {
  assert.deepEqual(renderRulesList(emptyRules(NOW)), ["No remembered rules."]);
  const s = addRule(emptyRules(NOW), { tool: "edit", target: "/p/f", scopeRoot: "/p" }, NOW).state;
  const lines = renderRulesList(s);
  assert.match(lines[0], /1 remembered rule/);
  assert.match(lines[1], /allow edit\s+\/p\/f/);
});
