import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import {
  applyProfile,
  clearToolToggles,
  currentProfileName,
  validateProfiles,
} from "../src/control-plane/profiles.ts";

const validConfig = {
  schemaVersion: 1,
  profiles: {
    minimal: { description: "core", tools: ["read", "bash", "edit", "write"] },
    reading: { description: "reads", tools: ["read", "grep"] },
  },
};

test("validateProfiles accepts the shipped file and the valid shape", () => {
  const shipped = JSON.parse(
    fs.readFileSync(new URL("../policy/profiles.json", import.meta.url), "utf8"),
  );
  assert.notEqual(validateProfiles(shipped), null, "shipped policy/profiles.json must validate");
  assert.notEqual(validateProfiles(validConfig), null);
});

test("validateProfiles rejects malformed shapes and the reserved name", () => {
  assert.equal(validateProfiles(null), null);
  assert.equal(validateProfiles({ schemaVersion: 2, profiles: {} }), null);
  assert.equal(validateProfiles({ schemaVersion: 1, profiles: { x: { description: "d" } } }), null);
  assert.equal(
    validateProfiles({ schemaVersion: 1, profiles: { x: { description: "d", tools: [""] } } }),
    null,
  );
  assert.equal(
    validateProfiles({ schemaVersion: 1, profiles: { x: { description: "d", tools: [], extra: 1 } } }),
    null,
  );
  assert.equal(
    validateProfiles({ schemaVersion: 1, profiles: { all: { description: "d", tools: [] } } }),
    null,
    "'all' is reserved",
  );
});

test("applyProfile disables unlisted tools, keeps non-tool toggles, reports missing", () => {
  const allTools = ["read", "bash", "edit", "write", "web_search", "mcp"];
  const current = { "skill:foo": false, "tool:mcp": false };
  const result = applyProfile(["read", "bash", "nonexistent_tool"], allTools, current);
  assert.deepEqual(result.enabled, ["bash", "read"]);
  assert.deepEqual(result.disabled, ["edit", "mcp", "web_search", "write"]);
  assert.deepEqual(result.missing, ["nonexistent_tool"]);
  assert.equal(result.toggles["skill:foo"], false, "non-tool toggles preserved");
  assert.equal(result.toggles["tool:web_search"], false);
  assert.equal(result.toggles["tool:read"], undefined, "enabled tools have no toggle entry");
});

test("clearToolToggles removes only tool toggles", () => {
  const cleared = clearToolToggles({ "tool:bash": false, "skill:foo": false });
  assert.deepEqual(cleared, { "skill:foo": false });
});

test("currentProfileName matches all, named profiles, and custom states", () => {
  const allTools = ["read", "bash", "edit", "write", "grep"];
  const config = validateProfiles(validConfig)!;
  assert.equal(currentProfileName(config, allTools, {}), "all");
  const applied = applyProfile(config.profiles.minimal.tools, allTools, {});
  assert.equal(currentProfileName(config, allTools, applied.toggles), "minimal");
  assert.equal(currentProfileName(config, allTools, { "tool:read": false }), null);
  assert.equal(currentProfileName(null, allTools, { "tool:read": false }), null);
});
