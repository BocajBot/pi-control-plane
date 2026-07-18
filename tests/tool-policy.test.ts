import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  canonicalizePath,
  classifyTool,
  evaluateToolCall,
  type EvaluateInput,
  isInsideRoot,
  matchesDenyPatterns,
  type PathOps,
  validatePolicy,
} from "../src/control-plane/tool-policy.ts";
import type { RestrictedPolicy } from "../src/control-plane/types.ts";

const realOps: PathOps = {
  realpath: (p) => fs.realpathSync(p),
  exists: (p) => fs.existsSync(p),
};

const policy: RestrictedPolicy = {
  schemaVersion: 1,
  denyPathBasenames: [".env", "id_rsa", "credentials"],
  denyPathSubstrings: ["/.ssh/", "/.aws/"],
  allowBash: false,
};

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cp-policy-test-"));
}

function evalInput(overrides: Partial<EvaluateInput> & { toolName: string }): EvaluateInput {
  const root = overrides.projectRoot ?? makeTempRoot();
  return {
    toolInput: {},
    guardActive: false,
    phase: "execute",
    autonomy: "restricted",
    cwd: root,
    projectRoot: root,
    policy,
    ops: realOps,
    ...overrides,
  };
}

test("tool classification: read tools known, unknown tools never safe", () => {
  assert.equal(classifyTool("read"), "read");
  assert.equal(classifyTool("grep"), "read");
  assert.equal(classifyTool("find"), "read");
  assert.equal(classifyTool("ls"), "read");
  assert.equal(classifyTool("edit"), "mutate");
  assert.equal(classifyTool("write"), "mutate");
  assert.equal(classifyTool("bash"), "shell");
  assert.equal(classifyTool("browser_navigate"), "unknown");
  assert.equal(classifyTool(""), "unknown");
});

test("canonicalization: in-root path accepted, .. traversal resolved and rejected when escaping", () => {
  const root = fs.realpathSync(makeTempRoot());
  const inside = canonicalizePath("sub/dir/file.txt", root, realOps);
  assert.notEqual(inside, null);
  assert.equal(isInsideRoot(inside!, root), true);

  const escape = canonicalizePath("sub/../../outside.txt", root, realOps);
  assert.notEqual(escape, null);
  assert.equal(isInsideRoot(escape!, root), false);
});

test("canonicalization: symlinked directory inside root escaping outside is detected", () => {
  const root = fs.realpathSync(makeTempRoot());
  const outside = fs.realpathSync(makeTempRoot());
  const linkPath = path.join(root, "sneaky");
  fs.symlinkSync(outside, linkPath, "dir");
  const resolved = canonicalizePath("sneaky/payload.txt", root, realOps);
  assert.notEqual(resolved, null);
  assert.equal(isInsideRoot(resolved!, root), false, "symlink target must resolve outside the root");
});

test("canonicalization: malformed paths are rejected", () => {
  const root = makeTempRoot();
  assert.equal(canonicalizePath("", root, realOps), null);
  assert.equal(canonicalizePath("   ", root, realOps), null);
  assert.equal(canonicalizePath("a\0b", root, realOps), null);
});

test("deny patterns match basenames, dotted variants, and substrings", () => {
  assert.notEqual(matchesDenyPatterns("/home/u/project/.env", policy), null);
  assert.notEqual(matchesDenyPatterns("/home/u/project/.env.local", policy), null);
  assert.notEqual(matchesDenyPatterns("/home/u/.ssh/id_rsa", policy), null);
  assert.notEqual(matchesDenyPatterns("/home/u/.aws/config", policy), null);
  assert.equal(matchesDenyPatterns("/home/u/project/src/env.ts", policy), null);
  assert.equal(matchesDenyPatterns("/home/u/project/environment.md", policy), null);
});

test("policy validation: strict shape, unknown keys rejected", () => {
  assert.notEqual(validatePolicy({ ...policy }), null);
  assert.equal(validatePolicy(null), null);
  assert.equal(validatePolicy([]), null);
  assert.equal(validatePolicy({ ...policy, schemaVersion: 2 }), null);
  assert.equal(validatePolicy({ ...policy, allowBash: "no" }), null);
  assert.equal(validatePolicy({ ...policy, denyPathBasenames: [""] }), null);
  assert.equal(validatePolicy({ ...policy, extraKey: true }), null);
});

test("interpretation guard blocks every tool including reads", () => {
  const decision = evaluateToolCall(evalInput({ toolName: "read", guardActive: true, toolInput: { path: "x" } }));
  assert.equal(decision.action, "block");
  assert.equal(decision.rule, "interpretation-guard");
});

test("Discuss/Plan/Verify block mutation and shell regardless of autonomy; reads still allowed", () => {
  for (const phase of ["discuss", "plan", "verify"] as const) {
    for (const autonomy of ["read-only", "attended", "restricted"] as const) {
      for (const toolName of ["write", "edit", "bash", "mystery_tool"]) {
        const decision = evaluateToolCall(
          evalInput({ toolName, phase, autonomy, toolInput: toolName === "bash" ? { command: "ls" } : { path: "f.txt" } }),
        );
        assert.equal(decision.action, "block", `${phase}/${autonomy}/${toolName} must block`);
      }
      const read = evaluateToolCall(evalInput({ toolName: "read", phase, autonomy, toolInput: { path: "f.txt" } }));
      assert.notEqual(read.action, "block", `${phase}/${autonomy}/read must not hard-block`);
    }
  }
});

test("Execute + Read-only: reads allowed; shell, write, edit, unknown all blocked", () => {
  const base = { phase: "execute" as const, autonomy: "read-only" as const };
  assert.equal(evaluateToolCall(evalInput({ toolName: "read", ...base, toolInput: { path: "a" } })).action, "allow");
  assert.equal(evaluateToolCall(evalInput({ toolName: "grep", ...base })).action, "allow");
  assert.equal(evaluateToolCall(evalInput({ toolName: "bash", ...base, toolInput: { command: "echo hi" } })).action, "block");
  assert.equal(evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: { path: "a", content: "" } })).action, "block");
  assert.equal(evaluateToolCall(evalInput({ toolName: "edit", ...base, toolInput: { path: "a" } })).action, "block");
  assert.equal(evaluateToolCall(evalInput({ toolName: "wget_tool", ...base })).action, "block");
});

test("Execute + Attended: risky tools require confirmation; in-root reads pass; out-of-root reads confirm", () => {
  const root = fs.realpathSync(makeTempRoot());
  const base = { phase: "execute" as const, autonomy: "attended" as const, projectRoot: root, cwd: root };
  assert.equal(evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: { path: "f.txt", content: "" } })).action, "confirm");
  assert.equal(evaluateToolCall(evalInput({ toolName: "bash", ...base, toolInput: { command: "make" } })).action, "confirm");
  assert.equal(evaluateToolCall(evalInput({ toolName: "mystery_tool", ...base })).action, "confirm");
  assert.equal(evaluateToolCall(evalInput({ toolName: "read", ...base, toolInput: { path: "inside.txt" } })).action, "allow");
  assert.equal(evaluateToolCall(evalInput({ toolName: "read", ...base, toolInput: { path: "/etc/hostname" } })).action, "confirm");
});

test("Execute + Restricted: in-root write evaluates policy and allows; outside-root write blocks", () => {
  const root = fs.realpathSync(makeTempRoot());
  const base = { phase: "execute" as const, autonomy: "restricted" as const, projectRoot: root, cwd: root };
  const inRoot = evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: { path: "src/new.ts", content: "" } }));
  assert.equal(inRoot.action, "allow");
  const outRoot = evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: { path: "/tmp/elsewhere.txt", content: "" } }));
  assert.equal(outRoot.action, "block");
  assert.equal(outRoot.rule, "restricted:outside-root");
});

test("Execute + Restricted: parent traversal out of root is rejected", () => {
  const root = fs.realpathSync(makeTempRoot());
  const base = { phase: "execute" as const, autonomy: "restricted" as const, projectRoot: root, cwd: root };
  const decision = evaluateToolCall(
    evalInput({ toolName: "write", ...base, toolInput: { path: "../escape.txt", content: "" } }),
  );
  assert.equal(decision.action, "block");
});

test("Execute + Restricted: credential paths, unknown destination, unknown tool, shell all blocked", () => {
  const root = fs.realpathSync(makeTempRoot());
  const base = { phase: "execute" as const, autonomy: "restricted" as const, projectRoot: root, cwd: root };
  const cred = evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: { path: ".env", content: "" } }));
  assert.equal(cred.action, "block");
  assert.equal(cred.rule, "restricted:credential-path");
  const noDest = evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: {} }));
  assert.equal(noDest.action, "block");
  assert.equal(noDest.rule, "restricted:unknown-destination");
  assert.equal(evaluateToolCall(evalInput({ toolName: "mystery_tool", ...base })).action, "block");
  const shell = evaluateToolCall(evalInput({ toolName: "bash", ...base, toolInput: { command: "curl x" } }));
  assert.equal(shell.action, "block");
  assert.equal(shell.rule, "restricted:shell");
});

test("Restricted reads are denied on credential paths too", () => {
  const root = fs.realpathSync(makeTempRoot());
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  const decision = evaluateToolCall(
    evalInput({ toolName: "read", phase: "discuss", autonomy: "restricted", projectRoot: root, cwd: root, toolInput: { path: ".env" } }),
  );
  assert.equal(decision.action, "block");
  assert.equal(decision.rule, "restricted:credential-path");
});

test("invalid policy falls back to Read-only semantics under Restricted", () => {
  const root = fs.realpathSync(makeTempRoot());
  const base = { phase: "execute" as const, autonomy: "restricted" as const, projectRoot: root, cwd: root, policy: null };
  assert.equal(evaluateToolCall(evalInput({ toolName: "read", ...base, toolInput: { path: "a" } })).action, "allow");
  const write = evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: { path: "a", content: "" } }));
  assert.equal(write.action, "block");
  assert.equal(write.rule, "policy-fallback");
  assert.equal(evaluateToolCall(evalInput({ toolName: "bash", ...base, toolInput: { command: "ls" } })).action, "block");
});

test("unresolvable path is denied even in permissive modes", () => {
  const brokenOps: PathOps = {
    realpath: () => {
      throw new Error("nope");
    },
    exists: () => {
      throw new Error("nope");
    },
  };
  const decision = evaluateToolCall(
    evalInput({ toolName: "write", phase: "execute", autonomy: "attended", toolInput: { path: "f.txt", content: "" }, ops: brokenOps }),
  );
  assert.equal(decision.action, "block");
  assert.equal(decision.rule, "path-unresolvable");
});
