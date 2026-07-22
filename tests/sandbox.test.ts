import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  buildSandboxedCommand,
  describeSandbox,
  emptySandboxState,
  restoreSandboxFromEntries,
  shQuote,
  validateSandboxState,
} from "../src/control-plane/sandbox.ts";
import { SANDBOX_ENTRY_TYPE, SANDBOX_SCHEMA_VERSION } from "../src/control-plane/types.ts";

test("emptySandboxState: disabled, network off, correct schema version", () => {
  const s = emptySandboxState("2026-01-01T00:00:00.000Z");
  assert.equal(s.schemaVersion, SANDBOX_SCHEMA_VERSION);
  assert.equal(s.enabled, false);
  assert.equal(s.network, false);
  assert.equal(s.updatedAt, "2026-01-01T00:00:00.000Z");
});

test("validateSandboxState: accepts a well-formed object", () => {
  const v = validateSandboxState({
    schemaVersion: SANDBOX_SCHEMA_VERSION,
    enabled: true,
    network: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.notEqual(v, null);
  assert.equal(v?.enabled, true);
});

test("validateSandboxState: rejects wrong schema version, missing fields, wrong types, extra keys", () => {
  assert.equal(validateSandboxState(null), null);
  assert.equal(validateSandboxState("nope"), null);
  assert.equal(validateSandboxState([]), null);
  assert.equal(
    validateSandboxState({ schemaVersion: 999, enabled: true, network: false, updatedAt: "x" }),
    null,
  );
  assert.equal(
    validateSandboxState({ schemaVersion: SANDBOX_SCHEMA_VERSION, network: false, updatedAt: "x" }),
    null,
    "missing enabled",
  );
  assert.equal(
    validateSandboxState({ schemaVersion: SANDBOX_SCHEMA_VERSION, enabled: "yes", network: false, updatedAt: "x" }),
    null,
    "enabled must be boolean",
  );
  assert.equal(
    validateSandboxState({
      schemaVersion: SANDBOX_SCHEMA_VERSION,
      enabled: true,
      network: false,
      updatedAt: "x",
      extra: 1,
    }),
    null,
    "unknown keys rejected",
  );
});

test("restoreSandboxFromEntries: empty branch falls back to disabled default", () => {
  const result = restoreSandboxFromEntries([], SANDBOX_ENTRY_TYPE, "2026-01-01T00:00:00.000Z");
  assert.equal(result.restored, false);
  assert.equal(result.sandbox.enabled, false);
  assert.equal(result.ignoredMalformed, 0);
});

test("restoreSandboxFromEntries: takes the newest valid entry, ignores malformed ones walked past on the way, ignores other entry types", () => {
  // Walk order is backward (newest first): the trailing malformed entry is
  // skipped (and counted) before the real pick is reached; an even older
  // valid entry further back is never inspected once the pick is found.
  const entries = [
    { type: "custom", customType: SANDBOX_ENTRY_TYPE, data: { schemaVersion: SANDBOX_SCHEMA_VERSION, enabled: true, network: false, updatedAt: "t1" } },
    { type: "custom", customType: "something-else", data: { enabled: false } },
    { type: "custom", customType: SANDBOX_ENTRY_TYPE, data: { schemaVersion: SANDBOX_SCHEMA_VERSION, enabled: false, network: true, updatedAt: "t2" } },
    { type: "custom", customType: SANDBOX_ENTRY_TYPE, data: { garbage: true } },
  ];
  const result = restoreSandboxFromEntries(entries, SANDBOX_ENTRY_TYPE);
  assert.equal(result.restored, true);
  assert.equal(result.sandbox.enabled, false);
  assert.equal(result.sandbox.network, true);
  assert.equal(result.sandbox.updatedAt, "t2");
  assert.equal(result.ignoredMalformed, 1);
});

test("describeSandbox: empty when disabled, shows network state when enabled", () => {
  assert.equal(describeSandbox(emptySandboxState()), "");
  assert.match(describeSandbox({ schemaVersion: SANDBOX_SCHEMA_VERSION, enabled: true, network: false, updatedAt: "x" }), /net off/);
  assert.match(describeSandbox({ schemaVersion: SANDBOX_SCHEMA_VERSION, enabled: true, network: true, updatedAt: "x" }), /net on/);
});

test("shQuote: round-trips through a real POSIX shell, including embedded single quotes", () => {
  const cases = [
    "hello",
    "it's a test",
    "a 'quoted' word",
    "$(echo pwned)",
    "`echo pwned`",
    "a;b&&c|d>e",
    "line1\nline2",
    "",
    "''",
  ];
  for (const input of cases) {
    const quoted = shQuote(input);
    const out = execFileSync("/bin/sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8" });
    assert.equal(out, input, `shQuote round-trip failed for ${JSON.stringify(input)}`);
  }
});

test("buildSandboxedCommand: network off by default omits --share-net, unshares everything", () => {
  const cmd = buildSandboxedCommand("echo hi", {
    projectRoot: "/home/user/project",
    cwd: "/home/user/project",
    network: false,
    roBindPaths: ["/usr", "/etc"],
    shadowDirs: [],
    shadowFiles: [],
  });
  assert.match(cmd, /--unshare-all/);
  assert.doesNotMatch(cmd, /--share-net/);
  assert.match(cmd, /--die-with-parent/);
});

test("buildSandboxedCommand: network on adds --share-net", () => {
  const cmd = buildSandboxedCommand("echo hi", {
    projectRoot: "/home/user/project",
    cwd: "/home/user/project",
    network: true,
    roBindPaths: [],
    shadowDirs: [],
    shadowFiles: [],
  });
  assert.match(cmd, /--share-net/);
});

test("buildSandboxedCommand: binds project root read-write, system paths read-only, credential paths shadowed", () => {
  const cmd = buildSandboxedCommand("npm test", {
    projectRoot: "/home/user/project",
    cwd: "/home/user/project",
    network: false,
    roBindPaths: ["/usr", "/home/user"],
    shadowDirs: ["/home/user/.ssh", "/home/user/.pi/agent"],
    shadowFiles: ["/home/user/.docker/config.json"],
  });
  assert.match(cmd, /'--bind' '\/home\/user\/project' '\/home\/user\/project'/);
  assert.match(cmd, /'--ro-bind-try' '\/usr' '\/usr'/);
  assert.match(cmd, /'--ro-bind-try' '\/home\/user' '\/home\/user'/);
  assert.match(cmd, /'--tmpfs' '\/home\/user\/\.ssh'/);
  assert.match(cmd, /'--tmpfs' '\/home\/user\/\.pi\/agent'/);
  assert.match(cmd, /'--ro-bind' '\/dev\/null' '\/home\/user\/\.docker\/config\.json'/);
  // Shadowing must come after the read-only home bind so it actually overrides it.
  const homeBindIdx = cmd.indexOf("'--ro-bind-try' '/home/user' '/home/user'");
  const shadowIdx = cmd.indexOf("'--tmpfs' '/home/user/.ssh'");
  assert.ok(homeBindIdx >= 0 && shadowIdx > homeBindIdx, "shadow must be applied after the ro-bind it overrides");
});

test("buildSandboxedCommand: preserves the original command's full shell semantics through the inner sh -c", () => {
  const original = "echo start && (echo 'nested quotes' | grep nested) ; echo $HOME";
  const cmd = buildSandboxedCommand(original, {
    projectRoot: "/tmp/proj",
    cwd: "/tmp/proj",
    network: false,
    roBindPaths: [],
    shadowDirs: [],
    shadowFiles: [],
  });
  assert.match(cmd, /'--' '\/bin\/sh' '-c' /);
  // Extract the final shQuote'd argument and confirm it decodes back exactly.
  const marker = "'--' '/bin/sh' '-c' ";
  const tail = cmd.slice(cmd.indexOf(marker) + marker.length);
  const out = execFileSync("/bin/sh", ["-c", `printf '%s' ${tail}`], { encoding: "utf8" });
  assert.equal(out, original);
});

test("buildSandboxedCommand: --chdir uses cwd, not projectRoot, when they differ", () => {
  const cmd = buildSandboxedCommand("pwd", {
    projectRoot: "/home/user/project",
    cwd: "/home/user/project/subdir",
    network: false,
    roBindPaths: [],
    shadowDirs: [],
    shadowFiles: [],
  });
  assert.match(cmd, /'--chdir' '\/home\/user\/project\/subdir'/);
});
