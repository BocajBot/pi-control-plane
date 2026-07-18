import assert from "node:assert/strict";
import { test } from "node:test";
import { diffIsEmpty, diffSnapshots } from "../src/control-plane/context-diff.ts";
import { buildSnapshot, sha256, type SnapshotInputs } from "../src/control-plane/context-snapshot.ts";
import { redactSecrets } from "../src/control-plane/redaction.ts";
import type { SnapshotItem } from "../src/control-plane/types.ts";

function baseInputs(overrides: Partial<SnapshotInputs> = {}): SnapshotInputs {
  return {
    timestamp: "2026-07-18T12:00:00.000Z",
    provider: "llama-swap",
    model: "qwen3-coder-30b-a3b-q4",
    contextWindow: 49152,
    tokens: 10000,
    percent: 20.3,
    messageCount: 12,
    messagesByRole: { user: 5, assistant: 5, toolResult: 2 },
    sources: [
      { name: "file:/p/AGENTS.md", kind: "context-file", detail: "/p/AGENTS.md", enabled: true, toggleable: true },
      { name: "skill:triage", kind: "skill", detail: "triage skill", enabled: true, toggleable: true },
    ],
    tools: ["read", "bash", "edit"],
    redactedSystemPrompt: "You are pi. [REDACTED:env-secret]",
    providerPayload: { length: 100, hash: "abc" },
    phase: "discuss",
    autonomy: "read-only",
    hasAcceptedTask: false,
    ...overrides,
  };
}

test("normalization is stable: input order does not change the snapshot", () => {
  const a = buildSnapshot(baseInputs());
  const b = buildSnapshot(
    baseInputs({
      sources: [...baseInputs().sources].reverse(),
      tools: ["edit", "read", "bash"],
      messagesByRole: { toolResult: 2, assistant: 5, user: 5 },
    }),
  );
  assert.deepEqual(a, b);
});

test("hashing is stable and derived from the redacted prompt", () => {
  const snapshot = buildSnapshot(baseInputs());
  assert.equal(snapshot.systemPromptHash, sha256("You are pi. [REDACTED:env-secret]"));
  assert.equal(snapshot.systemPromptLength, "You are pi. [REDACTED:env-secret]".length);
  const again = buildSnapshot(baseInputs());
  assert.equal(snapshot.systemPromptHash, again.systemPromptHash);
});

test("snapshots never carry raw secrets when built from redacted inputs", () => {
  const secret = "sk-ant-VERYFAKESECRET0000000";
  const redacted = redactSecrets(`system prompt containing ${secret}`).text;
  const snapshot = buildSnapshot(baseInputs({ redactedSystemPrompt: redacted }));
  assert.ok(!JSON.stringify(snapshot).includes(secret));
});

test("unavailable values stay null, never invented", () => {
  const snapshot = buildSnapshot(
    baseInputs({ tokens: null, percent: null, redactedSystemPrompt: null, providerPayload: null }),
  );
  assert.equal(snapshot.tokens, null);
  assert.equal(snapshot.percent, null);
  assert.equal(snapshot.systemPromptHash, null);
  assert.equal(snapshot.providerPayloadHash, null);
});

test("diff detects added/removed/changed sources, tool changes, and skill changes", () => {
  const before = buildSnapshot(baseInputs());
  const afterSources: SnapshotItem[] = [
    { name: "file:/p/AGENTS.md", kind: "context-file", detail: "/p/AGENTS.md", enabled: false, toggleable: true }, // changed
    { name: "skill:new-skill", kind: "skill", detail: "added", enabled: true, toggleable: true }, // added, skill
  ];
  const after = buildSnapshot(
    baseInputs({ sources: afterSources, tools: ["read", "write"], timestamp: "2026-07-18T13:00:00.000Z" }),
  );
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.addedSources, ["skill:new-skill"]);
  assert.deepEqual(diff.removedSources, ["skill:triage"]);
  assert.deepEqual(diff.changedSources, ["file:/p/AGENTS.md"]);
  assert.deepEqual(diff.addedTools, ["write"]);
  assert.deepEqual(diff.removedTools.sort(), ["bash", "edit"]);
  assert.deepEqual(diff.addedSkills, ["skill:new-skill"]);
  assert.deepEqual(diff.removedSkills, ["skill:triage"]);
});

test("diff reports token and message deltas and hash changes", () => {
  const before = buildSnapshot(baseInputs());
  const after = buildSnapshot(
    baseInputs({
      tokens: 12500,
      messageCount: 15,
      redactedSystemPrompt: "You are pi. Something changed.",
      providerPayload: { length: 120, hash: "def" },
      timestamp: "2026-07-18T13:00:00.000Z",
    }),
  );
  const diff = diffSnapshots(before, after);
  assert.equal(diff.tokenDelta, 2500);
  assert.equal(diff.messageCountDelta, 3);
  assert.equal(diff.systemPromptHashChanged, true);
  assert.equal(diff.providerPayloadHashChanged, true);
});

test("diff of identical snapshots is empty; model/provider changes are reported", () => {
  const a = buildSnapshot(baseInputs());
  const b = buildSnapshot(baseInputs());
  assert.equal(diffIsEmpty(diffSnapshots(a, b)), true);
  const c = buildSnapshot(baseInputs({ model: "devstral-small-2-24b", provider: "other" }));
  const diff = diffSnapshots(a, c);
  assert.deepEqual(diff.modelChange, { from: "qwen3-coder-30b-a3b-q4", to: "devstral-small-2-24b" });
  assert.deepEqual(diff.providerChange, { from: "llama-swap", to: "other" });
});

test("deterministic ordering: diff lists are sorted", () => {
  const before = buildSnapshot(baseInputs({ sources: [] }));
  const after = buildSnapshot(
    baseInputs({
      sources: [
        { name: "skill:zeta", kind: "skill", enabled: true, toggleable: true },
        { name: "skill:alpha", kind: "skill", enabled: true, toggleable: true },
      ],
    }),
  );
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.addedSources, ["skill:alpha", "skill:zeta"]);
});
