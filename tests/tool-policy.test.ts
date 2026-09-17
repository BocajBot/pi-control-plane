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
  schemaVersion: 2,
  denyPathBasenames: [".env", "id_rsa", "credentials"],
  denyPathSubstrings: ["/.ssh/", "/.aws/"],
  allowBash: false,
  allowPathPrefixes: [],
};

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cp-policy-test-"));
}

function evalInput(overrides: Partial<EvaluateInput> & { toolName: string }): EvaluateInput {
  const root = overrides.projectRoot ?? makeTempRoot();
  return {
    toolInput: {},
    phase: "execute",
    autonomy: "restricted",
    cwd: root,
    projectRoot: root,
    policy,
    ops: realOps,
    ...overrides,
  };
}

test("denial hints reference the merged /mode command, never the retired /phase or /autonomy", () => {
  // /phase and /autonomy were merged into /mode; a hint that still names them
  // is user-facing misinformation (the coordinator relays it verbatim).
  const root = makeTempRoot();
  const hints = [
    // phase gate
    evaluateToolCall(evalInput({ toolName: "write", phase: "discuss", autonomy: "read-only", projectRoot: root, cwd: root, toolInput: { path: "f.txt" } })).hint,
    // autonomy read-only gate
    evaluateToolCall(evalInput({ toolName: "write", phase: "execute", autonomy: "read-only", projectRoot: root, cwd: root, toolInput: { path: "f.txt" } })).hint,
    // restricted shell gate (policy.allowBash === false)
    evaluateToolCall(evalInput({ toolName: "bash", phase: "execute", autonomy: "restricted", projectRoot: root, cwd: root, toolInput: { command: "ls" } })).hint,
    // restricted unknown-tool gate
    evaluateToolCall(evalInput({ toolName: "wget_tool", phase: "execute", autonomy: "restricted", projectRoot: root, cwd: root })).hint,
  ];
  for (const hint of hints) {
    assert.ok(hint, "each of these blocks must carry an actionable hint");
    assert.match(hint!, /\/mode\b/, `hint must point at /mode: "${hint}"`);
    assert.doesNotMatch(hint!, /\/phase\b/, `hint must not name the retired /phase: "${hint}"`);
    assert.doesNotMatch(hint!, /\/autonomy\b/, `hint must not name the retired /autonomy: "${hint}"`);
  }
});

test("tool classification: read tools known, unknown tools never safe", () => {
  assert.equal(classifyTool("read"), "read");
  assert.equal(classifyTool("grep"), "read");
  assert.equal(classifyTool("find"), "read");
  assert.equal(classifyTool("ls"), "read");
  assert.equal(classifyTool("local_web_search"), "read");
  assert.equal(classifyTool("transcribe_audio"), "read");
  // pi-web-access's non-search tools are network reads; the duplicate
  // web_search stays force-disabled via profiles and is NOT read-classified
  // (treating it as read would defeat the denylist if ever re-enabled).
  assert.equal(classifyTool("fetch_content"), "read");
  assert.equal(classifyTool("get_search_content"), "read");
  assert.equal(classifyTool("source_check"), "read");
  assert.equal(classifyTool("todo"), "read");
  assert.equal(classifyTool("web_search"), "unknown");
  assert.equal(classifyTool("edit"), "mutate");
  assert.equal(classifyTool("write"), "mutate");
  assert.equal(classifyTool("bash"), "shell");
  // Harness-own tools are named, not "unknown": the harness shell is its own
  // class, meta-tools are "harness"; genuinely foreign tools stay "unknown".
  assert.equal(classifyTool("pi_harness_bash"), "harness-shell");
  assert.equal(classifyTool("harness_delegate"), "harness");
  assert.equal(classifyTool("harness_note"), "harness");
  assert.equal(classifyTool("harness_find_capability"), "harness");
  assert.equal(classifyTool("browser_navigate"), "unknown");
  assert.equal(classifyTool(""), "unknown");
});

test("fetch_content: remote urls read freely, local-file urls get full path checks", () => {
  const root = fs.realpathSync(makeTempRoot());
  // Remote urls (scheme-qualified) are not filesystem paths: allowed in Plan,
  // no confirmation, no path resolution.
  const remote = evaluateToolCall(
    evalInput({ toolName: "fetch_content", phase: "plan", autonomy: "read-only", projectRoot: root, cwd: root, toolInput: { url: "https://example.com/article" } }),
  );
  assert.equal(remote.action, "allow");
  assert.equal(remote.rule, "read-only:read");
  // A LOCAL url (scheme-less, or file://) IS a filesystem path: the same
  // canonicalization and credential deny list as the read tool apply, in
  // every mode that checks reads. Auto (unattended) categorically blocks a
  // protected path rather than confirming it.
  const home = process.env.HOME ?? "/home";
  const localCred = evaluateToolCall(
    evalInput({
      toolName: "fetch_content",
      phase: "execute",
      autonomy: "unattended",
      projectRoot: root,
      cwd: root,
      toolInput: { url: `file://${home}/.env` },
    }),
  );
  assert.equal(localCred.action, "block");
  assert.equal(localCred.rule, "restricted:credential-path");
  // The plain-path form of the same local read is covered identically.
  const bareCred = evaluateToolCall(
    evalInput({ toolName: "fetch_content", phase: "execute", autonomy: "unattended", projectRoot: root, cwd: root, toolInput: { url: `${home}/.env` } }),
  );
  assert.equal(bareCred.action, "block");
  assert.equal(bareCred.rule, "restricted:credential-path");
  // A local url inside the project root is an ordinary read.
  const localInRoot = evaluateToolCall(
    evalInput({ toolName: "fetch_content", phase: "execute", autonomy: "unattended", projectRoot: root, cwd: root, toolInput: { url: `${root}/notes/video.mp4` } }),
  );
  assert.equal(localInRoot.action, "allow");
});

test("harness shell: named 'shell' risk, inside-root resolves, and Restricted still blocks (non-loosening)", () => {
  const root = fs.realpathSync(makeTempRoot());
  // Attended: confirm, labelled shell (not unknown-tool), inside-root resolves
  // to yes instead of "Unavailable".
  const attended = evaluateToolCall(
    evalInput({ toolName: "pi_harness_bash", phase: "execute", autonomy: "attended", projectRoot: root, cwd: root, toolInput: { command: "wc -l x" } }),
  );
  assert.equal(attended.action, "confirm");
  assert.equal(attended.riskCategory, "shell");
  assert.equal(attended.insideRoot, true, "the harness shell runs inside the scope root, not Unavailable");
  assert.equal(attended.rule, "attended:harness-shell");

  // Restricted (allowBash:false): still BLOCKED, exactly as the unknown path
  // did before reclassification. Reclassification must never turn block->confirm.
  const restricted = evaluateToolCall(
    evalInput({ toolName: "pi_harness_bash", phase: "execute", autonomy: "restricted", projectRoot: root, cwd: root, toolInput: { command: "wc -l x" } }),
  );
  assert.equal(restricted.action, "block");
  assert.equal(restricted.rule, "restricted:harness-shell");

  // Even with allowBash:true (which turns a bare `bash` into a confirm), the
  // harness shell is NOT routed through that opt-in - it stays blocked.
  const restrictedBashOn = evaluateToolCall({
    ...evalInput({ toolName: "pi_harness_bash", phase: "execute", autonomy: "restricted", projectRoot: root, cwd: root, toolInput: { command: "wc -l x" } }),
    policy: { ...policy, allowBash: true },
  });
  assert.equal(restrictedBashOn.action, "block", "harness shell never enters the allowBash confirm path");
});

test("harness meta-tools: named 'harness-tool' risk, confirm in attended, block in Restricted", () => {
  const root = fs.realpathSync(makeTempRoot());
  const attended = evaluateToolCall(
    evalInput({ toolName: "harness_delegate", phase: "execute", autonomy: "attended", projectRoot: root, cwd: root, toolInput: { kind: "advisor", objective: "x" } }),
  );
  assert.equal(attended.action, "confirm");
  assert.equal(attended.riskCategory, "harness-tool");
  assert.equal(attended.rule, "attended:harness");
  assert.match(attended.reason, /harness_delegate/, "the confirm names the tool, not 'unknown'");

  const restricted = evaluateToolCall(
    evalInput({ toolName: "harness_delegate", phase: "execute", autonomy: "restricted", projectRoot: root, cwd: root, toolInput: { kind: "advisor", objective: "x" } }),
  );
  assert.equal(restricted.action, "block");
  assert.equal(restricted.rule, "restricted:harness");
});

test("local_web_search is treated as a read tool: available in Discuss without Execute/autonomy elevation", () => {
  const decision = evaluateToolCall(
    evalInput({ toolName: "local_web_search", phase: "discuss", autonomy: "read-only" }),
  );
  assert.equal(decision.action, "allow");
});

test("transcribe_audio is treated as a read tool: available in Discuss without Execute/autonomy elevation", () => {
  const decision = evaluateToolCall(
    evalInput({ toolName: "transcribe_audio", phase: "discuss", autonomy: "read-only" }),
  );
  assert.equal(decision.action, "allow");
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
  assert.equal(validatePolicy({ ...policy, schemaVersion: 1 }), null, "old schema version must not silently validate");
  assert.equal(validatePolicy({ ...policy, schemaVersion: 3 }), null);
  assert.equal(validatePolicy({ ...policy, allowBash: "no" }), null);
  assert.equal(validatePolicy({ ...policy, denyPathBasenames: [""] }), null);
  assert.equal(validatePolicy({ ...policy, allowPathPrefixes: [""] }), null, "empty-string prefix rejected same as deny lists");
  assert.equal(validatePolicy({ ...policy, allowPathPrefixes: "not-an-array" }), null);
  assert.notEqual(validatePolicy({ ...policy, allowPathPrefixes: ["/srv/shared"] }), null, "non-empty allowlist is valid");
  assert.equal(validatePolicy({ ...policy, extraKey: true }), null);
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

test("Restricted reads allow Pi package docs but keep agent auth protected", () => {
  const root = fs.realpathSync(makeTempRoot());
  const agentDir = path.join(root, ".pi", "agent");
  const packageDir = path.join(agentDir, "npm", "node_modules", "pi-subagents", "skills");
  fs.mkdirSync(packageDir, { recursive: true });
  const packageDoc = path.join(packageDir, "management-authoring-rpc.md");
  const authFile = path.join(agentDir, "auth.json");
  fs.writeFileSync(packageDoc, "documentation");
  fs.writeFileSync(authFile, "{}");
  const agentPolicy: RestrictedPolicy = {
    ...policy,
    denyPathBasenames: [...policy.denyPathBasenames, "auth.json"],
    denyPathSubstrings: [...policy.denyPathSubstrings, "/.pi/agent/"],
  };
  const base = {
    toolName: "read",
    phase: "discuss" as const,
    autonomy: "restricted" as const,
    projectRoot: root,
    cwd: root,
    policy: agentPolicy,
    agentDir,
  };

  const packageRead = evaluateToolCall(evalInput({ ...base, toolInput: { path: packageDoc } }));
  assert.equal(packageRead.action, "allow");
  assert.equal(packageRead.rule, "restricted:read");

  const authRead = evaluateToolCall(evalInput({ ...base, toolInput: { path: authFile } }));
  assert.equal(authRead.action, "block");
  assert.equal(authRead.rule, "restricted:credential-path");
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

test("Unattended (Auto): full autonomy - shell, unknown tools and out-of-root writes run; protected paths stay blocked", () => {
  // Contract change, 2026-09-16. Unattended used to share Restricted's
  // enforcement, so Auto BLOCKED bash ("restricted:shell") and unknown tools
  // ("restricted:unknown-tool") that Manual merely CONFIRMS - the top of the
  // mode ladder was stricter than the middle of it, contradicting state.ts
  // ("auto -> execute + unattended (full autonomy)"). Auto now returns only
  // allow or block: no human is present to answer a confirmation.
  const root = fs.realpathSync(makeTempRoot());
  const base = {
    phase: "execute" as const,
    autonomy: "unattended" as const,
    projectRoot: root,
    cwd: root,
  };
  const read = evaluateToolCall(evalInput({ toolName: "read", ...base, toolInput: { path: "f.txt" } }));
  assert.equal(read.action, "allow");
  const inRoot = evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: { path: "src/new.ts", content: "" } }));
  assert.equal(inRoot.action, "allow");
  // Out-of-root writes: Manual confirms them, so Auto must not block them.
  const outRoot = evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: { path: "/tmp/elsewhere.txt", content: "" } }));
  assert.equal(outRoot.action, "allow");
  // Rule carries the tool CATEGORY (classifyTool), so a write is "mutate".
  assert.equal(outRoot.rule, "unattended:mutate");
  // Shell runs without confirmation - the reported defect.
  const shell = evaluateToolCall(evalInput({ toolName: "bash", ...base, toolInput: { command: "curl x" } }));
  assert.equal(shell.action, "allow");
  assert.equal(shell.rule, "unattended:shell");
  // A third-party tool the control plane does not classify is no longer
  // categorically denied.
  const unknown = evaluateToolCall(evalInput({ toolName: "ask_user_question", ...base, toolInput: { question: "x" } }));
  assert.equal(unknown.action, "allow");
  assert.equal(unknown.rule, "unattended:unknown");
  // The one surviving categorical guard: protected paths are BLOCKED, not
  // confirmed - no confirmation step exists in Auto that could release them.
  const cred = evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: { path: ".env", content: "" } }));
  assert.equal(cred.action, "block");
  assert.equal(cred.rule, "unattended:credential-path");
});

test("mode ladder is monotonic: Auto never blocks what Manual or Accept would permit", () => {
  // The invariant the inverted-ladder bug violated, pinned so it cannot return.
  // A confirm is releasable by the user; a block is not - so Auto blocking a
  // call that a lower autonomy level allows or confirms is a regression.
  const root = fs.realpathSync(makeTempRoot());
  const calls = [
    { toolName: "bash", toolInput: { command: "echo hi" } },
    { toolName: "ask_user_question", toolInput: { question: "x" } },
    { toolName: "write", toolInput: { path: "src/new.ts", content: "" } },
    { toolName: "write", toolInput: { path: "/tmp/elsewhere.txt", content: "" } },
    { toolName: "read", toolInput: { path: "f.txt" } },
  ];
  for (const call of calls) {
    const auto = evaluateToolCall(
      evalInput({ ...call, phase: "execute", autonomy: "unattended", projectRoot: root, cwd: root }),
    );
    for (const lower of ["attended", "auto"] as const) {
      const lowerDecision = evaluateToolCall(
        evalInput({ ...call, phase: "execute", autonomy: lower, projectRoot: root, cwd: root }),
      );
      if (lowerDecision.action !== "block") {
        assert.notEqual(
          auto.action,
          "block",
          `Auto blocked ${call.toolName} (${auto.rule}) while ${lower} returned ${lowerDecision.action}`,
        );
      }
    }
  }
});

test("Unattended: an invalid/missing policy still fails closed to Read-only", () => {
  const root = fs.realpathSync(makeTempRoot());
  const base = {
    phase: "execute" as const,
    autonomy: "unattended" as const,
    projectRoot: root,
    cwd: root,
    policy: null,
  };
  const write = evaluateToolCall(evalInput({ toolName: "write", ...base, toolInput: { path: "a", content: "" } }));
  assert.equal(write.action, "block");
  assert.equal(write.rule, "policy-fallback");
});

test("allowPathPrefixes: write inside an allowlisted out-of-root directory is permitted", () => {
  const root = fs.realpathSync(makeTempRoot());
  const shared = fs.realpathSync(makeTempRoot());
  const withAllowlist: RestrictedPolicy = { ...policy, allowPathPrefixes: [shared] };
  const base = {
    phase: "execute" as const,
    autonomy: "restricted" as const,
    projectRoot: root,
    cwd: root,
    policy: withAllowlist,
  };
  const allowed = evaluateToolCall(
    evalInput({ toolName: "write", ...base, toolInput: { path: path.join(shared, "note.txt"), content: "" } }),
  );
  assert.equal(allowed.action, "allow");
  assert.equal(allowed.rule, "restricted:allowlisted-outside-root");
  // A directory NOT on the allowlist is still blocked exactly as before.
  const other = fs.realpathSync(makeTempRoot());
  const blocked = evaluateToolCall(
    evalInput({ toolName: "write", ...base, toolInput: { path: path.join(other, "note.txt"), content: "" } }),
  );
  assert.equal(blocked.action, "block");
  assert.equal(blocked.rule, "restricted:outside-root");
});

test("allowPathPrefixes: deny patterns still apply inside an allowlisted prefix", () => {
  const root = fs.realpathSync(makeTempRoot());
  const shared = fs.realpathSync(makeTempRoot());
  const withAllowlist: RestrictedPolicy = { ...policy, allowPathPrefixes: [shared] };
  const decision = evaluateToolCall(
    evalInput({
      toolName: "write",
      phase: "execute",
      autonomy: "restricted",
      projectRoot: root,
      cwd: root,
      policy: withAllowlist,
      toolInput: { path: path.join(shared, ".env"), content: "" },
    }),
  );
  assert.equal(decision.action, "block");
  assert.equal(decision.rule, "restricted:credential-path");
});

test("allowPathPrefixes: an entry that does not exist on disk is skipped, never grants access", () => {
  const root = fs.realpathSync(makeTempRoot());
  const nonexistent = path.join(root, "..", `does-not-exist-${Date.now()}`);
  const withAllowlist: RestrictedPolicy = { ...policy, allowPathPrefixes: [nonexistent] };
  const decision = evaluateToolCall(
    evalInput({
      toolName: "write",
      phase: "execute",
      autonomy: "restricted",
      projectRoot: root,
      cwd: root,
      policy: withAllowlist,
      toolInput: { path: path.join(nonexistent, "note.txt"), content: "" },
    }),
  );
  assert.equal(decision.action, "block");
  assert.equal(decision.rule, "restricted:outside-root");
});

test("auto mode: an in-root edit applies without asking, where attended would confirm", () => {
  const root = fs.realpathSync(makeTempRoot());
  const target = path.join(root, "src.ts");
  const attended = evaluateToolCall(
    evalInput({ toolName: "edit", phase: "execute", autonomy: "attended", projectRoot: root, cwd: root, toolInput: { path: target } }),
  );
  const auto = evaluateToolCall(
    evalInput({ toolName: "edit", phase: "execute", autonomy: "auto", projectRoot: root, cwd: root, toolInput: { path: target } }),
  );
  assert.equal(attended.action, "confirm", "precondition: attended asks about this edit");
  assert.equal(auto.action, "allow");
  assert.equal(auto.rule, "auto:in-root-edit");
});

test("auto mode still confirms shell, out-of-root writes and harness tools", () => {
  const root = fs.realpathSync(makeTempRoot());
  const outside = fs.realpathSync(makeTempRoot());
  const cases: [string, Record<string, unknown>][] = [
    ["bash", { command: "rm -rf /" }],
    ["write", { path: path.join(outside, "x.txt") }],
    ["harness_delegate", { kind: "advisor", objective: "x" }],
  ];
  for (const [toolName, toolInput] of cases) {
    const decision = evaluateToolCall(
      evalInput({ toolName, phase: "execute", autonomy: "auto", projectRoot: root, cwd: root, toolInput }),
    );
    assert.notEqual(decision.action, "allow", `${toolName} must not be auto-approved`);
  }
});

test("auto mode does not reach protected paths that a confirmation was guarding", () => {
  const root = fs.realpathSync(makeTempRoot());
  const decision = evaluateToolCall(
    evalInput({
      toolName: "write",
      phase: "execute",
      autonomy: "auto",
      projectRoot: root,
      cwd: root,
      toolInput: { path: path.join(root, ".env") },
    }),
  );
  // Pin the mechanism, not just the outcome: without this the test would pass
  // even if .env were rejected for some unrelated reason.
  assert.equal(decision.action, "confirm");
  assert.equal(decision.rule, "auto:credential-path");
});

test("auto mode cannot mutate outside the Execute phase", () => {
  const root = fs.realpathSync(makeTempRoot());
  const decision = evaluateToolCall(
    evalInput({ toolName: "edit", phase: "discuss", autonomy: "auto", projectRoot: root, cwd: root, toolInput: { path: path.join(root, "a.ts") } }),
  );
  assert.equal(decision.action, "block");
  assert.match(decision.rule, /^phase:/);
});
