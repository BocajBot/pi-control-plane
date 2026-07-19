/**
 * Integration tests that load the real extension entry against a fake Pi API.
 * Covers wiring that pure-module tests cannot: attended confirmation flow,
 * interpretation guard lifecycle, command handling, restoration, and the
 * injected system-prompt block.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import controlPlaneExtension from "../extensions/control-plane.ts";
import { REQUIRED_SECTIONS } from "../src/control-plane/interpretation.ts";
import { STATE_ENTRY_TYPE, DIAGNOSTIC_ENTRY_TYPE } from "../src/control-plane/types.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  shortcuts = new Map<string, (ctx: unknown) => unknown>();
  entries: { type: string; customType: string; data: unknown }[] = [];
  sentUserMessages: string[] = [];
  activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];

  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
    this.commands.set(name, options);
  }
  registerShortcut(key: string, options: { handler: (ctx: unknown) => unknown }) {
    this.shortcuts.set(key, options.handler);
  }
  registerEntryRenderer() {}
  appendEntry(customType: string, data?: unknown) {
    this.entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data ?? null)) });
  }
  sendUserMessage(content: string) {
    this.sentUserMessages.push(content);
  }
  allToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"];
  getActiveTools() {
    return [...this.activeTools];
  }
  getAllTools() {
    return this.allToolNames.map((name) => ({ name, description: `${name} tool`, parameters: {}, sourceInfo: {} }));
  }
  setActiveTools(names: string[]) {
    this.activeTools = [...names];
  }
  getCommands() {
    return [];
  }
  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      const r = await handler(payload, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  }
}

interface FakeCtxOptions {
  cwd?: string;
  hasUI?: boolean;
  confirmResult?: boolean;
  branchEntries?: unknown[];
  contextFiles?: { path: string; content: string }[];
  systemPrompt?: string;
}

function makeCtx(options: FakeCtxOptions = {}) {
  const notifications: { message: string; type?: string }[] = [];
  const statuses: Record<string, string | undefined> = {};
  const widgets: Record<string, string[] | undefined> = {};
  const ctx = {
    notifications,
    statuses,
    widgets,
    hasUI: options.hasUI ?? true,
    cwd: options.cwd ?? process.cwd(),
    mode: "tui",
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      confirm: async () => options.confirmResult ?? false,
      setStatus: (key: string, text: string | undefined) => {
        statuses[key] = text;
      },
      setWidget: (key: string, content: string[] | undefined) => {
        widgets[key] = content;
      },
    },
    sessionManager: {
      getBranch: () => options.branchEntries ?? [],
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    getSystemPrompt: () => options.systemPrompt ?? "BASE SYSTEM PROMPT",
    getSystemPromptOptions: () => ({
      cwd: options.cwd ?? process.cwd(),
      contextFiles: options.contextFiles ?? [],
      skills: [],
    }),
    model: { id: "test-model", provider: "test-provider", contextWindow: 1000 },
    isIdle: () => true,
  };
  return ctx;
}

function tmpRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-harness-")));
}

async function boot(): Promise<FakePi> {
  const pi = new FakePi();
  await controlPlaneExtension(pi as never);
  return pi;
}

function validInterpretationResponse(): string {
  return REQUIRED_SECTIONS.map((s) => `## ${s}\ncontent for ${s}`).join("\n\n");
}

/** The interpretation turn must have started (before_agent_start fired) for agent_end to count. */
async function startInterpretTurn(pi: FakePi, ctx: unknown) {
  await pi.emit(
    "before_agent_start",
    { type: "before_agent_start", prompt: "p", systemPrompt: "SP", systemPromptOptions: { cwd: "/", contextFiles: [], skills: [] } },
    ctx,
  );
}

test("registers the five commands and three shortcuts", async () => {
  const pi = await boot();
  for (const name of ["context", "task", "phase", "autonomy", "interpret"]) {
    assert.ok(pi.commands.has(name), `missing /${name}`);
  }
  for (const key of ["alt+c", "alt+p", "alt+a"]) {
    assert.ok(pi.shortcuts.has(key), `missing shortcut ${key}`);
  }
});

test("defaults after session_start: Discuss + Read-only shown in status", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /CP: Discuss \| Read-only \| Task: none/);
});

test("write blocked in Discuss; read allowed", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /phase:discuss/);
  const readResult = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "read", input: { path: "f.txt" } },
    ctx,
  );
  assert.equal(readResult, undefined, "read must pass through");
});

test("Execute + Read-only still blocks writes; Execute + Attended denied confirmation blocks execution", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, confirmResult: false });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("phase")!.handler("execute", ctx);
  const stillBlocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  )) as { block?: boolean };
  assert.equal(stillBlocked?.block, true, "read-only must block writes even in Execute");

  await pi.commands.get("autonomy")!.handler("attended", ctx);
  const denied = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(denied?.block, true);
  assert.match(denied?.reason ?? "", /Denied by user confirmation/);
});

test("Execute + Attended approved confirmation allows the call; no-UI fails closed", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const approvingCtx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, approvingCtx);
  await pi.commands.get("phase")!.handler("execute", approvingCtx);
  await pi.commands.get("autonomy")!.handler("attended", approvingCtx);
  const allowed = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "f.txt", content: "x" } },
    approvingCtx,
  );
  assert.equal(allowed, undefined, "approved confirmation must not block");

  const noUiCtx = makeCtx({ cwd: root, hasUI: false });
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "write", input: { path: "f.txt", content: "x" } },
    noUiCtx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /failing closed/i);
});

test("/interpret guards the turn: all tools blocked, diagnostic recorded, state restored after", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("phase")!.handler("execute", ctx);
  await pi.commands.get("autonomy")!.handler("attended", ctx);

  await pi.commands.get("interpret")!.handler("Refactor the loader and encourage tool use", ctx);
  assert.equal(pi.sentUserMessages.length, 1);
  assert.match(ctx.statuses["control-plane"] ?? "", /INTERPRET/);

  // Even a read is blocked during interpretation, and a diagnostic is recorded.
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "f.txt" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /interpretation/i);
  assert.ok(pi.entries.some((e) => e.customType === DIAGNOSTIC_ENTRY_TYPE));

  // Model responds with a valid interpretation; guard lifts, phase/autonomy restored.
  await startInterpretTurn(pi, ctx);
  await pi.emit(
    "agent_end",
    {
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: validInterpretationResponse() }] }],
    },
    ctx,
  );
  assert.match(ctx.statuses["control-plane"] ?? "", /CP: Execute \| Attended \| Task: pending/);

  // Accept adopts the brief.
  await pi.commands.get("task")!.handler("accept", ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Task: set/);
  const write = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "read", input: { path: "f.txt" } },
    ctx,
  )) as { block?: boolean } | undefined;
  assert.equal(write, undefined, "guard must be lifted after interpretation completes");
});

test("invalid interpretation cannot be accepted", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("interpret")!.handler("do something", ctx);
  await startInterpretTurn(pi, ctx);
  await pi.emit(
    "agent_end",
    { type: "agent_end", messages: [{ role: "assistant", content: "## Objective\nonly this" }] },
    ctx,
  );
  await pi.commands.get("task")!.handler("accept", ctx);
  assert.ok(
    ctx.notifications.some((n) => /invalid/i.test(n.message) && /cannot be accepted/i.test(n.message)),
    "accept must be refused for invalid interpretations",
  );
  assert.match(ctx.statuses["control-plane"] ?? "", /Task: pending/);
});

test("a stale agent_end before the interpretation turn starts does not consume the guard", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("interpret")!.handler("do something", ctx);
  // A leftover agent_end from the previous turn arrives before the interpret turn begins.
  await pi.emit(
    "agent_end",
    { type: "agent_end", messages: [{ role: "assistant", content: "stale prior-turn response" }] },
    ctx,
  );
  assert.match(ctx.statuses["control-plane"] ?? "", /INTERPRET/, "guard must survive the stale agent_end");
  // The real interpretation turn then runs and completes normally.
  await startInterpretTurn(pi, ctx);
  await pi.emit(
    "agent_end",
    { type: "agent_end", messages: [{ role: "assistant", content: validInterpretationResponse() }] },
    ctx,
  );
  assert.doesNotMatch(ctx.statuses["control-plane"] ?? "", /INTERPRET/);
  assert.match(ctx.statuses["control-plane"] ?? "", /Task: pending/);
});

test("state restores across sessions from persisted entries (phase, autonomy, toggles)", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("phase")!.handler("plan", ctx);
  await pi.commands.get("autonomy")!.handler("attended", ctx);
  await pi.commands.get("context")!.handler("toggle tool:bash", ctx);
  assert.ok(!pi.activeTools.includes("bash"), "bash removed from active tools");

  // New process: fresh extension instance restores from the persisted entries.
  const pi2 = new (pi.constructor as new () => FakePi)();
  await controlPlaneExtension(pi2 as never);
  const ctx2 = makeCtx({ cwd: root, branchEntries: pi.entries.filter((e) => e.customType === STATE_ENTRY_TYPE) });
  await pi2.emit("session_start", { type: "session_start", reason: "resume" }, ctx2);
  assert.match(ctx2.statuses["control-plane"] ?? "", /CP: Plan \| Attended/);
  assert.ok(!pi2.activeTools.includes("bash"), "tool toggle reapplied after restore");
});

test("malformed persisted state falls back to safe defaults with a warning", async () => {
  const pi = await boot();
  const ctx = makeCtx({
    cwd: tmpRoot(),
    branchEntries: [
      { type: "custom", customType: STATE_ENTRY_TYPE, data: { schemaVersion: 1, phase: "execute", autonomy: "attended", bogus: true } },
    ],
  });
  await pi.emit("session_start", { type: "session_start", reason: "resume" }, ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /CP: Discuss \| Read-only/);
  assert.ok(ctx.notifications.some((n) => /malformed/i.test(n.message)));
});

test("sandboxed resolves to Restricted with the required warning and honest status", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("autonomy")!.handler("sandboxed", ctx);
  assert.ok(
    ctx.notifications.some((n) => /not a security sandbox/i.test(n.message)),
    "sandbox warning required",
  );
  assert.match(ctx.statuses["control-plane"] ?? "", /Restricted/);
  assert.doesNotMatch(ctx.statuses["control-plane"] ?? "", /Sandboxed/);
});

test("injected system prompt carries the control-plane block and applies verified file toggles", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({
    cwd: root,
    contextFiles: [{ path: `${root}/AGENTS.md`, content: "AGENTS FILE CONTENT" }],
  });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("context")!.handler(`toggle file:${root}/AGENTS.md`, ctx);

  const result = (await pi.emit(
    "before_agent_start",
    {
      type: "before_agent_start",
      prompt: "user prompt",
      systemPrompt: "BASE PROMPT\nAGENTS FILE CONTENT\nEND",
      systemPromptOptions: { cwd: root, contextFiles: [{ path: `${root}/AGENTS.md`, content: "AGENTS FILE CONTENT" }], skills: [] },
    },
    ctx,
  )) as { systemPrompt?: string };
  assert.ok(result?.systemPrompt?.includes("[PI CONTROL PLANE]"));
  assert.ok(result?.systemPrompt?.includes("Phase: Discuss"));
  assert.ok(!result?.systemPrompt?.includes("AGENTS FILE CONTENT"), "disabled file must be excised");
});

test("failed excision re-enables the source and warns (never silently claims disabled)", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const filePath = `${root}/AGENTS.md`;
  const ctx = makeCtx({ cwd: root, contextFiles: [{ path: filePath, content: "CONTENT NOT IN PROMPT" }] });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("context")!.handler(`toggle file:${filePath}`, ctx);
  await pi.emit(
    "before_agent_start",
    {
      type: "before_agent_start",
      prompt: "p",
      systemPrompt: "PROMPT WITHOUT THAT CONTENT",
      systemPromptOptions: { cwd: root, contextFiles: [{ path: filePath, content: "CONTENT NOT IN PROMPT" }], skills: [] },
    },
    ctx,
  );
  assert.ok(ctx.notifications.some((n) => /could not verifiably exclude/i.test(n.message)));
});

test("unknown toggle target produces an actionable error, not a state change", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("context")!.handler("toggle definitely-not-a-source", ctx);
  assert.ok(ctx.notifications.some((n) => /unknown source/i.test(n.message)));
});

test("/task clear force clears without UI; /task set stores objective only", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot(), hasUI: false });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("task")!.handler("set build the thing", ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Task: set/);
  await pi.commands.get("task")!.handler("clear", ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Task: set/, "clear without force and without UI must not clear");
  await pi.commands.get("task")!.handler("clear force", ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Task: none/);
});

test("context overlay: /context restore with no override says so; alt+e registered", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.ok(pi.shortcuts.has("alt+e"), "alt+e shortcut registered");
  await pi.commands.get("context")!.handler("restore", ctx);
  assert.ok(ctx.notifications.some((n) => /no context override/i.test(n.message)));
});

test("alt+h and alt+s registered; alt+h without modal support falls back to chat output", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.ok(pi.shortcuts.has("alt+h"));
  assert.ok(pi.shortcuts.has("alt+s"));
  assert.ok(pi.shortcuts.has("alt+t"));
  await pi.shortcuts.get("alt+h")!(ctx);
  const output = pi.entries.find((e) => e.customType === "pi-control-plane-output");
  assert.ok(output, "cheat sheet emitted as chat entry when no modal UI exists");
  assert.ok(JSON.stringify(output!.data).includes("alt+e"));
});

test("/context profile applies loadouts, lists them, and 'all' restores", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

  await pi.commands.get("context")!.handler("profile minimal", ctx);
  assert.ok(!pi.activeTools.includes("web_search"), "profile must remove unlisted tools");
  assert.ok(pi.activeTools.includes("bash"));
  assert.ok(ctx.notifications.some((n) => /Profile "minimal"/.test(n.message)));

  await pi.commands.get("context")!.handler("profile", ctx);
  const listing = pi.entries.filter((e) => e.customType === "pi-control-plane-output").at(-1);
  const listingText = JSON.stringify(listing?.data);
  assert.ok(/minimal/.test(listingText) && /reading/.test(listingText) && /Active: minimal/.test(listingText));

  await pi.commands.get("context")!.handler("profile all", ctx);
  assert.ok(pi.activeTools.includes("web_search"), "'all' re-enables everything");

  await pi.commands.get("context")!.handler("profile bogus", ctx);
  assert.ok(ctx.notifications.some((n) => /Unknown profile "bogus"/.test(n.message)));
});

test("applied profile persists and is restored in a new session", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("context")!.handler("profile reading", ctx);
  assert.deepEqual([...pi.activeTools].sort(), ["find", "grep", "ls", "read"]);

  const pi2 = new (pi.constructor as new () => FakePi)();
  await controlPlaneExtension(pi2 as never);
  const ctx2 = makeCtx({ cwd: root, branchEntries: pi.entries.filter((e) => e.customType === STATE_ENTRY_TYPE) });
  await pi2.emit("session_start", { type: "session_start", reason: "resume" }, ctx2);
  assert.deepEqual([...pi2.activeTools].sort(), ["find", "grep", "ls", "read"], "profile toggles reapplied on restore");
});

test("phase and autonomy cycle hotkeys advance in order", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /CP: Plan/);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /CP: Execute/);
  await pi.shortcuts.get("alt+a")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Attended/);
});
