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

test("validateProfiles handles defaultProfile", () => {
  const withDefault = { ...validConfig, defaultProfile: "minimal" };
  assert.equal(validateProfiles(withDefault)?.defaultProfile, "minimal");
  assert.equal(validateProfiles({ ...validConfig, defaultProfile: "all" })?.defaultProfile, "all");
  assert.equal(validateProfiles(validConfig)?.defaultProfile, null, "absent -> null");
  assert.equal(
    validateProfiles({ ...validConfig, defaultProfile: "nope" }),
    null,
    "default must reference an existing profile",
  );
  assert.equal(validateProfiles({ ...validConfig, defaultProfile: 3 }), null);
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

test("profile picker layout: 1/5 left column, two right rows, selection marker", async () => {
  const { renderProfilePicker } = await import("../src/control-plane/ui.ts");
  const items = [
    { name: "all", description: "Every tool enabled (built-in).", tools: ["a", "b"], active: false, isDefault: false },
    { name: "minimal", description: "Core coding tools only", tools: ["read", "bash"], active: true, isDefault: true },
  ];
  const width = 82;
  const lines = renderProfilePicker(items, 1, width);
  const inner = width - 2;
  const leftWidth = Math.floor(inner / 5);
  // Rectangular: every line equal length.
  assert.ok(lines.every((l) => l.length === lines[0].length), "all lines equal width");
  // Column split at 1/5: body rows have the divider at leftWidth+1.
  const bodyRow = lines[3];
  assert.equal(bodyRow[0], "│");
  assert.equal(bodyRow[leftWidth + 1], "│", "left column is 1/5 of the modal");
  // Separator between description row and tools row on the right side (body
  // lines only — skip the top/bottom borders and header separator).
  const bodyLines = lines.slice(3, -1);
  assert.ok(
    bodyLines.some((l) => /─{10,}/.test(l.slice(leftWidth + 2))),
    "right side has a row separator between description and tools",
  );
  // Selection marker and active star in the left column.
  assert.ok(lines.some((l) => l.includes("> *minimal") || l.includes(">*minimal") || l.includes("> *min")));
  // Default profile is labeled in the left column and explained when selected.
  assert.ok(lines.join("\n").includes("minimal (def"), "default marker shown (possibly truncated)");
  assert.ok(lines.join("\n").includes("Default profile"), "default explanation in description row");
  // Title advertises both actions.
  assert.ok(lines[1].includes("enter apply (session)"));
  assert.ok(lines[1].includes("space set default"));
  // Right side shows description then tools of the SELECTED item.
  const joined = lines.join("\n");
  assert.ok(joined.includes("Core coding tools only"));
  assert.ok(joined.includes("Tools (2)"));
  assert.ok(joined.includes("bash, read") || joined.includes("read, bash"));
  assert.ok(!joined.includes("Every tool enabled"), "unselected item's description not shown");
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
