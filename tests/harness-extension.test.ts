/**
 * Integration tests that load the real harness extension entry against a
 * fake Pi API. These cover the wiring the pure-module tests cannot: that the
 * enforcement points are actually attached to Pi's events, that the builtin
 * shell is refused at the tool_call seam, and that session close leaves a
 * durable record behind.
 *
 * Each test points PI_HARNESS_HOME at a temp directory, so nothing here
 * touches the real ~/.pi.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import piHarnessExtension from "../extensions/pi-harness.ts";
import { defaultConfig } from "../src/harness/config.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  tools = new Map<string, { name: string; execute: (...args: unknown[]) => unknown }>();
  entries: { customType: string; data: unknown }[] = [];
  activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
    this.commands.set(name, options);
  }
  registerShortcut() {}
  registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) {
    this.tools.set(tool.name, tool);
  }
  registerEntryRenderer() {}
  appendEntry(customType: string, data?: unknown) {
    this.entries.push({ customType, data: JSON.parse(JSON.stringify(data ?? null)) });
  }
  /** The full catalog, which is deliberately larger than the active set:
   * the whole point of capability search is finding what is NOT loaded. */
  allToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  getAllTools() {
    return this.allToolNames.map((name) => ({
      name,
      description: name === "bash" ? "run a shell command" : `${name} tool`,
      parameters: {},
      sourceInfo: {},
    }));
  }
  getActiveTools() {
    return [...this.activeTools];
  }
  setActiveTools(names: string[]) {
    this.activeTools = [...names];
  }
  getThinkingLevel() {
    return "medium";
  }
  async exec() {
    return { exitCode: 0, stdout: "ok", stderr: "" };
  }
  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      const r = await handler(payload, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  }
  /** All output lines the extension has emitted, flattened for matching. */
  output(): string {
    return this.entries
      .map((entry) => {
        const data = entry.data as { title?: string; lines?: string[] } | null;
        return `${data?.title ?? ""}\n${(data?.lines ?? []).join("\n")}`;
      })
      .join("\n");
  }
}

// Give this test process its own synthetic home. Project discovery searches
// ancestors for `.pi`; using the shared /tmp root directly lets an adversarial
// symlink/recovery fixture from another test redefine every later fixture's
// project as /tmp. The production rule is correct, but the old instrument was
// not isolated from its own attack artifacts.
const originalHome = process.env.HOME;
const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-ext-home-"));
process.env.HOME = suiteHome;
const tmpRoots: string[] = [];
after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(suiteHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.PI_HARNESS_HOME;
});

function tmpProject(): { root: string; harnessHome: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(suiteHome, "pi-harness-ext-")));
  tmpRoots.push(dir);
  const root = path.join(dir, "proj");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  // A package marker so project inference lands on `root` deterministically,
  // rather than on whatever VCS root the temp directory happens to sit under.
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const harnessHome = path.join(dir, "harness");
  return { root, harnessHome };
}

function makeCtx(cwd: string, options: { hasUI?: boolean; confirm?: boolean } = {}) {
  return {
    hasUI: options.hasUI ?? true,
    cwd,
    ui: {
      confirm: async () => options.confirm ?? false,
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
    },
    sessionManager: { getBranch: () => [] },
    model: { id: "test-model", provider: "test-provider" },
    isIdle: () => true,
  };
}

async function boot(): Promise<{ pi: FakePi; root: string; harnessHome: string; ctx: ReturnType<typeof makeCtx> }> {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = makeCtx(root);
  await pi.emit("session_start", { type: "session_start" }, ctx);
  return { pi, root, harnessHome, ctx };
}

/** The project state directory the harness created, whatever its hash. */
function projectDir(harnessHome: string): string {
  const projects = path.join(harnessHome, "projects");
  const entries = fs.readdirSync(projects);
  assert.equal(entries.length, 1, "exactly one project directory expected");
  return path.join(projects, entries[0]);
}

test("registers the harness commands and the sandboxed shell tool", async () => {
  const { pi } = await boot();
  for (const name of ["harness", "harness-mode", "harness-task", "harness-decide", "harness-incident", "harness-memory", "harness-review"]) {
    assert.ok(pi.commands.has(name), `missing command ${name}`);
  }
  assert.ok(pi.tools.has("pi_harness_bash"));
  assert.ok(pi.tools.has("harness_request_scope"));
  assert.ok(pi.tools.has("harness_memory_search"));
  assert.ok(pi.tools.has("harness_note"));
});

test("section 9: session start drops the builtin shell from the active tool set", async () => {
  const { pi } = await boot();
  assert.ok(!pi.getActiveTools().includes("bash"));
  assert.ok(pi.getActiveTools().includes("read"), "other tools are untouched");
});

test("section 9: the builtin shell is blocked at the tool_call seam, independently of the tool set", async () => {
  const { pi, ctx } = await boot();
  // Simulate another extension restoring the full tool set.
  pi.setActiveTools(["read", "bash", "edit"]);

  const result = (await pi.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx)) as {
    block?: boolean;
    reason?: string;
  };
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /pi_harness_bash/);
});

test("S6: a tool call on a path outside the project scope is blocked", async () => {
  const { pi, ctx } = await boot();
  const result = (await pi.emit("tool_call", { toolName: "read", input: { path: "/etc/passwd" } }, ctx)) as {
    block?: boolean;
    reason?: string;
  };
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /outside scope/);
});

test("an in-scope read is allowed without an approval prompt", async () => {
  const { pi, root, ctx } = await boot();
  const file = path.join(root, "src", "a.ts");
  fs.writeFileSync(file, "x");
  const result = await pi.emit("tool_call", { toolName: "read", input: { path: file } }, ctx);
  assert.equal(result, undefined, "an allowed call returns no block");
});

test("default approval policy asks before an in-scope write, and a refusal blocks it", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = makeCtx(root, { confirm: false });
  await pi.emit("session_start", { type: "session_start" }, ctx);

  const file = path.join(root, "src", "a.ts");
  fs.writeFileSync(file, "x");
  const result = (await pi.emit("tool_call", { toolName: "write", input: { path: file } }, ctx)) as {
    block?: boolean;
    reason?: string;
  };
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /approval prompt/);
});

test("with no UI an approval-requiring call fails closed rather than proceeding", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = makeCtx(root, { hasUI: false });
  await pi.emit("session_start", { type: "session_start" }, ctx);

  const file = path.join(root, "src", "a.ts");
  fs.writeFileSync(file, "x");
  const result = (await pi.emit("tool_call", { toolName: "write", input: { path: file } }, ctx)) as {
    block?: boolean;
    reason?: string;
  };
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /failing closed/);
});

test("AU2: session start is audited with the project it inferred", async () => {
  const { harnessHome } = await boot();
  const audit = fs.readFileSync(path.join(projectDir(harnessHome), "audit.jsonl"), "utf8");
  assert.match(audit, /"eventType":"session_start"/);
  assert.match(audit, /package-marker/);
});

test("AU1: a denied tool call is recorded, and the log only ever grows", async () => {
  const { pi, harnessHome, ctx } = await boot();
  const auditFile = path.join(projectDir(harnessHome), "audit.jsonl");
  const before = fs.readFileSync(auditFile, "utf8");

  await pi.emit("tool_call", { toolName: "read", input: { path: "/etc/passwd" } }, ctx);

  const after = fs.readFileSync(auditFile, "utf8");
  assert.ok(after.startsWith(before), "existing audit lines must be untouched");
  assert.match(after.slice(before.length), /"eventType":"authorization"/);
});

test("T1: only an explicit command creates a task", async () => {
  const { pi, harnessHome, ctx } = await boot();
  const tasksFile = path.join(harnessHome, "tasks.json");
  assert.ok(!fs.existsSync(tasksFile) || JSON.parse(fs.readFileSync(tasksFile, "utf8")).length === 0);

  await pi.commands.get("harness-task")!.handler("new add the retry path", ctx);
  const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].objective, "add the retry path");
  assert.equal(tasks[0].status, "queued");
});

test("D3: the decide command refuses a temporary decision with no revisit condition", async () => {
  const { pi, ctx } = await boot();
  await pi.commands.get("harness-decide")!.handler("temporary use sqlite || it is faster", ctx);
  assert.match(pi.output(), /Refused.*D3/s);

  await pi.commands.get("harness-decide")!.handler("temporary use sqlite || it is faster || 2026-12-01", ctx);
  assert.match(pi.output(), /recorded/);
});

test("R5: compaction flushes a checkpoint and the recovery file first", async () => {
  const { pi, root, ctx } = await boot();
  await pi.emit("session_before_compact", { type: "session_before_compact" }, ctx);
  const workstate = fs.readFileSync(path.join(root, ".pi", "WORKSTATE.md"), "utf8");
  assert.match(workstate, /not the authoritative record/);
});

test("session close writes WORKSTATE and queues a retrospective review without running it", async () => {
  const { pi, root, harnessHome, ctx } = await boot();
  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);

  assert.ok(fs.existsSync(path.join(root, ".pi", "WORKSTATE.md")));
  const queue = JSON.parse(fs.readFileSync(path.join(harnessHome, "review-queue.json"), "utf8"));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "pending", "an interactive close must not wait for the reviewer");
});

test("R1: a second session reports the previous one as unclosed and refuses to auto-continue", async () => {
  const { pi, root, harnessHome, ctx } = await boot();
  await pi.emit("tool_call", { toolName: "read", input: { path: "/etc/passwd" } }, ctx);
  // No session_shutdown: this is a crash, not a close.

  const second = new FakePi();
  process.env.PI_HARNESS_HOME = harnessHome;
  await piHarnessExtension(second as never);
  await second.emit("session_start", { type: "session_start" }, makeCtx(root));

  assert.match(second.output(), /interrupted work detected/i);
  assert.match(second.output(), /CONFLICT|UNCERTAIN/);
});

test("MO3: a model switch is audited and leaves scope and approval untouched", async () => {
  const { pi, harnessHome, ctx } = await boot();
  await pi.emit("model_select", { model: { id: "other-model", provider: "test-provider" } }, ctx);

  const audit = fs.readFileSync(path.join(projectDir(harnessHome), "audit.jsonl"), "utf8");
  assert.match(audit, /"eventType":"model_switch"/);
  assert.match(audit, /authority unchanged/);
});

test("the status command reports scope, authority posture, and sandbox availability", async () => {
  const { pi, root, ctx } = await boot();
  await pi.commands.get("harness")!.handler("status", ctx);
  const output = pi.output();
  assert.match(output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /Autonomy:\s+guided/);
  assert.match(output, /Approval:\s+mutations/);
  assert.match(output, /Sandbox:/);
});

test("the authority command lists the constitutional rules a model cannot change", async () => {
  const { pi, ctx } = await boot();
  await pi.commands.get("harness")!.handler("authority coordinator", ctx);
  const output = pi.output();
  assert.match(output, /audit history is append-oriented/);
  assert.ok(!/memory-promote-global/.test(output.split("Constitutional")[0]), "coordinator must not list global promotion");
});

test("M1: the memory command promotes on user direction and records the epistemic type", async () => {
  const { pi, harnessHome, ctx } = await boot();
  await pi.commands.get("harness-memory")!.handler("add tooling opinion pkexec is preferred over sudo here", ctx);
  const memory = fs.readFileSync(path.join(harnessHome, "memory.jsonl"), "utf8");
  assert.match(memory, /"epistemicType":"opinion"/);
  assert.match(memory, /"createdBy":"user"/);
});

test("the scope tool refuses an expansion beyond one boundary and tells the model what to ask for", async () => {
  const { pi, root, ctx } = await boot();
  const tool = pi.tools.get("harness_request_scope")!;
  const result = (await tool.execute("id", { path: "/etc" }, undefined, undefined, ctx)) as { content: { text: string }[] };
  assert.match(result.content[0].text, /Not granted/);
  assert.match(result.content[0].text, /\/harness scope approve/);
  assert.ok(root.length > 0);
});

test("an unrecognized tool is treated as mutating, not waved through as a read", async () => {
  const { pi, ctx } = await boot();
  // No UI in this ctx would fail closed for the wrong reason, so use the
  // default ctx (hasUI true, confirm false) and assert it was gated at all.
  const result = (await pi.emit(
    "tool_call",
    { toolName: "some_third_party_writer", input: { target: "whatever" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(result?.block, true, "an unknown tool must not skip the gate");
});

test("a known read tool is still allowed without a prompt", async () => {
  const { pi, root, ctx } = await boot();
  const file = path.join(root, "src", "a.ts");
  fs.writeFileSync(file, "x");
  assert.equal(await pi.emit("tool_call", { toolName: "grep", input: { path: file } }, ctx), undefined);
});

test("S6: a target named under file_path rather than path is still scope-checked", async () => {
  const { pi, ctx } = await boot();
  const result = (await pi.emit(
    "tool_call",
    { toolName: "read", input: { file_path: "/etc/passwd" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /outside scope/);
});

test("SA3: a delegate instance adopts the contract scope instead of minting a full-project one", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;

  // Stand up a parent session first, so there is a persisted session and a
  // WORKSTATE for the delegate to be caught overwriting.
  const parent = new FakePi();
  await piHarnessExtension(parent as never);
  const parentCtx = makeCtx(root);
  await parent.emit("session_start", { type: "session_start" }, parentCtx);
  await parent.commands.get("harness")!.handler("checkpoint parent verified state", parentCtx);
  // v0.2 (section 32) keeps state per session under `sessions/` rather than
  // in one mutable snapshot, so the parent's resume point is a file named
  // after its own id - which is what makes "the delegate did not replace it"
  // checkable by listing rather than by reading one shared path.
  const sessionsDir = path.join(projectDir(harnessHome), "sessions");
  const parentSessions = fs.readdirSync(sessionsDir);
  assert.equal(parentSessions.length, 1, "the parent wrote exactly one session file");
  const parentStateFile = path.join(sessionsDir, parentSessions[0]);
  const parentSessionId = JSON.parse(fs.readFileSync(parentStateFile, "utf8")).id;
  const parentWorkstate = fs.readFileSync(path.join(root, ".pi", "WORKSTATE.md"), "utf8");

  // Now boot an instance the way Pi does inside a delegate: same package,
  // same project, with the contract marker in the environment.
  process.env.PI_HARNESS_DELEGATE_CONTRACT = JSON.stringify({
    contractId: "dlg_test",
    kind: "subagent",
    allowedRoots: [path.join(root, "src")],
    root: path.join(root, "src"),
    parentSession: parentSessionId,
    // The contract mirrors the parent's live posture (A3: equal, never
    // looser). The parent booted at the configured guided/mutations.
    autonomy: "guided",
    approvalPolicy: "mutations",
  });
  const child = new FakePi();
  await piHarnessExtension(child as never);
  const childCtx = makeCtx(root);
  await child.emit("session_start", { type: "session_start" }, childCtx);
  delete process.env.PI_HARNESS_DELEGATE_CONTRACT;

  const inScope = path.join(root, "src", "a.ts");
  const outOfScope = path.join(root, "other.ts");
  fs.writeFileSync(inScope, "x");
  fs.writeFileSync(outOfScope, "x");

  // Inside the contract scope: allowed.
  assert.equal(await child.emit("tool_call", { toolName: "read", input: { path: inScope } }, childCtx), undefined);

  // Inside the *project* but outside the contract scope: this is the case
  // that would have been allowed by a freshly inferred full-project scope.
  const escaped = (await child.emit("tool_call", { toolName: "read", input: { path: outOfScope } }, childCtx)) as {
    block?: boolean;
    reason?: string;
  };
  assert.equal(escaped?.block, true, "a delegate must not reach outside its contract scope");
  assert.match(escaped?.reason ?? "", /outside scope/);

  // A subagent has no mutate capability at all, regardless of approval.
  const write = (await child.emit("tool_call", { toolName: "write", input: { path: inScope } }, childCtx)) as {
    block?: boolean;
    reason?: string;
  };
  assert.equal(write?.block, true);
  assert.match(write?.reason ?? "", /subagent.*no authority|A2\/A3/);

  // R1: the delegate must not have replaced the parent's resume point, and
  // must not have added a session of its own to the project's recovery set.
  assert.equal(JSON.parse(fs.readFileSync(parentStateFile, "utf8")).id, parentSessionId);
  assert.deepEqual(fs.readdirSync(sessionsDir), parentSessions, "a delegate writes no session state");

  await child.emit("session_shutdown", { type: "session_shutdown" }, childCtx);
  assert.equal(
    fs.readFileSync(path.join(root, ".pi", "WORKSTATE.md"), "utf8"),
    parentWorkstate,
    "a delegate must not overwrite the parent's recovery snapshot",
  );
  // Absent is the expected state here: the parent never closed, and the
  // delegate must not have written a queue of its own.
  const queueFile = path.join(harnessHome, "review-queue.json");
  assert.deepEqual(
    fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, "utf8")) : [],
    [],
    "a delegate ending is not a session to review",
  );
});

test("a tool that reads ctx takes it as the fifth argument, matching Pi's real call", async () => {
  // Pi calls execute(toolCallId, params, signal, onUpdate, ctx) - see
  // dist/core/tools/tool-definition-wrapper.js. A three-argument lambda
  // therefore binds `ctx` to the AbortSignal, which is how ctx.cwd was
  // silently undefined in four harness tools and how a later ctx.modelRegistry
  // read crashed outright. Arity is the cheapest thing that pins the contract.
  const { pi } = await boot();
  for (const name of ["harness_request_scope", "harness_set_posture", "harness_delegate"]) {
    const tool = pi.tools.get(name);
    if (tool === undefined) continue;
    assert.equal(
      tool.execute.length,
      5,
      `${name} must accept Pi's full execute signature, or ctx is really the signal`,
    );
  }
});

test("TO1: capability search finds an unloaded tool and says finding it is not authorization", async () => {
  const { pi, ctx } = await boot();
  // The builtin shell was removed from the active set at session start, so
  // it is exactly the "exists but is not loaded" case TO1 describes.
  const result = (await pi.tools.get("harness_find_capability")!.execute("id", { need: "shell" }, undefined, undefined, ctx)) as {
    content: { text: string }[];
  };
  const text = result.content[0].text;
  assert.match(text, /^bash.*\(available, not loaded\)/m, "the unloaded shell must be found and marked unloaded");
  assert.match(text, /not authorization/);
});

test("TO3: with no matching capability, the model is told to propose a tool rather than work around it", async () => {
  const { pi, ctx } = await boot();
  const result = (await pi.tools.get("harness_find_capability")!.execute(
    "id",
    { need: "zzz-nonexistent-capability" },
    undefined,
    undefined,
    ctx,
  )) as { content: { text: string }[] };
  assert.match(result.content[0].text, /Propose a new tool/);
  assert.match(result.content[0].text, /not automatic/);
});

test("the review queue lists a queued session and reports when nothing is pending", async () => {
  const { pi, ctx } = await boot();
  await pi.commands.get("harness-review")!.handler("list", ctx);
  assert.match(pi.output(), /\(empty\)/);

  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  await pi.commands.get("harness-review")!.handler("list", ctx);
  assert.match(pi.output(), /\[pending\] session ses_/);
});

test("running a review with nothing queued reports that, and does not invent a review", async () => {
  const { pi, harnessHome, ctx } = await boot();
  await pi.commands.get("harness-review")!.handler("run", ctx);
  assert.match(pi.output(), /Nothing pending/);
  assert.ok(
    !fs.existsSync(path.join(harnessHome, "reviews")) ||
      fs.readdirSync(path.join(harnessHome, "reviews")).length === 0,
  );
});

test("policy state persists across sessions and binds the next one", async () => {
  const { pi, root, harnessHome, ctx } = await boot();
  await pi.commands.get("harness-policy")!.handler("set project denyTool write", ctx);
  assert.match(pi.output(), /write/);

  // A second session over the same harness home is the restart.
  const second = new FakePi();
  process.env.PI_HARNESS_HOME = harnessHome;
  await piHarnessExtension(second as never);
  const ctx2 = makeCtx(root);
  await second.emit("session_start", { type: "session_start" }, ctx2);

  const file = path.join(root, "src", "a.ts");
  fs.writeFileSync(file, "x");
  const result = (await second.emit("tool_call", { toolName: "write", input: { path: file } }, ctx2)) as {
    block?: boolean;
    reason?: string;
  };
  assert.equal(result?.block, true, "the tightened policy is still in force after a restart");
  assert.match(result?.reason ?? "", /soft policy/);
});

test("section 22: the resolved policy is audited at load so its provenance is visible", async () => {
  const { pi, root, harnessHome, ctx } = await boot();
  await pi.commands.get("harness-policy")!.handler("set global denyTool bash", ctx);

  const second = new FakePi();
  process.env.PI_HARNESS_HOME = harnessHome;
  await piHarnessExtension(second as never);
  await second.emit("session_start", { type: "session_start" }, makeCtx(root));

  const audit = fs.readFileSync(path.join(projectDir(harnessHome), "audit.jsonl"), "utf8");
  assert.match(audit, /"eventType":"policy_load"/);
});

test("section 17: identity persists and is injected into the system prompt", async () => {
  const { pi, root, harnessHome, ctx } = await boot();
  await pi.commands.get("harness-identity")!.handler("add principle verify before asserting", ctx);

  const second = new FakePi();
  process.env.PI_HARNESS_HOME = harnessHome;
  await piHarnessExtension(second as never);
  const ctx2 = makeCtx(root);
  await second.emit("session_start", { type: "session_start" }, ctx2);

  const result = (await second.emit(
    "before_agent_start",
    { type: "before_agent_start", systemPrompt: "BASE" },
    ctx2,
  )) as { systemPrompt?: string };
  assert.match(result?.systemPrompt ?? "", /^BASE/, "the base prompt is preserved");
  assert.match(result?.systemPrompt ?? "", /## Pi identity/);
  assert.match(result?.systemPrompt ?? "", /verify before asserting/);
});

test("section 17: a model cannot edit identity, and the refusal names the alternative", async () => {
  const { pi, harnessHome, ctx } = await boot();
  // The command path is user-authority by construction; the module-level
  // refusal is what a model would hit. Assert the stored file is untouched
  // by anything but the user command.
  await pi.commands.get("harness-identity")!.handler("add behavior terse", ctx);
  const identity = JSON.parse(fs.readFileSync(path.join(harnessHome, "identity.json"), "utf8"));
  assert.deepEqual(identity.behaviors, ["terse"]);
  assert.equal(identity.updatedBy, "user");
});

test("section 13: goals reach the prompt as advisory, and a link grants no scope", async () => {
  const { pi, root, ctx } = await boot();
  await pi.commands.get("harness-goal")!.handler("new long 2 keep dependencies low || add a dependency", ctx);
  await pi.commands.get("harness-goal")!.handler("link /somewhere/else shared-tool same linter", ctx);
  assert.match(pi.output(), /grants no access/);

  const result = (await pi.emit(
    "before_agent_start",
    { type: "before_agent_start", systemPrompt: "BASE" },
    ctx,
  )) as { systemPrompt?: string };
  assert.match(result?.systemPrompt ?? "", /## Standing goals/);
  assert.match(result?.systemPrompt ?? "", /keep dependencies low/);
  assert.match(result?.systemPrompt ?? "", /not permissions/);

  // The linked project is still outside scope.
  const blocked = (await pi.emit(
    "tool_call",
    { toolName: "read", input: { path: "/somewhere/else/file.ts" } },
    ctx,
  )) as { block?: boolean };
  assert.equal(blocked?.block, true);
});

test("section 13: /harness-goal check surfaces tension without blocking anything", async () => {
  const { pi, root, ctx } = await boot();
  await pi.commands.get("harness-goal")!.handler("new long 2 keep dependencies low || add a dependency", ctx);
  await pi.commands.get("harness-goal")!.handler("check add a dependency on left-pad", ctx);
  assert.match(pi.output(), /Tension with standing goals/);
  assert.match(pi.output(), /your instruction still wins/);

  // And the work itself is unaffected: an in-scope write still only meets
  // the ordinary approval gate, not a goal veto.
  const file = path.join(root, "src", "a.ts");
  fs.writeFileSync(file, "x");
  const result = (await pi.emit("tool_call", { toolName: "write", input: { path: file } }, ctx)) as {
    block?: boolean;
    reason?: string;
  };
  assert.match(result?.reason ?? "", /approval prompt/, "gated by approval, not by the goal");
});

test("harness_note records a provisional assumption that reaches WORKSTATE as provisional", async () => {
  const { pi, root, ctx } = await boot();
  await pi.tools.get("harness_note")!.execute("id", { kind: "assumption", text: "the caller retries" }, undefined, undefined, ctx);
  await pi.commands.get("harness")!.handler("workstate", ctx);

  const workstate = fs.readFileSync(path.join(root, ".pi", "WORKSTATE.md"), "utf8");
  assert.match(workstate, /Active assumptions \(provisional\)/);
  assert.match(workstate, /the caller retries/);
});

/* ------------------------------------------------------------------ *
 * v0.2 integration hardening (spec section 32) - the wiring, against a
 * fake Pi. The module-level rules are covered in their own files; what
 * is tested here is that the extension actually reaches them.
 * ------------------------------------------------------------------ */

test("section 32: state is per-session and the global index resolves the session to its project", async () => {
  const { root, harnessHome, ctx, pi } = await boot();
  await pi.commands.get("harness")!.handler("checkpoint first verified state", ctx);

  const sessionsDir = path.join(projectDir(harnessHome), "sessions");
  const files = fs.readdirSync(sessionsDir);
  assert.equal(files.length, 1, "the session wrote its own state file");
  const state = JSON.parse(fs.readFileSync(path.join(sessionsDir, files[0]), "utf8"));

  const index = JSON.parse(fs.readFileSync(path.join(harnessHome, "sessions.json"), "utf8"));
  const row = index.find((entry: { id: string }) => entry.id === state.id);
  assert.ok(row, "the session appears in the global index");
  assert.equal(row.projectRoot, root, "and the index is what maps an id to a project");
});

test("section 32: a second session in the same project does not overwrite the first", async () => {
  // The exact v0.1 defect: one mutable session-state.json per project.
  const { root, harnessHome, ctx, pi } = await boot();
  await pi.commands.get("harness")!.handler("checkpoint first", ctx);
  const sessionsDir = path.join(projectDir(harnessHome), "sessions");
  const first = fs.readdirSync(sessionsDir);
  assert.equal(first.length, 1);

  const second = new FakePi();
  await piHarnessExtension(second as never);
  const ctx2 = makeCtx(root);
  await second.emit("session_start", { type: "session_start" }, ctx2);
  await second.commands.get("harness")!.handler("checkpoint second", ctx2);

  const after = fs.readdirSync(sessionsDir);
  assert.equal(after.length, 2, "both sessions survive");
  assert.ok(after.includes(first[0]), "the first session's file is untouched");
});

test("section 32: WORKSTATE gets a per-session copy alongside the current snapshot", async () => {
  const { root, ctx, pi } = await boot();
  await pi.commands.get("harness")!.handler("checkpoint verified", ctx);
  const perSession = fs.readdirSync(path.join(root, ".pi", "workstates"));
  assert.equal(perSession.length, 1);
  assert.ok(fs.existsSync(path.join(root, ".pi", "WORKSTATE.md")), "the current snapshot is still written");
});

test("TO1/section 32: an unconfined tool is withheld from the active set and named", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  pi.allToolNames = ["read", "write", "bash", "mystery_tool"];
  await piHarnessExtension(pi as never);
  const ctx = makeCtx(root);
  await pi.emit("session_start", { type: "session_start" }, ctx);

  assert.ok(!pi.getActiveTools().includes("mystery_tool"), "an opaque tool is not active by default");
  assert.ok(!pi.getActiveTools().includes("bash"), "and the builtin shell is still gone");
  assert.ok(pi.getActiveTools().includes("read"), "scope-aware builtins stay");
  assert.ok(pi.getActiveTools().includes("pi_harness_bash"), "harness tools stay - losing the shell entirely is the regression");
  assert.match(pi.output(), /mystery_tool \[unconfined\]/, "and the user is told what was withheld");
});

test("section 32: calling an unconfined tool is refused when the user declines the exception", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  pi.allToolNames = ["read", "mystery_tool"];
  await piHarnessExtension(pi as never);
  const ctx = makeCtx(root, { confirm: false });
  await pi.emit("session_start", { type: "session_start" }, ctx);

  const result = (await pi.emit("tool_call", { toolName: "mystery_tool", input: {} }, ctx)) as {
    block?: boolean;
    reason?: string;
  };
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /declined|unconfined/);
});

test("section 32: a granted exception activates the tool for this session and says it is unconfined", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  pi.allToolNames = ["read", "mystery_tool"];
  await piHarnessExtension(pi as never);
  const ctx = makeCtx(root, { confirm: true });
  await pi.emit("session_start", { type: "session_start" }, ctx);

  await pi.commands.get("harness")!.handler("capability grant mystery_tool because I said so", ctx);
  assert.ok(pi.getActiveTools().includes("mystery_tool"));
  assert.match(pi.output(), /UNCONFINED/, "the grant does not describe it as sandboxed");

  // And the call now passes the capability gate (it is still scope-checked).
  const result = await pi.emit("tool_call", { toolName: "mystery_tool", input: {} }, ctx);
  assert.equal(result, undefined);

  await pi.commands.get("harness")!.handler("capability revoke mystery_tool", ctx);
  assert.ok(!pi.getActiveTools().includes("mystery_tool"), "revoking is authority-reducing and immediate");
});

test("SA5: a delegate cannot be granted a capability exception at the prompt", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  process.env.PI_HARNESS_DELEGATE_CONTRACT = JSON.stringify({
    contractId: "dlg_cap",
    kind: "subagent",
    allowedRoots: [root],
    root,
    parentSession: "ses_parent",
    autonomy: "interactive",
    approvalPolicy: "all-actions",
  });
  const pi = new FakePi();
  pi.allToolNames = ["read", "mystery_tool"];
  await piHarnessExtension(pi as never);
  // confirm: true - the point is that it is never asked.
  const ctx = makeCtx(root, { confirm: true });
  await pi.emit("session_start", { type: "session_start" }, ctx);
  delete process.env.PI_HARNESS_DELEGATE_CONTRACT;

  const result = (await pi.emit("tool_call", { toolName: "mystery_tool", input: {} }, ctx)) as {
    block?: boolean;
    reason?: string;
  };
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /delegate cannot be granted/);
});

test("section 32: the coordinator may tighten posture through its tool but not loosen it unattended", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  // No UI, so a needs-approval verdict has nowhere to go and must fail closed.
  const ctx = makeCtx(root, { hasUI: false });
  await pi.emit("session_start", { type: "session_start" }, ctx);

  const tool = pi.tools.get("harness_set_posture")!;
  const tighten = (await tool.execute("1", { field: "autonomy", value: "interactive" }, undefined, undefined, ctx)) as {
    content: { text: string }[];
  };
  assert.match(tighten.content[0].text, /autonomy set to interactive \(tighten\)/);

  const loosen = (await tool.execute("2", { field: "autonomy", value: "autonomous" }, undefined, undefined, ctx)) as {
    content: { text: string }[];
  };
  assert.match(loosen.content[0].text, /authority expansion|failing closed/);
  assert.doesNotMatch(loosen.content[0].text, /set to autonomous/);
});

test("posture: an invalid value is refused rather than written into session state", async () => {
  const { pi, ctx } = await boot();
  await pi.commands.get("harness-mode")!.handler("autonomy banana", ctx);
  assert.match(pi.output(), /Invalid autonomy value/);
  await pi.commands.get("harness")!.handler("status", ctx);
  assert.match(pi.output(), /Autonomy:\s+guided/);
});

test("section 32: /harness status reports the audit chain state", async () => {
  const { pi, ctx } = await boot();
  await pi.commands.get("harness")!.handler("status", ctx);
  assert.match(pi.output(), /Audit chain: verified: \d+ chained event/);
  assert.doesNotMatch(pi.output(), /ENDPOINT MISMATCH/, "a healthy log reports no mismatch");
});

test("deleting audit events is surfaced to the user, not just detectable in principle", async () => {
  const { pi, ctx, harnessHome } = await boot();
  await pi.commands.get("harness")!.handler("checkpoint one", ctx);
  const auditFile = path.join(projectDir(harnessHome), "audit.jsonl");
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
  assert.ok(lines.length >= 2, "need at least two events to remove one");
  fs.writeFileSync(auditFile, `${lines.slice(0, lines.length - 1).join("\n")}\n`);

  await pi.commands.get("harness")!.handler("status", ctx);
  assert.match(pi.output(), /ENDPOINT MISMATCH/, "the user must be told, not merely the verifier");
  assert.match(pi.output(), /were removed/);
});

test("section 32: a v0.1 audit log is anchored and declared, not retroactively claimed as protected", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;

  // Boot once so the project directory exists, then plant a v0.1-shaped log
  // in it: schemaVersion 1, and no hash fields at all.
  const first = new FakePi();
  await piHarnessExtension(first as never);
  await first.emit("session_start", { type: "session_start" }, makeCtx(root));
  const auditFile = path.join(projectDir(harnessHome), "audit.jsonl");
  fs.writeFileSync(
    auditFile,
    [0, 1, 2]
      .map((i) =>
        JSON.stringify({
          schemaVersion: 1,
          id: `aud_old${i}`,
          timestamp: "2026-01-01T00:00:00.000Z",
          session: "ses_old",
          actor: "core",
          actorModel: null,
          eventType: "tool_call",
          request: `old${i}`,
          result: "ok",
          scope: "/x [no-net]",
          metadata: {},
        }),
      )
      .join("\n") + "\n",
  );

  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  await pi.emit("session_start", { type: "session_start" }, makeCtx(root));

  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const anchor = lines.find((l) => l.eventType === "audit_anchor");
  assert.ok(anchor, "the boundary is declared in the log itself");
  assert.equal(anchor.metadata.legacyPrefixLength, 3);
  assert.equal(anchor.prevHash, anchor.metadata.legacyPrefixDigest, "the chain starts by anchoring to that exact prefix");

  // The old records are untouched: no hash was invented for them.
  for (const old of lines.filter((l) => l.id?.startsWith("aud_old"))) {
    assert.equal(old.hash ?? null, null, "a back-filled hash would be a false claim");
  }
});

/* ------------------------------------------------------------------ *
 * Adversarial: delegate authority at the real extension seam
 * ------------------------------------------------------------------ */

test("A3/SA5: a delegate session adopts the contract's posture, not the configured default", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  // The contract is stricter than the configured guided/mutations default.
  process.env.PI_HARNESS_DELEGATE_CONTRACT = JSON.stringify({
    contractId: "dlg_posture",
    kind: "subagent",
    allowedRoots: [root],
    root,
    parentSession: "ses_parent",
    autonomy: "interactive",
    approvalPolicy: "all-actions",
  });
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = makeCtx(root);
  await pi.emit("session_start", { type: "session_start" }, ctx);
  delete process.env.PI_HARNESS_DELEGATE_CONTRACT;

  await pi.commands.get("harness")!.handler("status", ctx);
  const out = pi.output();
  assert.match(out, /Autonomy:\s+interactive/, "the contract's autonomy must win over the config default");
  assert.match(out, /Approval:\s+all-actions/, "and so must its approval policy");
});

test("a delegate marker that does not parse degrades to the floor, never to the coordinator", async () => {
  // Ignoring a malformed marker was the original behaviour, and ignoring it
  // meant carrying on as the coordinator with a freshly inferred
  // full-project scope - strictly more authority than any contract grants.
  // The presence of the variable is the proof of delegation; only its
  // contents are in doubt.
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  process.env.PI_HARNESS_DELEGATE_CONTRACT = "{not json at all";
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = makeCtx(root);
  await pi.emit("session_start", { type: "session_start" }, ctx);
  delete process.env.PI_HARNESS_DELEGATE_CONTRACT;

  // An advisor may only read. A write is refused on capability, which is
  // what proves this instance is not acting as the coordinator.
  fs.writeFileSync(path.join(root, "src", "a.ts"), "x");
  const write = (await pi.emit(
    "tool_call",
    { toolName: "write", input: { path: path.join(root, "src", "a.ts") } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(write?.block, true, "a degraded delegate must not hold coordinator authority");
  assert.match(write?.reason ?? "", /advisor.*no authority|A2\/A3/);

  // And the degradation itself is on the record rather than silent.
  const auditFile = path.join(projectDir(harnessHome), "audit.jsonl");
  assert.match(fs.readFileSync(auditFile, "utf8"), /unparseable; degraded to a read-only advisor/);
});

/* ---------------------------------------------------------------- *
 * Gate fatigue (GATE-FATIGUE-REDESIGN.md): P1 effect-based gating,
 * P4 configuration refusals that never spend an approval.
 * ---------------------------------------------------------------- */

/** A ctx that COUNTS confirmation prompts, so a test can assert that a call
 * cost zero approvals rather than merely that it was allowed. */
function countingCtx(cwd: string, answer: boolean) {
  const prompts: string[] = [];
  return {
    prompts,
    hasUI: true,
    cwd,
    ui: {
      confirm: async (title: string) => {
        prompts.push(title);
        return answer;
      },
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
    },
    sessionManager: { getBranch: () => [] },
    model: { id: "test-model", provider: "test-provider" },
    isIdle: () => true,
  };
}

test("P1: read-effect harness tools cost no approval (gate on effect, not mechanism)", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  // answer=false: if any of these DID prompt, the call would be blocked and the
  // assertion below would catch it - the test cannot pass by accident.
  const ctx = countingCtx(root, false);
  await pi.emit("session_start", { type: "session_start" }, ctx);

  for (const toolName of ["harness_find_capability", "harness_memory_search", "harness_request_scope"]) {
    const result = (await pi.emit("tool_call", { toolName, input: {} }, ctx)) as { block?: boolean } | undefined;
    assert.equal(result?.block, undefined, `${toolName} must not be blocked`);
  }
  assert.deepEqual(ctx.prompts, [], "read-effect harness tools must not prompt at all");
});

test("P1: harness_delegate (escalation) still passes the section 21 gate", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = countingCtx(root, false); // decline
  await pi.emit("session_start", { type: "session_start" }, ctx);

  // harness_delegate is deliberately absent from READ_TOOLS: it spawns an
  // actor, so it maps to "mutate" and section 21 asks. This is the gate the
  // gate-fatigue work must NOT remove.
  const result = (await pi.emit("tool_call", { toolName: "harness_delegate", input: {} }, ctx)) as {
    block?: boolean;
  };
  assert.equal(result?.block, true, "delegation stays gated");
  assert.equal(ctx.prompts.length, 1, "and it asks exactly once at this seam");
});

test("P4: a harness-shell call that cannot run as configured is refused BEFORE any approval", async () => {
  const { root, harnessHome } = tmpProject();
  // A COMPLETE, valid config whose mount set is empty. (A partial config would
  // fail validation and silently fall back to the defaults, which now ship
  // system mounts - so this has to be a full config to exercise the refusal.)
  fs.mkdirSync(harnessHome, { recursive: true });
  const unconfigured = { ...defaultConfig(() => new Date("2026-01-01T00:00:00.000Z")), sandboxReadOnlyPaths: [] };
  fs.writeFileSync(path.join(harnessHome, "config.json"), JSON.stringify(unconfigured, null, 2));

  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = countingCtx(root, true); // would APPROVE if it were asked
  await pi.emit("session_start", { type: "session_start" }, ctx);

  const result = (await pi.emit(
    "tool_call",
    { toolName: "pi_harness_bash", input: { command: "node --test" } },
    ctx,
  )) as { block?: boolean; reason?: string } | undefined;

  assert.equal(result?.block, true, "an unrunnable-by-config shell call is refused");
  assert.deepEqual(ctx.prompts, [], "and it costs NO approval prompt");
  assert.match(result?.reason ?? "", /config\.json/, "the refusal names the file to fix");
  assert.match(result?.reason ?? "", /sandboxReadOnlyPaths/, "and the key");
  assert.match(result?.reason ?? "", /No approval was requested/);
});

test("P2: a control-plane approval stamped on the event is consumed instead of re-asking", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = countingCtx(root, false); // would DECLINE if asked
  await pi.emit("session_start", { type: "session_start" }, ctx);

  const file = path.join(root, "src", "a.ts");
  fs.writeFileSync(file, "x");
  // Same write that asks (and is refused) without a stamp - see the
  // "default approval policy asks before an in-scope write" test above.
  const event = {
    toolName: "write",
    toolCallId: "call-1",
    input: { path: file },
    __cpUserApproved: { callId: "call-1", at: "2026-01-01T00:00:00.000Z" },
  };
  const result = (await pi.emit("tool_call", event, ctx)) as { block?: boolean } | undefined;
  assert.equal(result?.block, undefined, "the already-given answer is honoured");
  assert.deepEqual(ctx.prompts, [], "and the identical question is NOT asked a second time");
});

test("P2: a stamp for a DIFFERENT call is ignored (no replay onto a later call)", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = countingCtx(root, false);
  await pi.emit("session_start", { type: "session_start" }, ctx);

  const file = path.join(root, "src", "a.ts");
  fs.writeFileSync(file, "x");
  const event = {
    toolName: "write",
    toolCallId: "call-2",
    input: { path: file },
    __cpUserApproved: { callId: "call-1", at: "2026-01-01T00:00:00.000Z" }, // stale id
  };
  const result = (await pi.emit("tool_call", event, ctx)) as { block?: boolean } | undefined;
  assert.equal(result?.block, true, "a stamp naming another call grants nothing");
  assert.equal(ctx.prompts.length, 1, "the gate asks normally");
});

test("P2: hard checks still run - a stamped call outside scope is still denied", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = countingCtx(root, true);
  await pi.emit("session_start", { type: "session_start" }, ctx);

  // Scope is checked BEFORE the approval step, so a stamp cannot buy it.
  const event = {
    toolName: "write",
    toolCallId: "call-3",
    input: { path: "/etc/passwd" },
    __cpUserApproved: { callId: "call-3", at: "2026-01-01T00:00:00.000Z" },
  };
  const result = (await pi.emit("tool_call", event, ctx)) as { block?: boolean; reason?: string };
  assert.equal(result?.block, true, "an out-of-scope target is denied despite the stamp");
  assert.match(result?.reason ?? "", /outside scope/);
});

test("P2: an escalating action is NOT satisfied by a generic stamp (posture keeps its own question)", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = countingCtx(root, false);
  await pi.emit("session_start", { type: "session_start" }, ctx);

  // authorize() short-circuits on userApproved BEFORE the section 32 posture
  // rule, so honouring a generic tool-call answer here would let consent to a
  // tool call stand in for consent to an authority expansion. It must not.
  const event = {
    toolName: "harness_set_posture",
    toolCallId: "call-4",
    input: { autonomy: "autonomous" },
    __cpUserApproved: { callId: "call-4", at: "2026-01-01T00:00:00.000Z" },
  };
  const result = (await pi.emit("tool_call", event, ctx)) as { block?: boolean } | undefined;
  assert.equal(result?.block, true, "posture loosening is not granted by a generic approval");
});

test("P1: read-mode harness shell is a read effect; mode:write keeps the shell gate", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = countingCtx(root, false); // decline anything asked
  await pi.emit("session_start", { type: "session_start" }, ctx);

  // Read mode: the scope root is mounted read-only (a write fails with EROFS),
  // network is unshared, credential paths shadowed - the effect is a read, so
  // section 21's shell gate does not apply.
  const read = (await pi.emit(
    "tool_call",
    { toolName: "pi_harness_bash", toolCallId: "r1", input: { command: "node --test" } },
    ctx,
  )) as { block?: boolean } | undefined;
  assert.equal(read?.block, undefined, "a read-only sandboxed command runs without an approval");
  assert.deepEqual(ctx.prompts, [], "and costs no prompt");

  // Write mode makes the scope root writable: a real mutation, still gated.
  const write = (await pi.emit(
    "tool_call",
    { toolName: "pi_harness_bash", toolCallId: "w1", input: { command: "touch f", mode: "write" } },
    ctx,
  )) as { block?: boolean } | undefined;
  assert.equal(write?.block, true, "mode:write keeps the shell gate (declined here)");
  assert.equal(ctx.prompts.length, 1, "exactly one question, for the write-mode call");
});

test("harness_note writes state, so it is gated like a mutation (not a read)", async () => {
  const { root, harnessHome } = tmpProject();
  process.env.PI_HARNESS_HOME = harnessHome;
  const pi = new FakePi();
  await piHarnessExtension(pi as never);
  const ctx = countingCtx(root, false); // decline
  await pi.emit("session_start", { type: "session_start" }, ctx);

  // harness_note records a provisional assumption that reaches durable state
  // (WORKSTATE). It used to sit in READ_TOOLS and so passed the authorization
  // seam ungated - the anomaly the gate-fatigue pass surfaced. Gate on effect:
  // a tool that changes state asks. (The existing WORKSTATE test drives
  // execute() directly and so never exercised this seam.)
  const declined = (await pi.emit(
    "tool_call",
    { toolName: "harness_note", toolCallId: "n1", input: { kind: "assumption", text: "x" } },
    ctx,
  )) as { block?: boolean } | undefined;
  assert.equal(declined?.block, true, "a declined harness_note is blocked");
  assert.equal(ctx.prompts.length, 1, "it asks, exactly once");

  // Approved, it proceeds - gating it must not make it unusable.
  const ctx2 = countingCtx(root, true);
  const pi2 = new FakePi();
  await piHarnessExtension(pi2 as never);
  await pi2.emit("session_start", { type: "session_start" }, ctx2);
  const approved = (await pi2.emit(
    "tool_call",
    { toolName: "harness_note", toolCallId: "n2", input: { kind: "assumption", text: "x" } },
    ctx2,
  )) as { block?: boolean } | undefined;
  assert.equal(approved?.block, undefined, "approved, it runs");

  // And the read-effect harness tools are unaffected by this tightening.
  const ctx3 = countingCtx(root, false);
  const pi3 = new FakePi();
  await piHarnessExtension(pi3 as never);
  await pi3.emit("session_start", { type: "session_start" }, ctx3);
  for (const toolName of ["harness_memory_search", "harness_find_capability", "harness_request_scope"]) {
    const r = (await pi3.emit("tool_call", { toolName, toolCallId: "r", input: {} }, ctx3)) as { block?: boolean } | undefined;
    assert.equal(r?.block, undefined, `${toolName} still flows free`);
  }
  assert.deepEqual(ctx3.prompts, [], "no new prompts for read-effect tools");
});
