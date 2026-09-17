/**
 * Unit tests for the pure model-picker logic (src/control-plane/model-picker.ts):
 * frecency ordering, usage IO, filtering, page-jump math, key classification,
 * settings opt-out, and /models argument resolution. No pi-tui, no real disk.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyKey,
  filterModels,
  frecency,
  keyOf,
  loadUsage,
  modelPriceLabel,
  pageStep,
  pickerDisabled,
  recordUse,
  resolveModelArgument,
  saveUsage,
  sortModels,
  type Usage,
  type UsageFs,
} from "../src/control-plane/model-picker.ts";

const DAY = 86_400_000;

function memoryFs(files: Record<string, string>): UsageFs & { files: Record<string, string> } {
  const store = { ...files };
  return {
    files: store,
    readUtf8(p: string) {
      if (!(p in store)) throw new Error("ENOENT");
      return store[p];
    },
    writeUtf8(p: string, data: string) {
      store[p] = data;
      return undefined;
    },
    rename(from: string, to: string) {
      store[to] = store[from];
      delete store[from];
      return undefined;
    },
  };
}

const models = [
  { provider: "llama-swap", id: "alpha" },
  { provider: "llama-swap", id: "beta" },
  { provider: "openrouter", id: "gamma" },
];

test("frecency: count decayed by recency, unused scores zero", () => {
  const now = 10 * DAY;
  assert.equal(frecency(undefined, now), 0);
  assert.equal(frecency({ count: 4, lastUsed: now }, now), 4);
  // 7 days at half-life 7d: exactly half.
  assert.equal(frecency({ count: 4, lastUsed: now - 7 * DAY }, now), 2);
  // Recent light use beats old heavy use.
  assert.ok(frecency({ count: 1, lastUsed: now }, now) > frecency({ count: 10, lastUsed: now - 30 * DAY }, now));
});

test("sortModels: frecency desc, then local provider, then name", () => {
  const now = 10 * DAY;
  const usage: Usage = {
    "openrouter/gamma": { count: 5, lastUsed: now },
  };
  const sorted = sortModels(models, usage, "llama-swap", now);
  assert.deepEqual(
    sorted.map((m) => keyOf(m.provider, m.id)),
    ["openrouter/gamma", "llama-swap/alpha", "llama-swap/beta"],
  );
  // Cold history: local provider leads, then name order.
  const cold = sortModels(models, {}, "llama-swap", now);
  assert.deepEqual(
    cold.map((m) => keyOf(m.provider, m.id)),
    ["llama-swap/alpha", "llama-swap/beta", "openrouter/gamma"],
  );
});

test("usage IO: record, round-trip, atomic save, tolerant load", () => {
  const fs = memoryFs({ "/usage.json": JSON.stringify({ "a/b": { count: 1, lastUsed: 5 } }) });
  let usage = loadUsage(fs, "/usage.json");
  usage = recordUse(usage, "a", "b", 10);
  usage = recordUse(usage, "c", "d", 11);
  saveUsage(fs, "/usage.json", usage);
  const reloaded = loadUsage(fs, "/usage.json");
  assert.deepEqual(reloaded["a/b"], { count: 2, lastUsed: 10 });
  assert.deepEqual(reloaded["c/d"], { count: 1, lastUsed: 11 });
  // Tmp file is renamed away.
  assert.equal("/usage.json.tmp" in fs.files, false);
  // Malformed or missing files load as empty history, never throw.
  const broken = memoryFs({ "/usage.json": "{not json" });
  assert.deepEqual(loadUsage(broken, "/usage.json"), {});
  const missing = memoryFs({});
  assert.deepEqual(loadUsage(missing, "/usage.json"), {});
  // Entries with wrong shapes are dropped, valid ones kept.
  const junk = memoryFs({
    "/usage.json": JSON.stringify({
      ok: { count: 1, lastUsed: 2 },
      bad: "nope",
      worse: { count: "x", lastUsed: 2 },
    }),
  });
  const loaded = loadUsage(junk, "/usage.json");
  assert.deepEqual(Object.keys(loaded), ["ok"]);
});

test("filterModels: substring, case-insensitive, empty query keeps all", () => {
  assert.equal(filterModels(models, "").length, 3);
  assert.deepEqual(
    filterModels(models, "llama-swap/al").map((m) => m.id),
    ["alpha"],
  );
  assert.deepEqual(filterModels(models, "GAMMA").map((m) => m.id), ["gamma"]);
  assert.equal(filterModels(models, "nothing").length, 0);
});

test("pageStep: jumps a page, clamps at both ends", () => {
  assert.equal(pageStep(0, -1, 50), 0);
  assert.equal(pageStep(0, 1, 50), 15);
  assert.equal(pageStep(14, 1, 50), 29);
  assert.equal(pageStep(48, 1, 50), 49);
  assert.equal(pageStep(49, 1, 50), 49);
  assert.equal(pageStep(3, 1, 0), 0);
});

test("modelPriceLabel: shows OpenRouter input/output rates and tier marker", () => {
  assert.equal(
    modelPriceLabel({
      provider: "openrouter",
      id: "priced",
      cost: { input: 0.12345, output: 12.345, tiers: [{}] },
    }),
    "$0.123/$12.3+ per Mtok",
  );
  assert.equal(
    modelPriceLabel({ provider: "openrouter", id: "free", cost: { input: 0, output: 0 } }),
    "$0/$0 per Mtok",
  );
  assert.equal(modelPriceLabel({ provider: "llama-swap", id: "local", cost: { input: 0, output: 0 } }), null);
  assert.equal(modelPriceLabel({ provider: "openrouter", id: "missing" }), null);
});

test("classifyKey: typeable, backspace, page keys, modifier variants, other", () => {
  assert.deepEqual(classifyKey("a"), { kind: "type", char: "a" });
  assert.deepEqual(classifyKey("Z"), { kind: "type", char: "Z" });
  assert.deepEqual(classifyKey("\x7f"), { kind: "backspace" });
  assert.deepEqual(classifyKey("\b"), { kind: "backspace" });
  assert.deepEqual(classifyKey("\x1b[5~"), { kind: "page-up" });
  assert.deepEqual(classifyKey("\x1b[6~"), { kind: "page-down" });
  assert.deepEqual(classifyKey("\x1b[5;5~"), { kind: "page-up" }); // ctrl-modified
  assert.deepEqual(classifyKey("\x1b[6;2~"), { kind: "page-down" }); // shift-modified
  assert.deepEqual(classifyKey("\x1b[A"), { kind: "other", data: "\x1b[A" }); // up arrow -> SelectList
  assert.deepEqual(classifyKey("\r"), { kind: "other", data: "\r" }); // enter -> SelectList
  assert.deepEqual(classifyKey("\x1b"), { kind: "other", data: "\x1b" }); // escape -> SelectList
});

test("pickerDisabled: only modelPicker === false disables; junk tolerated", () => {
  const off = memoryFs({ "/s.json": JSON.stringify({ modelPicker: false }) });
  assert.equal(pickerDisabled(off, "/s.json"), true);
  const on = memoryFs({ "/s.json": JSON.stringify({ modelPicker: true }) });
  assert.equal(pickerDisabled(on, "/s.json"), false);
  const absent = memoryFs({ "/s.json": JSON.stringify({}) });
  assert.equal(pickerDisabled(absent, "/s.json"), false);
  const broken = memoryFs({ "/s.json": "{oops" });
  assert.equal(pickerDisabled(broken, "/s.json"), false);
});

test("resolveModelArgument: exact match wins, then substring; empty matches none", () => {
  assert.deepEqual(resolveModelArgument(models, "").length, 0);
  const exact = resolveModelArgument(models, "llama-swap/alpha");
  assert.equal(exact.length, 1);
  // "alpha" is an exact id substring of one model only.
  assert.deepEqual(resolveModelArgument(models, "alpha").map((m) => m.id), ["alpha"]);
  // "a" matches several -> ambiguous, caller must refuse.
  assert.ok(resolveModelArgument(models, "a").length > 1);
  assert.equal(resolveModelArgument(models, "nope").length, 0);
});
