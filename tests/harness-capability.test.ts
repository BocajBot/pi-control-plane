/**
 * Capability authority: spec section 32's "registered tools are catalog
 * entries, not automatically active capabilities", plus invariants TO1-TO5.
 *
 * Written as refusals wherever the rule is a refusal. A capability test that
 * only checks that the right tools are active passes just as happily against
 * a function that activates everything.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import {
  buildCatalog,
  classifyTool,
  defaultActiveTools,
  describeCatalog,
  describeConfinement,
  grantException,
  HARNESS_TOOLS,
  NEVER_ACTIVE,
  SCOPE_AWARE_BUILTINS,
} from "../src/harness/capability.ts";
import type { Actor, CapabilityException } from "../src/harness/types.ts";

const AT = "2026-08-21T00:00:00.000Z";
const clock = () => new Date(AT);

function registered(...names: string[]) {
  return names.map((name) => ({ name, description: `${name} tool` }));
}

function exceptions(...granted: string[]): Map<string, CapabilityException> {
  const map = new Map<string, CapabilityException>();
  for (const tool of granted) {
    map.set(tool, { tool, grantedBy: "user", grantedAt: AT, reason: "needed for this task" });
  }
  return map;
}

test("TO1: an opaque external tool is catalogued but not active", () => {
  const tools = registered("read", "write", "mystery_tool");
  const active = defaultActiveTools(tools, new Map());
  assert.ok(!active.includes("mystery_tool"), "an unclassified tool must not be active by default");
  const catalog = buildCatalog(tools, new Map());
  const entry = catalog.find((c) => c.name === "mystery_tool");
  assert.ok(entry, "it must still appear in the catalog - existence and exposure are different answers");
  assert.equal(entry.confinement, "unconfined");
  assert.equal(entry.active, false);
});

test("section 32: an unconfined tool is labelled unconfined, never sandboxed", () => {
  assert.match(describeConfinement("mystery_tool", new Map()), /unconfined/);
  assert.match(describeConfinement("mystery_tool", exceptions("mystery_tool")), /unconfined/);
  assert.equal(describeConfinement("read", new Map()), "scope-aware");
  assert.equal(describeConfinement("pi_harness_bash", new Map()), "harness");
});

test("section 32: a per-session user exception is what activates an unconfined tool", () => {
  const tools = registered("read", "mystery_tool");
  assert.ok(!defaultActiveTools(tools, new Map()).includes("mystery_tool"));
  assert.ok(defaultActiveTools(tools, exceptions("mystery_tool")).includes("mystery_tool"));
});

test("A2: no actor except the user may grant a capability exception", () => {
  for (const actor of ["core", "coordinator", "advisor", "subagent", "reviewer"] as Actor[]) {
    const outcome = grantException("mystery_tool", actor, "I need it", clock);
    assert.equal(outcome.ok, false, `${actor} must not self-grant`);
    if (!outcome.ok) assert.match(outcome.rule, /A2/);
  }
  const granted = grantException("mystery_tool", "user", "I need it", clock);
  assert.equal(granted.ok, true);
});

test("section 9: the builtin shell cannot be reached through a capability exception", () => {
  const outcome = grantException("bash", "user", "just this once", clock);
  assert.equal(outcome.ok, false, "the shell boundary is not a capability toggle");
  if (!outcome.ok) assert.match(outcome.rule, /section 9/);
  // And it stays out of the active set even if an exception were somehow present.
  const tools = registered("bash", "read");
  assert.ok(!defaultActiveTools(tools, exceptions("bash")).includes("bash"));
});

test("a grant with no stated reason is refused", () => {
  const outcome = grantException("mystery_tool", "user", "   ", clock);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.rule, /meta-invariant/);
});

test("granting an already-confined tool is refused rather than silently succeeding", () => {
  const outcome = grantException("read", "user", "why not", clock);
  assert.equal(outcome.ok, false, "a no-op grant would appear in the audit log as a decision the user made");
  if (!outcome.ok) assert.match(outcome.rule, /TO1/);
});

test("the active set is computed from the catalog, not filtered from what is already on", () => {
  // An extension that activated its own opaque tool at load time must not
  // thereby grant itself the exception the rule exists to require.
  const tools = registered("read", "write", "other_extension_tool");
  const active = defaultActiveTools(tools, new Map());
  assert.deepEqual(active, ["read", "write"]);
});

test("classification: builtins, harness tools, and everything else", () => {
  for (const name of SCOPE_AWARE_BUILTINS) assert.equal(classifyTool(name), "scope-aware", name);
  for (const name of HARNESS_TOOLS) assert.equal(classifyTool(name), "harness", name);
  assert.equal(classifyTool("bash"), "unconfined", "the shell is not scope-aware; it has no resolvable target");
  assert.equal(classifyTool("anything_new"), "unconfined", "unknown means unconfined, never a default of trusted");
  assert.ok(NEVER_ACTIVE.includes("bash"));
});

test("the catalog renders both what exists and what is usable", () => {
  const rendered = describeCatalog(buildCatalog(registered("read", "mystery_tool"), exceptions("mystery_tool")));
  assert.match(rendered, /read {2}\[scope-aware, active\]/);
  assert.match(rendered, /mystery_tool {2}\[unconfined, active\] - exception: needed for this task/);
  assert.equal(describeCatalog([]), "(no tools registered)");
});

test("every tool the extension registers is declared in HARNESS_TOOLS", () => {
  // The failure mode this guards is real: harness_set_posture was registered
  // and not declared, which classifies it unconfined - so the coordinator's
  // own posture tool would have been withheld from the coordinator until a
  // user granted an exception for it. The list is deliberately hand-written
  // (an unlisted tool must not appear), so the drift needs a check of its own.
  // The entry lives at extensions/pi-harness.ts in this repository and at
  // src/index.ts in the isolated package (ARCHITECTURE2.md section 29). The
  // guard has to hold in both, so it locates the file rather than assuming.
  const candidates = ["../extensions/pi-harness.ts", "../src/index.ts"];
  const found = candidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  assert.ok(found, `extension entry not found; looked for ${candidates.join(", ")}`);
  const source = fs.readFileSync(found, "utf8");
  const registered = [...source.matchAll(/name: "((?:pi_)?harness[a-z_]*)"/g)].map((m) => m[1]);
  assert.ok(registered.length > 0, "the scan must actually find tool registrations");
  for (const name of new Set(registered)) {
    assert.ok(HARNESS_TOOLS.includes(name), `${name} is registered but not declared in HARNESS_TOOLS`);
  }
});
