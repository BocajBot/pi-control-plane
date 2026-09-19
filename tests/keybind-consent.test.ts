/** Pure tests for the consent-gated keybind logic (no pi-tui / no pi). */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  agentConfigDir,
  applyUnbinds,
  canonicalizeKeyId,
  consentDrift,
  effectiveBindings,
  expectedUnboundActions,
  findOccupantActions,
  type KeybindConsent,
  planUnbinds,
  readConsent,
  readKeybindingsConfig,
  RESERVED_ACTIONS,
  validateRecordedKey,
  writeConsent,
  writeKeybindingsConfig,
} from "../src/control-plane/keybind-consent.ts";

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kb-consent-")));
}

test("canonicalizeKeyId normalizes case and aliases into pi key ids", () => {
  assert.equal(canonicalizeKeyId("  CTRL+Shift+M "), "ctrl+shift+m");
  assert.equal(canonicalizeKeyId("esc"), "escape");
  assert.equal(canonicalizeKeyId("return"), "enter");
  assert.equal(canonicalizeKeyId("f12"), "f12");
  assert.equal(canonicalizeKeyId("ctrl+1"), "ctrl+1");
  assert.equal(canonicalizeKeyId("super+k"), "super+k");
  for (const bad of ["", "ctrl+", "ctrl+ctrl+a", "hyper+a", "ctrl+foo", "ctrl+f13", "f13"]) {
    assert.equal(canonicalizeKeyId(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("validateRecordedKey requires a real modifier (or f-key) and refuses editor keys", () => {
  for (const key of ["ctrl+shift+m", "alt+enter", "ctrl+alt+]".replace("]", "]"), "f2", "super+k"]) {
    assert.ok(validateRecordedKey(key).ok, `expected ok for ${key}`);
  }
  const shiftTab = validateRecordedKey("shift+tab");
  assert.ok(!shiftTab.ok && /Claude-style preset/.test(shiftTab.reason), "shift+tab points at the preset");
  for (const key of ["a", "shift+a", "tab", "escape", "enter", "space", "up", "pageup", "shift+space"]) {
    const check = validateRecordedKey(key);
    assert.ok(!check.ok && /ctrl, alt or super/.test(check.reason), `expected refusal for ${key}`);
  }
  const garbage = validateRecordedKey("crtl+a");
  assert.ok(!garbage.ok && /not a recognizable key combo/.test(garbage.reason));
});

test("findOccupantActions is case-insensitive, alias-aware, and reads string or array bindings", () => {
  const resolved = {
    "app.thinking.cycle": ["shift+tab"],
    "tui.select.cancel": ["escape", "ctrl+c"],
    "app.session.toggleSort": "ctrl+s",
  };
  assert.deepEqual(findOccupantActions("SHIFT+TAB", resolved), ["app.thinking.cycle"]);
  assert.deepEqual(findOccupantActions("esc", resolved), ["tui.select.cancel"]);
  assert.deepEqual(findOccupantActions("ctrl+s", resolved), ["app.session.toggleSort"]);
  assert.deepEqual(findOccupantActions("ctrl+shift+m", resolved), []);
});

test("planUnbinds only unbinds pi-reserved actions", () => {
  assert.deepEqual(planUnbinds(["app.thinking.cycle", "some.custom.action", "app.thinking.toggle"]), [
    "app.thinking.cycle",
    "app.thinking.toggle",
  ]);
  assert.deepEqual(planUnbinds([]), []);
  // The reserved list is the full pi guard list; sanity-spot a few members.
  for (const action of ["app.interrupt", "app.exit", "tui.input.submit", "app.model.select"]) {
    assert.ok(RESERVED_ACTIONS.includes(action));
  }
});

test("effectiveBindings overlays the user file on the reserved defaults", () => {
  const resolved = effectiveBindings({ "app.thinking.cycle": [], "custom.action": ["ctrl+9"] });
  assert.deepEqual(resolved["app.thinking.cycle"], []);
  assert.deepEqual(resolved["custom.action"], ["ctrl+9"]);
  assert.deepEqual(resolved["app.interrupt"], ["escape"]);
  assert.deepEqual(effectiveBindings(null)["app.thinking.cycle"], ["shift+tab"]);
});

test("applyUnbinds preserves unrelated keys and tolerates absent/malformed base config", () => {
  const merged = applyUnbinds({ "app.exit": "ctrl+d", "app.thinking.cycle": "shift+tab" }, ["app.thinking.cycle"]);
  assert.deepEqual(merged, { "app.exit": "ctrl+d", "app.thinking.cycle": [] });
  assert.deepEqual(applyUnbinds(undefined, ["app.interrupt"]), { "app.interrupt": [] });
  assert.deepEqual(applyUnbinds(["not", "an", "object"], ["app.interrupt"]), { "app.interrupt": [] });
  assert.deepEqual(applyUnbinds(null, []), {});
});

const claudeConsent = (extra: Partial<KeybindConsent> = {}): KeybindConsent => ({
  version: 1,
  decision: "claude",
  decidedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

test("consentDrift detects re-bound actions and absent files, never for keep-pi-defaults", () => {
  assert.deepEqual(consentDrift(claudeConsent({ unboundActions: ["app.thinking.cycle"] }), { "app.thinking.cycle": [] }), []);
  assert.deepEqual(consentDrift(claudeConsent({ unboundActions: ["app.thinking.cycle"] }), {}), ["app.thinking.cycle"]);
  assert.deepEqual(
    consentDrift(claudeConsent({ unboundActions: ["app.thinking.cycle"] }), { "app.thinking.cycle": "shift+tab" }),
    ["app.thinking.cycle"],
  );
  assert.deepEqual(consentDrift(claudeConsent(), {}), ["app.thinking.cycle"], "missing unboundActions falls back to the preset action");
  const custom: KeybindConsent = { version: 1, decision: "custom", customKey: "ctrl+t", unboundActions: ["app.thinking.toggle"], decidedAt: "x" };
  assert.deepEqual(consentDrift(custom, { "app.thinking.toggle": [] }), []);
  assert.deepEqual(consentDrift(custom, { "app.thinking.toggle": ["ctrl+t"] }), ["app.thinking.toggle"]);
  assert.deepEqual(consentDrift({ version: 1, decision: "keep-pi-defaults", decidedAt: "x" }, {}), []);
  assert.deepEqual(expectedUnboundActions({ version: 1, decision: "custom", customKey: "ctrl+shift+m", decidedAt: "x" }), []);
});

test("consent file round-trips, reports malformed state, and fails closed on write errors", () => {
  const dir = tmpDir();
  assert.deepEqual(readConsent(dir), { consent: null, malformed: false }, "missing file is not malformed");
  assert.ok(writeConsent(dir, claudeConsent()) === null);
  const read = readConsent(dir);
  assert.equal(read.consent?.decision, "claude");
  assert.equal(read.malformed, false);
  fs.writeFileSync(path.join(dir, "control-plane-keys.json"), "{broken");
  assert.deepEqual(readConsent(dir), { consent: null, malformed: true });
  fs.writeFileSync(path.join(dir, "control-plane-keys.json"), JSON.stringify({ decision: "nope" }));
  assert.equal(readConsent(dir).malformed, true);
  // A file where a directory is expected makes mkdir/write fail without throwing.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  assert.ok(typeof writeConsent(blocker, claudeConsent()) === "string");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("keybindings.json IO: missing vs malformed vs valid, atomic merge write", () => {
  const dir = tmpDir();
  assert.deepEqual(readKeybindingsConfig(dir), { config: undefined, exists: false, malformed: false });
  fs.writeFileSync(path.join(dir, "keybindings.json"), "{broken");
  assert.deepEqual(readKeybindingsConfig(dir), { config: undefined, exists: true, malformed: true });
  fs.writeFileSync(path.join(dir, "keybindings.json"), JSON.stringify(["array"]));
  assert.equal(readKeybindingsConfig(dir).malformed, true);
  fs.writeFileSync(path.join(dir, "keybindings.json"), JSON.stringify({ theme: "keep" }));
  const read = readKeybindingsConfig(dir);
  assert.equal(read.malformed, false);
  assert.ok(writeKeybindingsConfig(dir, applyUnbinds(read.config, ["app.thinking.cycle"])) === null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "keybindings.json"), "utf8")), {
    theme: "keep",
    "app.thinking.cycle": [],
  });
  // A file blocking the target directory fails mkdir without throwing.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  assert.ok(typeof writeKeybindingsConfig(path.join(blocker, "nested"), {}) === "string", "writing over a file fails closed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("agentConfigDir honors PI_CODING_AGENT_DIR", () => {
  assert.equal(agentConfigDir({ PI_CODING_AGENT_DIR: "/tmp/custom-agent" }), "/tmp/custom-agent");
  assert.match(agentConfigDir({}), /\.pi[/\\]agent$/);
});
