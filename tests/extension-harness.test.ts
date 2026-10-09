/**
 * Integration tests that load the real extension entry against a fake Pi API.
 * Covers wiring that pure-module tests cannot: attended confirmation flow,
 * command handling, restoration, and the injected system-prompt block.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import controlPlaneExtension, {
  buildDiagnosticEntry,
  clampBodyLines,
  describeDiagnostic,
  formatConfirmDetail,
  formatDiagnosticLine,
  safeDialogWidth,
} from "../extensions/control-plane.ts";
import { STATE_ENTRY_TYPE, DIAGNOSTIC_ENTRY_TYPE } from "../src/control-plane/types.ts";

// Harness must never contact a real billing account inherited from the shell.
const savedCreditEnv = ["OPENROUTER_API_KEY", "OPENROUTER_MANAGEMENT_KEY"].map((key) => [key, process.env[key]] as const);
test.before(() => { for (const [key] of savedCreditEnv) delete process.env[key]; });
test.after(() => { for (const [key, value] of savedCreditEnv) { if (value !== undefined) process.env[key] = value; } });

type Handler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  shortcuts = new Map<string, (ctx: unknown) => unknown>();
  /** Loosely typed: this test double only needs enough of ToolDefinition's
   * shape to invoke a tool's execute() from a test, not the full pi type. */
  tools = new Map<string, { name: string; execute: (...args: unknown[]) => unknown }>();
  entries: { type: string; customType: string; data: unknown }[] = [];
  sentUserMessages: string[] = [];
  sentMessages: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
  sendMessage(message: { customType: string; content: string; display: boolean }, options: unknown) {
    this.sentMessages.push({ message, options });
  }
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
  registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) {
    this.tools.set(tool.name, tool);
    if (!this.activeTools.includes(tool.name)) this.activeTools.push(tool.name);
  }
  registerEntryRenderer() {}
  appendEntry(customType: string, data?: unknown) {
    this.entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data ?? null)) });
  }
  sendUserMessage(content: string) {
    this.sentUserMessages.push(content);
  }
  // Includes a couple of extras beyond what any shipped profile lists (like
  // local_web_search and todo, standing in for other installed extensions'
  // tools) so "minimal" and "all minus alwaysDisabledTools" are never
  // coincidentally the same set here, the way they would be in a toy
  // universe of exactly minimal's own tools + one extra.
  allToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "local_web_search", "transcribe_audio", "todo"];
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
  /** When true, ctx.ui.custom is provided (an interactive session with the
   * custom-component primitive). It resolves `customChoice` (default null =
   * escape) WITHOUT invoking the factory, so the real SelectList is never
   * needed in tests. */
  withCustom?: boolean;
  customChoice?: string | null;
  /** Queue of scripted ui.custom results, consumed in order (dialog →
   * recorder → …). Falls back to null once exhausted. Takes precedence over
   * `customChoice`. */
  customChoices?: (string | null)[];
}

function makeCtx(options: FakeCtxOptions = {}) {
  const notifications: { message: string; type?: string }[] = [];
  const statuses: Record<string, string | undefined> = {};
  const widgets: Record<string, string[] | undefined> = {};
  const customCalls: unknown[] = [];
  const ui: Record<string, unknown> = {
    notify: (message: string, type?: string) => notifications.push({ message, type }),
    confirm: async () => options.confirmResult ?? false,
    setStatus: (key: string, text: string | undefined) => {
      statuses[key] = text;
    },
    setWidget: (key: string, content: string[] | undefined) => {
      widgets[key] = content;
    },
  };
  if (options.withCustom) {
    // Resolve the scripted choice without invoking the factory (so the real
    // SelectList never has to load under the test harness).
    const queue = options.customChoices;
    ui.custom = async (factory: unknown) => {
      customCalls.push(factory);
      if (queue !== undefined) return queue.length > 0 ? queue.shift() : null;
      return options.customChoice === undefined ? null : options.customChoice;
    };
  }
  const ctx = {
    notifications,
    statuses,
    widgets,
    customCalls,
    hasUI: options.hasUI ?? true,
    cwd: options.cwd ?? process.cwd(),
    mode: "tui",
    ui,
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

/**
 * File-scoped fake pi agent dir. The keybind-consent flow must never touch
 * the real ~/.pi/agent from tests, and its consent dialog must not inject
 * ui.custom calls into unrelated tests: seeding keep-pi-defaults here makes
 * every default boot a silent no-op. Tests that exercise the consent flow
 * override PI_CODING_AGENT_DIR with their own fresh temp dir and restore it.
 */
const harnessAgentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-harness-agent-")));
fs.writeFileSync(
  path.join(harnessAgentDir, "control-plane-keys.json"),
  JSON.stringify({ version: 1, decision: "keep-pi-defaults", decidedAt: new Date().toISOString() }),
);
test.after(() => fs.rmSync(harnessAgentDir, { recursive: true, force: true }));

async function boot(): Promise<FakePi> {
  // Default to the seeded fake agent dir unless the test set its own.
  process.env.PI_CODING_AGENT_DIR ??= harnessAgentDir;
  const pi = new FakePi();
  await controlPlaneExtension(pi as never);
  return pi;
}

test("registers the commands, the local_web_search tool, and the shortcuts", async () => {
  const pi = await boot();
  for (const name of ["clear", "context", "mode", "scratchpad", "bwrap", "harness-rules", "task", "control-keys"]) {
    assert.ok(pi.commands.has(name), `missing /${name}`);
  }
  assert.ok(!pi.commands.has("phase") && !pi.commands.has("autonomy"), "phase/autonomy merged into /mode");
  assert.ok(pi.tools.has("local_web_search"), "local_web_search tool not registered");
  for (const key of ["alt+c", "alt+p"]) {
    assert.ok(pi.shortcuts.has(key), `missing shortcut ${key}`);
  }
});

test("ctrl+alt+r dispatches reload as a command, not a model prompt, and refuses while busy", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  const sent: { text: string; options: unknown }[] = [];
  pi.sendUserMessage = (text: string, options?: unknown) => { sent.push({ text, options }); };
  let reloads = 0;
  const commandCtx = { ...ctx, reload: async () => { reloads++; } };

  await pi.shortcuts.get("ctrl+alt+r")!(ctx);
  assert.deepEqual(sent, [{ text: "/control-reload", options: { expandPromptTemplates: true } }]);
  assert.equal(reloads, 0, "shortcut dispatch is not itself a completed reload");
  await pi.commands.get(sent[0].text.slice(1))!.handler("", commandCtx);
  assert.equal(reloads, 1);

  ctx.isIdle = () => false;
  await pi.shortcuts.get("ctrl+alt+r")!(ctx);
  assert.equal(sent.length, 1, "busy shortcut must not queue a prompt");
  await pi.commands.get("control-reload")!.handler("", { ...commandCtx, isIdle: () => false });
  assert.equal(reloads, 1, "command rechecks idle state");
  assert.ok(ctx.notifications.some((n) => /busy/.test(n.message)));
});

test("/clear starts a fresh session as an alias for /new", async () => {
  const pi = await boot();
  const ctx = makeCtx();
  let newSessions = 0;
  Object.assign(ctx, {
    newSession: async () => {
      newSessions++;
      return { cancelled: false };
    },
  });

  await pi.commands.get("clear")!.handler("", ctx);

  assert.equal(newSessions, 1);
});

test("defaults after session_start: a fresh session opens in Auto without confirmation", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot(), confirmResult: false });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Auto/);
  const result = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "fresh-shell", toolName: "bash", input: { command: "pwd" } },
    ctx,
  );
  assert.equal(result, undefined, "fresh Auto authorizes shell even when confirmation would be denied");
});

test("write blocked in Discuss; read allowed", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("discuss", ctx);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /phase:plan/);
  const readResult = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "read", input: { path: "f.txt" } },
    ctx,
  );
  assert.equal(readResult, undefined, "read must pass through");
});

test("Execute (attended) denied confirmation blocks execution", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, confirmResult: false });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const denied = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(denied?.block, true);
  assert.match(denied?.reason ?? "", /Denied by user confirmation/);
});

test("Execute (attended) approved confirmation allows the call; no-UI fails closed", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const approvingCtx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, approvingCtx);
  await pi.commands.get("mode")!.handler("execute", approvingCtx);
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

// ---- attended phase-switch dialog ----
// When a mutating call is blocked SOLELY by the phase rule in an interactive
// session, the human is offered the same transition as /mode execute. It is
// user-actor authority and grants no model actor new capability; autonomy still
// gates the actual mutation independently (the attended per-call confirm).
//
// Note on the "autonomy would still prohibit after the switch" fallback in the
// handler: under the merged phase/autonomy model, /mode execute yields Execute +
// Attended, and Attended never hard-blocks a mutating tool (it confirms). So the
// postSwitch === "block" fallback is defensively coded but structurally
// unreachable via this dialog; the real manifestation of "autonomy gates
// independently" is the second confirm exercised in the third test below.

/** Script ui.confirm by dialog title so the two gates can be answered separately. */
function scriptConfirm(ctx: ReturnType<typeof makeCtx>, answers: Record<string, boolean>, titles: string[]) {
  ctx.ui.confirm = (async (title: string) => {
    titles.push(title);
    return answers[title] ?? false;
  }) as typeof ctx.ui.confirm;
}

test("phase-switch dialog: approve switch + approve call → proceeds, audited as user", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("discuss", ctx);
  const titles: string[] = [];
  scriptConfirm(ctx, { "Switch to Execute phase?": true, "Allow write?": true }, titles);
  const result = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  );
  assert.equal(result, undefined, "approved switch + approved call must proceed");
  // Two independent gates fired in order: the phase switch, then the attended
  // per-call confirm — one Yes did not grant the mutation.
  assert.deepEqual(titles, ["Switch to Execute phase?", "Allow write?"]);
  assert.match(ctx.statuses["control-plane"] ?? "", /Manual/);
  const audit = pi.entries.find(
    (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "phase-switch-via-dialog",
  );
  assert.ok(audit, "phase switch must be audited");
  const d = audit!.data as Record<string, unknown>;
  assert.equal(d.actor, "user");
  assert.equal(d.provenance, "attended-phase-dialog");
  assert.equal(d.from, "plan");
  assert.equal(d.to, "manual");
  assert.equal(d.blockedTool, "write");
  assert.equal(d.blockedRule, "phase:plan");
});

test("phase-switch dialog: decline switch → identical plain block, no phase change", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("discuss", ctx);
  const titles: string[] = [];
  scriptConfirm(ctx, { "Switch to Execute phase?": false }, titles);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /phase:plan/, "declined switch blocks exactly as today");
  assert.deepEqual(titles, ["Switch to Execute phase?"], "no per-call confirm after a declined switch");
  assert.match(ctx.statuses["control-plane"] ?? "", /Plan/, "phase must not change on decline");
  assert.ok(
    !pi.entries.some(
      (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "phase-switch-via-dialog",
    ),
    "a declined switch must not be audited as a switch",
  );
});

test("phase-switch dialog: approve switch but decline the call → switched yet blocked (autonomy gates independently)", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("discuss", ctx);
  const titles: string[] = [];
  scriptConfirm(ctx, { "Switch to Execute phase?": true, "Allow write?": false }, titles);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true, "the mutation is still independently gated by autonomy");
  assert.match(blocked?.reason ?? "", /Denied by user confirmation/);
  assert.deepEqual(titles, ["Switch to Execute phase?", "Allow write?"]);
  // The switch did happen (it is a real phase change), it just did not authorize
  // the mutation — the per-call confirm did that job separately.
  assert.match(ctx.statuses["control-plane"] ?? "", /Manual/);
  assert.ok(
    pi.entries.some(
      (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "phase-switch-via-dialog",
    ),
    "the approved switch is audited even though the call was then declined",
  );
});

test("phase-switch dialog: no-UI session gets the plain block, never a dialog", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot(), hasUI: false });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("discuss", ctx);
  const titles: string[] = [];
  scriptConfirm(ctx, {}, titles);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /phase:plan/);
  assert.deepEqual(titles, [], "no confirmation dialog without a UI");
});

// ---- read-before-edit (hard rule) ----
// An edit/write of an EXISTING file must have read that exact file this session
// (and it must be unchanged on disk since — except by this session's own
// successful edit/write, which restamps the credit instead of demanding a
// re-read). New files are exempt; the rule
// preempts the attended confirm and the phase-switch dialog. Each denial is
// audited. Read credit is per control-plane activation, so a separate session
// (an isolated delegate/operator) inherits none.

const findRbeAudit = (pi: FakePi) =>
  pi.entries.find(
    (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "blocked-read-before-edit",
  );

test("read-before-edit: a blind edit of an existing file is blocked and audited, before any confirm", async () => {
  const pi = await boot();
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "data.txt"), "original\n");
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const titles: string[] = [];
  scriptConfirm(ctx, { "Allow edit?": true }, titles);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "data.txt", oldText: "original", newText: "changed" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /Rule: read-before-edit\b/);
  assert.match(blocked?.reason ?? "", /read .*data\.txt first/);
  assert.deepEqual(titles, [], "a blind edit is refused before any confirmation dialog");
  const audit = findRbeAudit(pi);
  assert.ok(audit, "blind edit must be audited");
  assert.equal((audit!.data as { stale?: boolean }).stale, false);
});

test("read-before-edit: reading the file first lets the edit through", async () => {
  const pi = await boot();
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "data.txt"), "original\n");
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const readResult = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "data.txt" } },
    ctx,
  );
  assert.equal(readResult, undefined, "the read itself passes through");
  const editResult = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "data.txt", oldText: "original", newText: "changed" } },
    ctx,
  );
  assert.equal(editResult, undefined, "an edit after reading the file proceeds (subject to the attended confirm)");
  assert.ok(!findRbeAudit(pi), "no read-before-edit denial when the file was read first");
});

test("read-before-edit: an external change after the read forces a re-read", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const file = path.join(root, "data.txt");
  fs.writeFileSync(file, "original\n");
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "data.txt" } }, ctx);
  // Simulate an external modification (another session or the user): bump mtime.
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(file, later, later);
  const stale = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "data.txt", oldText: "original", newText: "changed" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(stale?.block, true, "an external change since the read blocks the edit");
  assert.match(stale?.reason ?? "", /Rule: read-before-edit:stale/);
  assert.equal((findRbeAudit(pi)!.data as { stale?: boolean }).stale, true);
  // Re-reading clears the staleness; the edit then proceeds.
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "3", toolName: "read", input: { path: "data.txt" } }, ctx);
  const ok = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "4", toolName: "edit", input: { path: "data.txt", oldText: "original", newText: "changed" } },
    ctx,
  );
  assert.equal(ok, undefined, "re-reading after the external change lets the edit through");
});

test("read-before-edit: this session's own completed edit does not demand a re-read", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const file = path.join(root, "data.txt");
  fs.writeFileSync(file, "original\n");
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "data.txt" } }, ctx);
  const first = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "data.txt", oldText: "original", newText: "changed" } },
    ctx,
  );
  assert.equal(first, undefined, "edit after reading proceeds");
  // The permitted edit ran: the file on disk now reflects it (mtime moved).
  fs.writeFileSync(file, "changed\n");
  await pi.emit(
    "tool_result",
    { type: "tool_result", toolCallId: "2", toolName: "edit", input: { path: "data.txt" }, isError: false, content: [] },
    ctx,
  );
  const second = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "3", toolName: "edit", input: { path: "data.txt", oldText: "changed", newText: "changed again" } },
    ctx,
  );
  assert.equal(second, undefined, "a follow-up edit is not refused: the session's own edit is not staleness");
  assert.ok(!findRbeAudit(pi), "no read-before-edit denial for the model's own completed edit");
});

test("read-before-edit: a FAILED edit does not restamp credit — a partially-applied change still forces a re-read", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const file = path.join(root, "data.txt");
  fs.writeFileSync(file, "original\n");
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "data.txt" } }, ctx);
  await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "data.txt", oldText: "original", newText: "changed" } },
    ctx,
  );
  // The errored edit managed to touch the disk before failing.
  fs.writeFileSync(file, "partial\n");
  await pi.emit(
    "tool_result",
    { type: "tool_result", toolCallId: "2", toolName: "edit", input: { path: "data.txt" }, isError: true, content: [] },
    ctx,
  );
  const stale = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "3", toolName: "edit", input: { path: "data.txt", oldText: "partial", newText: "changed" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(stale?.block, true, "an errored edit's on-disk change is not treated as the session's own");
  assert.match(stale?.reason ?? "", /Rule: read-before-edit:stale/);
});

test("read-before-edit: a completed write does not grant read credit for a never-read file", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const first = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "brand-new.txt", content: "hello\n" } },
    ctx,
  );
  assert.equal(first, undefined, "creating a new file is exempt (nothing to read)");
  // The write executed and completed successfully.
  fs.writeFileSync(path.join(root, "brand-new.txt"), "hello\n");
  await pi.emit(
    "tool_result",
    { type: "tool_result", toolCallId: "1", toolName: "write", input: { path: "brand-new.txt" }, isError: false, content: [] },
    ctx,
  );
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "brand-new.txt", oldText: "hello", newText: "hi" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true, "editing a file this session created but never read is still gated");
  assert.match(blocked?.reason ?? "", /Rule: read-before-edit\b/);
});

test("read-before-edit: creating a new file needs no prior read", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const result = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "brand-new.txt", content: "hello\n" } },
    ctx,
  );
  assert.equal(result, undefined, "writing a file that does not exist is exempt (nothing to read)");
  assert.ok(!findRbeAudit(pi), "creating a new file is not a read-before-edit denial");
});

test("read-before-edit: read credit does not cross sessions (a delegate/operator inherits none)", async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "shared.txt"), "x\n");
  // Session 1 reads the file — credit accrues to this activation's read-set only.
  const pi1 = await boot();
  const ctx1 = makeCtx({ cwd: root });
  await pi1.emit("session_start", { type: "session_start", reason: "startup" }, ctx1);
  await pi1.commands.get("mode")!.handler("execute", ctx1);
  await pi1.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "shared.txt" } }, ctx1);
  // Session 2 is a separate activation (e.g. an isolated delegate) that never
  // read the file; it must not ride session 1's read credit.
  const pi2 = await boot();
  const ctx2 = makeCtx({ cwd: root, confirmResult: true });
  await pi2.emit("session_start", { type: "session_start", reason: "startup" }, ctx2);
  await pi2.commands.get("mode")!.handler("execute", ctx2);
  const blocked = (await pi2.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "shared.txt", oldText: "x", newText: "y" } },
    ctx2,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true, "session 2 never read the file, so its edit is blocked");
  assert.match(blocked?.reason ?? "", /Rule: read-before-edit\b/);
});

// ---- backup-before-edit (hard rule) ----
// A mutation of an EXISTING file must snapshot its pre-mutation bytes to a
// durable location before it proceeds. Fails closed: if the snapshot cannot be
// written, the mutation is refused. New files are exempt. The backup root is
// pointed at a per-test tmp dir via PI_BACKUP_DIR so the tests never touch the
// real ~/.pi/backups.

const findBackupAudit = (pi: FakePi) =>
  pi.entries.find(
    (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "backup-before-edit",
  );
const findBackupFailedAudit = (pi: FakePi) =>
  pi.entries.find(
    (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "backup-before-edit-failed",
  );

/** Boot a control plane whose backup root is an isolated tmp dir. */
async function bootWithBackupRoot(): Promise<{ pi: FakePi; backupRoot: string }> {
  const backupRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cp-backup-")));
  const prev = process.env.PI_BACKUP_DIR;
  process.env.PI_BACKUP_DIR = backupRoot;
  try {
    const pi = await boot();
    return { pi, backupRoot };
  } finally {
    if (prev === undefined) delete process.env.PI_BACKUP_DIR;
    else process.env.PI_BACKUP_DIR = prev;
  }
}

test("backup-before-edit: a blind edit is still blocked by read-before-edit (backup never reached)", async () => {
  const { pi, backupRoot } = await bootWithBackupRoot();
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "data.txt"), "original\n");
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "data.txt", oldText: "original", newText: "changed" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /Rule: read-before-edit\b/);
  // The backup step is downstream of read-before-edit, so no backup was taken.
  assert.ok(!findBackupAudit(pi), "no backup diagnostic when read-before-edit blocks first");
  assert.equal(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).length : 0, 0, "no backup file written");
});

test("backup-before-edit: read then edit snapshots the pre-edit bytes and proceeds", async () => {
  const { pi, backupRoot } = await bootWithBackupRoot();
  const root = tmpRoot();
  const file = path.join(root, "data.txt");
  const PRE = "original-content\n";
  fs.writeFileSync(file, PRE);
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "data.txt" } }, ctx);
  const editResult = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "data.txt", oldText: "original-content", newText: "changed-content" } },
    ctx,
  );
  assert.equal(editResult, undefined, "an edit after reading proceeds (backup succeeded)");
  const audit = findBackupAudit(pi);
  assert.ok(audit, "a backup-before-edit diagnostic must be emitted");
  const d = audit!.data as { target: string; backupPath: string; bytes: number };
  assert.equal(d.target, file);
  // The snapshot must hold the PRE-mutation bytes, byte for byte.
  assert.equal(fs.readFileSync(d.backupPath, "utf8"), PRE);
  assert.equal(d.bytes, Buffer.byteLength(PRE));
  assert.ok(d.backupPath.startsWith(backupRoot), "backup lives under the configured backup root");
});

test("backup-before-edit: writing a NEW file is exempt (no backup, no diagnostic)", async () => {
  const { pi, backupRoot } = await bootWithBackupRoot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const result = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "brand-new.txt", content: "hello\n" } },
    ctx,
  );
  assert.equal(result, undefined, "creating a new file proceeds (nothing to back up)");
  assert.ok(!findBackupAudit(pi), "no backup diagnostic for a new file");
  assert.equal(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).length : 0, 0, "no backup written for a new file");
});

test("backup-before-edit: a failed snapshot warns and proceeds (edit not blocked), recording a diagnostic", async () => {
  const { pi, backupRoot } = await bootWithBackupRoot();
  const root = tmpRoot();
  const file = path.join(root, "data.txt");
  const PRE = "keep-me\n";
  fs.writeFileSync(file, PRE);
  // Make the backup root unwritable so copyFileSync throws (EACCES). Use the
  // helper's returned backupRoot (NOT process.env.PI_BACKUP_DIR, which the
  // helper already restored in its finally and is therefore undefined here).
  fs.chmodSync(backupRoot, 0o555); // r-x: cannot create subdirs/files
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  try {
    await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await pi.commands.get("mode")!.handler("execute", ctx);
    await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "data.txt" } }, ctx);
    const result = (await pi.emit(
      "tool_call",
      { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "data.txt", oldText: "keep-me", newText: "nope" } },
      ctx,
    )) as { block?: boolean; reason?: string } | undefined;
    // Warn-and-proceed: a failed pre-image snapshot no longer fails closed. In a
    // git repo the working tree already holds the pre-image; blocking here mostly
    // duplicated git while interrupting flow.
    assert.notEqual(result?.block, true, "a failed backup must NOT block the mutation anymore");
    const failed = findBackupFailedAudit(pi);
    assert.ok(failed, "a backup-before-edit-failed diagnostic must still be emitted (audit trail)");
    assert.ok(
      ctx.notifications.some((n) => n.type === "warning" && /backup-before-edit/.test(n.message)),
      "the user must be warned that the pre-image could not be taken",
    );
  } finally {
    fs.chmodSync(backupRoot, 0o755); // restore so cleanup can remove it
  }
});

test("backup-before-edit: external change after read is blocked by stale first; re-read then edit backs up the NEW content", async () => {
  const { pi } = await bootWithBackupRoot();
  const root = tmpRoot();
  const file = path.join(root, "data.txt");
  fs.writeFileSync(file, "v1\n");
  const ctx = makeCtx({ cwd: root, confirmResult: true });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "data.txt" } }, ctx);
  // External modification after the read.
  fs.writeFileSync(file, "v2-external\n");
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(file, later, later);
  const stale = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "data.txt", oldText: "v1", newText: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(stale?.block, true);
  assert.match(stale?.reason ?? "", /read-before-edit:stale/);
  assert.ok(!findBackupAudit(pi), "no backup when stale blocks first");
  // Re-read (now sees v2), then edit: the backup must capture v2, not v1.
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "3", toolName: "read", input: { path: "data.txt" } }, ctx);
  const ok = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "4", toolName: "edit", input: { path: "data.txt", oldText: "v2-external", newText: "v3" } },
    ctx,
  );
  assert.equal(ok, undefined);
  const audit = findBackupAudit(pi);
  assert.ok(audit, "a backup is taken after the re-read");
  assert.equal(fs.readFileSync((audit!.data as { backupPath: string }).backupPath, "utf8"), "v2-external\n");
});

test("backup-before-edit: an unattended allowed mutation still produces a backup", async () => {
  const { pi } = await bootWithBackupRoot();
  const root = tmpRoot();
  const file = path.join(root, "data.txt");
  fs.writeFileSync(file, "unattn\n");
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute-restricted", ctx);
  await pi.commands.get("mode")!.handler("unattended", ctx);
  // Unattended read is allowed (reads are not gated); it earns read credit.
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "data.txt" } }, ctx);
  const result = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "data.txt", oldText: "unattn", newText: "done" } },
    ctx,
  )) as { block?: boolean; reason?: string } | undefined;
  assert.equal(result?.block, undefined, "an unattended allowed edit must proceed (backup succeeded)");
  const audit = findBackupAudit(pi);
  assert.ok(audit, "the rule applies in unattended mode, not just attended");
  assert.equal(fs.readFileSync((audit!.data as { backupPath: string }).backupPath, "utf8"), "unattn\n");
});

test("backup-before-edit: no cross-session inheritance (a second activation takes its own backup)", async () => {
  const root = tmpRoot();
  const file = path.join(root, "shared.txt");
  fs.writeFileSync(file, "x\n");
  // Two separate activations, each with its OWN isolated backup root.
  const { pi: pi1, backupRoot: root1 } = await bootWithBackupRoot();
  const ctx1 = makeCtx({ cwd: root, confirmResult: true });
  await pi1.emit("session_start", { type: "session_start", reason: "startup" }, ctx1);
  await pi1.commands.get("mode")!.handler("execute", ctx1);
  await pi1.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "shared.txt" } }, ctx1);
  const ok1 = await pi1.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "shared.txt", oldText: "x", newText: "y" } },
    ctx1,
  );
  assert.equal(ok1, undefined);
  const audit1 = findBackupAudit(pi1)!;
  const tag1 = (audit1.data as { sessionTag: string }).sessionTag;
  assert.ok(fs.existsSync((audit1.data as { backupPath: string }).backupPath), "session 1 wrote its own backup");

  // Session 2 is a fresh activation with a different tag and its own root.
  const { pi: pi2, backupRoot: root2 } = await bootWithBackupRoot();
  assert.notEqual(root1, root2, "each activation gets an isolated backup root in this test");
  const ctx2 = makeCtx({ cwd: root, confirmResult: true });
  await pi2.emit("session_start", { type: "session_start", reason: "startup" }, ctx2);
  await pi2.commands.get("mode")!.handler("execute", ctx2);
  await pi2.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "shared.txt" } }, ctx2);
  const ok2 = await pi2.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "shared.txt", oldText: "y", newText: "z" } },
    ctx2,
  );
  assert.equal(ok2, undefined);
  const audit2 = findBackupAudit(pi2)!;
  const tag2 = (audit2.data as { sessionTag: string }).sessionTag;
  assert.notEqual(tag1, tag2, "each activation mints its own session tag");
  assert.ok(fs.existsSync((audit2.data as { backupPath: string }).backupPath), "session 2 wrote its own backup");
});

// ---- Decision B: record declined out-of-scope reads ----
// A read outside the project root prompts (attended:read-outside-root); on a
// decline it is recorded as a control-plane diagnostic so a refused read is a
// first-class event, not just an inline block reason. Approved reads record no
// denial (no double-count). This is control-plane's own log; by AU1 + the
// tool_call short-circuit it does not reach the harness tamper-evident chain.

const findReadDenied = (pi: FakePi) =>
  pi.entries.find(
    (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "read-out-of-scope-denied",
  );

test("Decision B: a declined out-of-scope read is recorded as a control-plane diagnostic", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const outsideFile = path.join(tmpRoot(), "secret.txt");
  fs.writeFileSync(outsideFile, "secret\n");
  const ctx = makeCtx({ cwd: root, confirmResult: false }); // decline the prompt
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx); // attended
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: outsideFile } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /read-outside-root/);
  const rec = findReadDenied(pi);
  assert.ok(rec, "a declined out-of-scope read must be recorded");
  assert.equal((rec!.data as { target?: string }).target, outsideFile);
  assert.equal((rec!.data as { rule?: string }).rule, "attended:read-outside-root");
});

test("Decision B: an approved out-of-scope read records no denial (no double-count)", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const outsideFile = path.join(tmpRoot(), "secret.txt");
  fs.writeFileSync(outsideFile, "secret\n");
  const ctx = makeCtx({ cwd: root, confirmResult: true }); // approve the prompt
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const result = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: outsideFile } },
    ctx,
  );
  assert.equal(result, undefined, "an approved out-of-scope read proceeds");
  assert.ok(!findReadDenied(pi), "an approved read must not be recorded as a denial");
});

// ---- Part 1: reads free by default (out-of-scope non-sensitive reads) ----
// An out-of-project read no longer prompts unless it hits the sensitive-path
// denylist. In-scope reads were already silent; this only touches the
// out-of-root read confirm.

test("Part 1: an out-of-scope non-sensitive read is allowed without a prompt", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const outsideFile = path.join(tmpRoot(), "notes.txt");
  fs.writeFileSync(outsideFile, "hi\n");
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx); // attended
  const titles: string[] = [];
  scriptConfirm(ctx, {}, titles);
  const result = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: outsideFile } },
    ctx,
  );
  assert.equal(result, undefined, "a non-sensitive out-of-scope read is allowed silently");
  assert.deepEqual(titles, [], "no confirmation prompt for a normal read");
});

test("Part 1: an out-of-scope sensitive read still prompts (exfil gate held)", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const outsideEnv = path.join(tmpRoot(), ".env");
  fs.writeFileSync(outsideEnv, "SECRET=1\n");
  const ctx = makeCtx({ cwd: root, confirmResult: false });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const titles: string[] = [];
  scriptConfirm(ctx, { "Allow read?": false }, titles);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: outsideEnv } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true, "a declined sensitive read is blocked");
  assert.deepEqual(titles, ["Allow read?"], "a sensitive read still prompts");
});

// ---- Part 3: remembered decisions (soft-policy rules) ----
// A saved rule (via /harness-rules allow) suppresses a future attended confirm
// so the same prompt never recurs. Rules are scope-bound, revocable, cannot
// loosen a hard rule, and (being prompt-suppression) do not apply without a UI.

const findRuleAdded = (pi: FakePi) =>
  pi.entries.find(
    (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "remembered-rule-added",
  );

test("Part 3: a remembered rule (/harness-rules allow) suppresses the prompt", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx); // attended
  await pi.commands.get("harness-rules")!.handler("allow write out.txt", ctx);
  const added = findRuleAdded(pi);
  assert.ok(added, "a rule was saved via the command");
  assert.equal((added!.data as { actor?: string }).actor, "user");

  const titles: string[] = [];
  scriptConfirm(ctx, {}, titles);
  const r = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "out.txt", content: "y" } },
    ctx,
  );
  assert.equal(r, undefined, "the write is auto-allowed by the remembered rule");
  assert.deepEqual(titles, [], "the remembered rule suppresses the prompt");
  assert.ok(
    pi.entries.some(
      (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "remembered-rule-allow",
    ),
    "the remembered-rule allow is audited",
  );
});

test("Part 3: a remembered rule is revocable via /harness-rules and the prompt returns", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.commands.get("harness-rules")!.handler("allow write out.txt", ctx);
  const id = (findRuleAdded(pi)!.data as { ruleId: string }).ruleId;
  await pi.commands.get("harness-rules")!.handler(`revoke ${id}`, ctx);

  // The rule is gone: the next write prompts again (declined here -> blocked).
  const titles: string[] = [];
  scriptConfirm(ctx, { "Allow write?": false }, titles);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "out.txt", content: "y" } },
    ctx,
  )) as { block?: boolean };
  assert.equal(blocked?.block, true);
  assert.ok(titles.includes("Allow write?"), "the prompt returns after revocation");
});

test("Part 3: a sensitive read cannot be remembered as allow (hard boundary)", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const outsideEnv = path.join(tmpRoot(), ".env");
  fs.writeFileSync(outsideEnv, "SECRET=1\n");
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.commands.get("harness-rules")!.handler(`allow read ${outsideEnv}`, ctx);
  assert.ok(!findRuleAdded(pi), "no rule saved for a sensitive read");
  assert.ok(
    ctx.notifications.some((n) => /sensitive/i.test(n.message)),
    "the command refuses and says why",
  );
});

test("Part 3: a remembered edit rule cannot resurrect a blind edit (hard rule wins)", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const file = path.join(root, "data.txt");
  fs.writeFileSync(file, "orig\n");
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.commands.get("harness-rules")!.handler("allow edit data.txt", ctx);
  assert.ok(findRuleAdded(pi), "an edit rule was saved");

  // data.txt was never read this session, so read-before-edit must block the
  // edit even though a rule matches — a rule cannot loosen a hard boundary.
  const titles: string[] = [];
  scriptConfirm(ctx, {}, titles);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "data.txt", oldText: "orig", newText: "again" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /read-before-edit/);
  assert.deepEqual(titles, [], "read-before-edit blocks before any prompt; the rule does not bypass it");
});

test("Part 3: a remembered rule does not auto-allow without a UI (no-UI fails closed)", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.commands.get("harness-rules")!.handler("allow write out.txt", ctx);
  assert.ok(findRuleAdded(pi), "rule saved");

  // Same extension instance (rule in force), but a no-UI context: the rule must
  // not auto-allow — a no-UI session has no prompt to suppress and fails closed.
  const noUi = makeCtx({ cwd: root, hasUI: false });
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "out.txt", content: "y" } },
    noUi,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /failing closed/i);
});

test("a remembered rule applies without a UI once the user opts in, and only for the rule's own target", async () => {
  // The default above (fails closed with no UI) is unchanged. This is the
  // explicit escape hatch for non-interactive sessions: it changes WHEN the
  // approvals the user already saved apply, not WHAT they cover.
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.commands.get("harness-rules")!.handler("allow write out.txt", ctx);
  await pi.commands.get("harness-rules")!.handler("headless on", ctx);

  const noUi = makeCtx({ cwd: root, hasUI: false });
  const allowed = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "out.txt", content: "y" } },
    noUi,
  );
  assert.equal(allowed, undefined, "the rule the user saved now applies with no UI");

  // A different target has no rule, so it still fails closed.
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "write", input: { path: "other.txt", content: "y" } },
    noUi,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true, "the opt-in does not blanket-approve");
  assert.match(blocked?.reason ?? "", /failing closed/i);
});

test("accept mode stamps its allow for the harness, exactly like a dialog approval", async () => {
  // /mode accept is the user's standing answer for in-root edits; the stamp is
  // how the harness layer consumes that answer instead of asking its own
  // section-21 question (or failing closed with no UI).
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, hasUI: false });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("accept", ctx);

  const event = { type: "tool_call", toolCallId: "c1", toolName: "write", input: { path: "in-root.txt", content: "x" } };
  const result = await pi.emit("tool_call", event, ctx);
  assert.equal(result, undefined, "accept mode allows the in-root write with no UI");
  const stamp = (event as { __cpUserApproved?: { callId: string | null } }).__cpUserApproved;
  assert.equal(stamp?.callId, "c1", "the allow is stamped per-callId for the harness");

  // A call accept does NOT cover gets no stamp: it confirms (and with no UI,
  // blocks) — the stamp never outruns the rule that earns it.
  const shellEvent = { type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "echo hi" } };
  const blocked = (await pi.emit("tool_call", shellEvent, ctx)) as { block?: boolean };
  assert.equal(blocked?.block, true);
  assert.equal((shellEvent as { __cpUserApproved?: unknown }).__cpUserApproved, undefined);
});

test("a remembered-rule allow stamps the event for the harness, like the dialog answer it replays", async () => {
  // Observed live: a rule allowed harness_delegate at this layer, then the
  // harness asked its own section-21 question about the same call. The rule
  // IS the user's "Always" answer, so it must carry the same P2 stamp.
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.commands.get("harness-rules")!.handler("allow write out.txt", ctx);

  const event = { type: "tool_call", toolCallId: "r1", toolName: "write", input: { path: "out.txt", content: "x" } };
  const result = await pi.emit("tool_call", event, ctx);
  assert.equal(result, undefined, "the rule allows without a prompt");
  const stamp = (event as { __cpUserApproved?: { callId: string | null } }).__cpUserApproved;
  assert.equal(stamp?.callId, "r1");
});

// ---- Part 3 dialog: the in-prompt third option (Yes once / No / Always) ----
// The attended per-call gate for a rememberable confirm is a single three-option
// dialog (ctx.ui.custom + SelectList). "Always" saves exactly the rule
// /harness-rules allow would, then allows. Sensitive reads and hard-rule
// denials never reach it.

test("Part 3 dialog: Always saves the rule and allows; the next call is silent", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "always" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx); // attended
  const r1 = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "out.txt", content: "x" } },
    ctx,
  );
  assert.equal(r1, undefined, "Always allows the call");
  const added = findRuleAdded(pi);
  assert.ok(added, "a rule was saved from the dialog");
  assert.equal((added!.data as { actor?: string; provenance?: string }).actor, "user");
  assert.equal((added!.data as { provenance?: string }).provenance, "attended-dialog");

  // Second identical call: the saved rule auto-allows it — the dialog is not
  // shown even though this ctx would answer "no" if it were.
  const ctx2 = makeCtx({ cwd: root, withCustom: true, customChoice: "no" });
  const r2 = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "2", toolName: "write", input: { path: "out.txt", content: "y" } },
    ctx2,
  );
  assert.equal(r2, undefined, "the saved rule suppresses the dialog on the repeat call");
  assert.deepEqual(ctx2.customCalls, [], "no dialog shown once a rule exists");
});

test("Part 3 dialog: Yes-once allows but saves no rule", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "once" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const r = await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "out.txt", content: "x" } },
    ctx,
  );
  assert.equal(r, undefined, "Yes-once allows the call");
  assert.ok(!findRuleAdded(pi), "Yes-once saves no rule");
});

test("Part 3 dialog: No blocks, and Escape (null) is treated as No", async () => {
  for (const choice of ["no", null] as const) {
    const pi = await boot();
    const root = tmpRoot();
    const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: choice });
    await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await pi.commands.get("mode")!.handler("execute", ctx);
    const blocked = (await pi.emit(
      "tool_call",
      { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "out.txt", content: "x" } },
      ctx,
    )) as { block?: boolean };
    assert.equal(blocked?.block, true, `choice ${String(choice)} blocks`);
    assert.ok(!findRuleAdded(pi), "a blocked call saves no rule");
  }
});

test("Part 3 dialog: a sensitive read never gets the Always option", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const outsideEnv = path.join(tmpRoot(), ".env");
  fs.writeFileSync(outsideEnv, "SECRET=1\n");
  // withCustom + "always": if the sensitive read wrongly used the dialog it
  // would be allowed and remembered. It must use the plain confirm instead.
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "always", confirmResult: false });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: outsideEnv } },
    ctx,
  )) as { block?: boolean };
  assert.equal(blocked?.block, true, "the sensitive read used the plain confirm and was declined");
  assert.deepEqual(ctx.customCalls, [], "no three-option dialog for a sensitive read");
  assert.ok(!findRuleAdded(pi), "a sensitive read is never remembered");
});

test("Part 3 dialog: a blind edit blocks before the dialog (hard rule wins)", async () => {
  const pi = await boot();
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "data.txt"), "orig\n"); // exists, unread this session
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "always" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "edit", input: { path: "data.txt", oldText: "orig", newText: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /read-before-edit/);
  assert.deepEqual(ctx.customCalls, [], "read-before-edit blocks before the dialog is ever shown");
  assert.ok(!findRuleAdded(pi));
});

/** These tests exercise the real `bwrap` availability check
 * (isBwrapAvailable in extensions/control-plane.ts), so they skip rather
 * than fail on a machine without bubblewrap installed - same reasoning as
 * not hard-failing tests/sandbox.test.ts's real-process assertions on a
 * platform that lacks /bin/sh. */
const bwrapInstalled = spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;

test("/bwrap: off by default, status reports it, on refuses without confirmation UI needs", { skip: !bwrapInstalled }, async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);


  await pi.commands.get("bwrap")!.handler("", ctx);
  const statusOutput = pi.entries.at(-1)?.data as { title: string; lines: string[] };
  assert.equal(statusOutput.title, "bwrap");
  assert.match(statusOutput.lines.join("\n"), /Sandbox: off/);

  await pi.commands.get("bwrap")!.handler("on", ctx);
  assert.match(ctx.notifications.at(-1)?.message ?? "", /Bwrap sandbox enabled/);
  assert.match(ctx.statuses["control-plane"] ?? "", /Sandbox: bwrap \(net off\)/);

  await pi.commands.get("bwrap")!.handler("network on", ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Sandbox: bwrap \(net on\)/);

  await pi.commands.get("bwrap")!.handler("off", ctx);
  assert.doesNotMatch(ctx.statuses["control-plane"] ?? "", /Sandbox:/);
});

test(
  "/bwrap on wraps an allowed bash call's command in bwrap; off leaves it untouched",
  { skip: !bwrapInstalled },
  async () => {
    const pi = await boot();
    const root = tmpRoot();
    const ctx = makeCtx({ cwd: root, confirmResult: true });
    await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await pi.commands.get("mode")!.handler("execute", ctx);

    const unwrapped = { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "echo hi" } };
    await pi.emit("tool_call", unwrapped, ctx);
    assert.equal(unwrapped.input.command, "echo hi", "sandbox off must not touch the command");

    await pi.commands.get("bwrap")!.handler("on", ctx);
    const wrapped = { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "echo hi" } };
    await pi.emit("tool_call", wrapped, ctx);
    assert.match(wrapped.input.command, /^'bwrap' /, "sandbox on must rewrite the command to a bwrap invocation");
    assert.ok(
      wrapped.input.command.includes(`'--bind' '${root}' '${root}'`),
      "project root must be bound read-write",
    );
    assert.match(wrapped.input.command, /'echo hi'$/, "the original command must survive, quoted, at the end");
  },
);

test("state restores across sessions from persisted entries (phase, autonomy, toggles)", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("plan", ctx);
  await pi.commands.get("context")!.handler("toggle tool:bash", ctx);
  assert.ok(!pi.activeTools.includes("bash"), "bash removed from active tools");

  // New process: fresh extension instance restores from the persisted entries.
  const pi2 = new (pi.constructor as new () => FakePi)();
  await controlPlaneExtension(pi2 as never);
  const ctx2 = makeCtx({ cwd: root, branchEntries: pi.entries.filter((e) => e.customType === STATE_ENTRY_TYPE) });
  await pi2.emit("session_start", { type: "session_start", reason: "resume" }, ctx2);
  assert.match(ctx2.statuses["control-plane"] ?? "", /Mode: Plan/);
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
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Plan/);
  assert.ok(ctx.notifications.some((n) => /malformed/i.test(n.message)));
});

test("sandboxed is a deprecated alias: warns and degrades to Plan (never escalates to an edit mode)", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("sandboxed", ctx);
  assert.ok(
    ctx.notifications.some((n) => /not a security sandbox/i.test(n.message)),
    "sandbox warning required",
  );
  // The restricted mode it once selected is gone; it must degrade to the safest
  // mode (Plan / read-only), never escalate into an edit mode.
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Plan/);
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
  await pi.commands.get("mode")!.handler("discuss", ctx);
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
  assert.ok(result?.systemPrompt?.includes("Mode: Plan"));
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
  assert.ok(pi.shortcuts.has("ctrl+alt+t"));
  assert.ok(!pi.shortcuts.has("alt+t"), "Alt+T belongs to tmux");
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
  assert.ok(pi.activeTools.includes("local_web_search"), "'all' re-enables everything not always-disabled");
  assert.ok(
    !pi.activeTools.includes("web_search"),
    "except alwaysDisabledTools (policy/profiles.json) - 'all' does not mean literally all",
  );
  assert.ok(
    ctx.notifications.some((n) => /kept off/.test(n.message)),
    "the override is explained in the notification, not silent",
  );

  await pi.commands.get("context")!.handler("profile bogus", ctx);
  assert.ok(ctx.notifications.some((n) => /Unknown profile "bogus"/.test(n.message)));
});

test("applied profile persists and is restored in a new session", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("context")!.handler("profile reading", ctx);
  // The fake registry registers local_web_search but no pi-web-access
  // tools, so the reading profile's active set is its intersection with the
  // registry: the four core reads plus both registered read-classified tools.
  assert.deepEqual([...pi.activeTools].sort(), ["find", "grep", "local_web_search", "ls", "read", "todo"]);

  const pi2 = new (pi.constructor as new () => FakePi)();
  await controlPlaneExtension(pi2 as never);
  const ctx2 = makeCtx({ cwd: root, branchEntries: pi.entries.filter((e) => e.customType === STATE_ENTRY_TYPE) });
  await pi2.emit("session_start", { type: "session_start", reason: "resume" }, ctx2);
  // Registered extension tools begin active, matching Pi's registry. Restore
  // removes profile-disabled tools and retains enabled reading tools.
  assert.deepEqual([...pi2.activeTools].sort(), ["find", "grep", "local_web_search", "ls", "read", "todo"], "profile toggles reapplied on restore");
});

test("mode cycle hotkey advances through all four modes", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("plan", ctx);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Manual/);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Accept/);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Auto/);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Plan/);
});

test("/scratchpad: add, list, remove, clear round-trip and persist across a session restore", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);


  await pi.commands.get("scratchpad")!.handler("add remember to check the config", ctx);
  assert.ok(ctx.notifications.some((n) => /added/i.test(n.message)));

  await pi.commands.get("scratchpad")!.handler("", ctx);
  const listEntry = pi.entries.at(-1);
  assert.equal(listEntry?.customType, "pi-control-plane-output");
  const listLines = (listEntry?.data as { lines: string[] }).lines;
  assert.ok(listLines.some((l) => l.includes("remember to check the config")));

  // Persists across a fresh session restore, same as control-plane state.
  const pi2 = new (pi.constructor as new () => FakePi)();
  await controlPlaneExtension(pi2 as never);
  const ctx2 = makeCtx({ cwd: root, branchEntries: pi.entries });
  await pi2.emit("session_start", { type: "session_start", reason: "resume" }, ctx2);
  await pi2.commands.get("scratchpad")!.handler("", ctx2);
  const restoredLines = (pi2.entries.at(-1)?.data as { lines: string[] }).lines;
  assert.ok(restoredLines.some((l) => l.includes("remember to check the config")));

  // Injected into the system prompt each turn.
  const result = (await pi2.emit(
    "before_agent_start",
    { type: "before_agent_start", prompt: "user prompt", systemPrompt: "BASE", systemPromptOptions: { cwd: root, contextFiles: [], skills: [] } },
    ctx2,
  )) as { systemPrompt?: string };
  assert.ok(result?.systemPrompt?.includes("[SCRATCHPAD]"));
  assert.ok(result?.systemPrompt?.includes("remember to check the config"));

  // Remove by id, then clear.
  const noteId = listLines.find((l) => l.trim().startsWith("("))?.trim().match(/\(([a-z0-9]+)\)/)?.[1];
  assert.ok(noteId, "could not parse a note id out of the rendered list");
  await pi.commands.get("scratchpad")!.handler(`remove ${noteId}`, ctx);
  assert.ok(ctx.notifications.some((n) => /removed/i.test(n.message)));
  await pi.commands.get("scratchpad")!.handler("add another note", ctx);
  await pi.commands.get("scratchpad")!.handler("clear force", ctx);
  assert.ok(ctx.notifications.some((n) => /cleared/i.test(n.message)));
  await pi.commands.get("scratchpad")!.handler("", ctx);
  const finalLines = (pi.entries.at(-1)?.data as { lines: string[] }).lines;
  assert.ok(finalLines.some((l) => /empty/i.test(l)));
});

test("local_web_search tool: registered read-only and reachable even outside Execute mode", async () => {
  const pi = await boot();
  const tool = pi.tools.get("local_web_search");
  assert.ok(tool, "local_web_search must be registered");
  // Executing it does not require network access to prove the wiring: a
  // failed fetch (no searxng reachable in this test environment) still
  // returns a structured, non-throwing result via formatSearchResults.
  // Regression: this tool once returned the legacy `{ output }` shape, which
  // crashed Pi's interactive renderer (getTextOutput reads result.content
  // unconditionally) and killed the whole session. The result MUST carry the
  // Pi-native `content: [{ type: "text", ... }]` array; a bare `output` key
  // is forbidden here.
  const result = (await tool!.execute("call-1", { query: "test query" }, undefined, undefined, {})) as {
    content: { type: string; text: string }[];
    output?: unknown;
  };
  assert.equal(result.output, undefined, "legacy { output } results crash Pi's interactive renderer");
  assert.deepEqual(
    result.content.map(({ type }) => type),
    ["text"],
    "result must be a single text content block",
  );
  assert.ok(result.content[0].text.length > 0);
});

test("transcribe_audio tool: registered sequentially and returns Pi-native content", async () => {
  const pi = await boot();
  const tool = pi.tools.get("transcribe_audio");
  assert.ok(tool, "transcribe_audio must be registered");
  assert.equal(
    tool!.executionMode,
    "sequential",
    "multiple voicemail calls must not race through whisper-server's one model context",
  );
  // A path that cannot exist proves the wiring end to end without needing
  // llama-swap running: the tool must return a structured failure string
  // rather than throwing.
  const result = (await tool!.execute(
    "call-1",
    { path: path.join(os.tmpdir(), "pi-control-plane-no-such-audio.wav") },
    undefined,
    undefined,
    {},
  )) as { content: { type: string; text: string }[]; output?: unknown };
  assert.equal(result.output, undefined, "legacy { output } results crash Pi's interactive renderer");
  assert.deepEqual(
    result.content.map(({ type }) => type),
    ["text"],
    "the TUI expects AgentToolResult.content to be an array of content blocks",
  );
  assert.match(result.content[0]?.text ?? "", /Transcription failed: audio file not found/);
});

test("Unattended (Auto): mutating calls run without a precondition and are logged for audit; reads are not", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("auto", ctx); // Auto = unattended

  // A mutating call in-root is allowed with no precondition AND still logged
  // as a diagnostic entry (nobody is watching in real time, so the audit
  // trail is the review mechanism).
  const entriesBefore = pi.entries.length;
  const allowed = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolName: "write", input: { path: path.join(root, "f.txt"), content: "" } },
    ctx,
  )) as { block?: boolean } | undefined;
  assert.equal(allowed?.block, undefined, "unattended mutations run without a precondition");
  const diagnostic = pi.entries.slice(entriesBefore).find((e) => e.customType === DIAGNOSTIC_ENTRY_TYPE);
  assert.ok(diagnostic, "an allowed unattended mutation must be logged for later review");
  assert.equal((diagnostic!.data as { kind: string }).kind, "unattended-call-allowed");

  // Reads are not logged (would drown out the signal).
  const entriesBeforeRead = pi.entries.length;
  await pi.emit("tool_call", { type: "tool_call", toolName: "read", input: { path: path.join(root, "f.txt") } }, ctx);
  assert.equal(pi.entries.length, entriesBeforeRead, "reads must not add an audit entry");
});

// ---- Advisor-consult budget (soft policy) --------------------------------
// harness_delegate kind:"advisor" is the cloud advisor. The first consult per
// session is silent; further consults hit the attended Yes/No/Always gate;
// "Always" lifts the cap for the session. It only downgrades/gates the
// attended path and never loosens a hard block.
const advisorConsultEntries = (pi: FakePi) =>
  pi.entries.filter(
    (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "advisor-consult",
  );
const advisorDiag = (pi: FakePi, kind: string) =>
  pi.entries.filter(
    (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === kind,
  );
const consult = (id: string) => ({
  type: "tool_call",
  toolCallId: id,
  toolName: "harness_delegate",
  input: { kind: "advisor", objective: "x" },
});

test("advisor budget: the first consult per task is silent (no dialog)", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot(), withCustom: true, customChoice: "no" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx); // attended
  const r = await pi.emit("tool_call", consult("1"), ctx);
  assert.equal(r, undefined, "the first advisor consult is allowed without a prompt");
  assert.deepEqual(ctx.customCalls, [], "no budget dialog for the first consult");
  const entries = advisorConsultEntries(pi);
  assert.equal(entries.length, 1, "the consult is audited");
  assert.equal((entries[0].data as { count: number }).count, 1);
  assert.equal((entries[0].data as { overBudgetApproved: boolean }).overBudgetApproved, false);
});

test("advisor budget: a second consult gates, and Yes-once allows it", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot(), withCustom: true, customChoice: "once" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.emit("tool_call", consult("1"), ctx); // free
  const r2 = await pi.emit("tool_call", consult("2"), ctx);
  assert.equal(r2, undefined, "Yes-once allows the over-budget consult");
  assert.equal(ctx.customCalls.length, 1, "the second consult showed the gate");
  const entries = advisorConsultEntries(pi);
  assert.equal(entries.length, 2);
  assert.equal((entries[1].data as { overBudgetApproved: boolean }).overBudgetApproved, true);
});

test("advisor budget: Always lifts the cap for the session", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot(), withCustom: true, customChoice: "always" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.emit("tool_call", consult("1"), ctx); // free
  const r2 = await pi.emit("tool_call", consult("2"), ctx); // gate -> Always
  assert.equal(r2, undefined, "Always allows this consult");
  assert.equal(advisorDiag(pi, "advisor-budget-lifted").length, 1, "the lift is audited");
  const callsAfterLift = ctx.customCalls.length;
  const r3 = await pi.emit("tool_call", consult("3"), ctx);
  assert.equal(r3, undefined, "further consults are silent once lifted");
  assert.equal(ctx.customCalls.length, callsAfterLift, "no dialog is shown after Always");
});

test("advisor budget: No (and Escape) block the over-budget consult", async () => {
  for (const choice of ["no", null] as const) {
    const pi = await boot();
    const ctx = makeCtx({ cwd: tmpRoot(), withCustom: true, customChoice: choice });
    await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    await pi.commands.get("mode")!.handler("execute", ctx);
    await pi.emit("tool_call", consult("1"), ctx); // free
    const blocked = (await pi.emit("tool_call", consult("2"), ctx)) as { block?: boolean };
    assert.equal(blocked?.block, true, `choice ${String(choice)} blocks the extra consult`);
    assert.equal(advisorDiag(pi, "advisor-budget-blocked").length, 1, "the block is audited");
  }
});

test("advisor budget: over budget with no UI fails closed", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot(), hasUI: false });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const r1 = await pi.emit("tool_call", consult("1"), ctx); // free
  assert.equal(r1, undefined, "the first consult is free even with no UI");
  const blocked = (await pi.emit("tool_call", consult("2"), ctx)) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true, "no UI to approve the extra consult -> fail closed");
  assert.match(blocked?.reason ?? "", /no confirmation UI/i);
});

test("advisor budget: never loosens a hard block (Discuss phase)", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() }); // Discuss set explicitly below; the phase-switch dialog is declined (confirm=false)
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("discuss", ctx);
  const blocked = (await pi.emit("tool_call", consult("1"), ctx)) as { block?: boolean };
  assert.equal(blocked?.block, true, "a phase-blocked consult stays blocked");
  assert.equal(advisorConsultEntries(pi).length, 0, "the budget never counted or allowed a hard-blocked consult");
});

// ---- Dialog unification: every remaining confirm gets Yes/No/Always --------
// No confirm path is a bare, un-rememberable yes/no. A shell command is
// remembered by its exact command; a harness meta-tool / foreign tool at tool
// level. Sensitive reads remain the one exception (covered above).

test("dialog unification: a shell command confirm offers Always, keyed by the exact command", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "always" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx); // attended
  const r1 = await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "wc -l x" } }, ctx);
  assert.equal(r1, undefined, "Always allows the shell command");
  assert.equal(ctx.customCalls.length, 1, "the shell confirm used the three-option dialog, not a plain yes/no");
  const added = findRuleAdded(pi);
  assert.ok(added, "a rule was saved from the shell dialog");
  assert.equal((added!.data as { target: string }).target, "wc -l x", "the rule is keyed by the exact command");

  // The same command is suppressed next time; a different command is not.
  const ctx2 = makeCtx({ cwd: root, withCustom: true, customChoice: "no" });
  const r2 = await pi.emit("tool_call", { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "wc -l x" } }, ctx2);
  assert.equal(r2, undefined, "the saved command rule suppresses the identical call");
  assert.deepEqual(ctx2.customCalls, [], "no dialog for the remembered command");
  const ctx3 = makeCtx({ cwd: root, withCustom: true, customChoice: "no" });
  const r3 = (await pi.emit("tool_call", { type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: "rm -rf y" } }, ctx3)) as { block?: boolean };
  assert.equal(r3?.block, true, "a different command still prompts (declined here)");
  assert.equal(ctx3.customCalls.length, 1, "the different command showed the dialog");
});

test("dialog unification: a harness meta-tool confirm offers Always as a tool-level rule", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "always" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const r1 = await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "harness_note", input: { text: "hi" } }, ctx);
  assert.equal(r1, undefined, "Always allows the harness tool");
  const added = findRuleAdded(pi);
  assert.ok(added, "a tool-level rule was saved");
  assert.equal((added!.data as { target: string }).target, "*", "harness meta-tools save a tool-level (*) rule");

  // Tool-level: a DIFFERENT harness_note call is also suppressed.
  const ctx2 = makeCtx({ cwd: root, withCustom: true, customChoice: "no" });
  const r2 = await pi.emit("tool_call", { type: "tool_call", toolCallId: "2", toolName: "harness_note", input: { text: "different text" } }, ctx2);
  assert.equal(r2, undefined, "the tool-level rule suppresses any harness_note call");
  assert.deepEqual(ctx2.customCalls, [], "no dialog once the tool-level rule exists");
});

test("dialog unification: a foreign unknown tool shows the dialog, never a plain yes/no", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "no" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const blocked = (await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "browser_navigate", input: {} }, ctx)) as { block?: boolean };
  assert.equal(blocked?.block, true, "No declines the foreign tool");
  assert.equal(ctx.customCalls.length, 1, "the foreign-tool confirm used the three-option dialog, not a plain yes/no");
});

// ---- Read-only-shell default: pi_harness_bash read mode flows freely -------
// The harness runs pi_harness_bash under a bwrap sandbox with the scope root
// read-only unless mode:"write". Read mode auto-allows silently (bwrap present);
// write mode and no-bwrap fall through to the gate.

test("ro-shell: a read-mode pi_harness_bash command auto-allows silently", { skip: !bwrapInstalled }, async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "no" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx); // attended
  const r = await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "pi_harness_bash", input: { command: "wc -l x" } }, ctx);
  assert.equal(r, undefined, "read-only sandboxed shell is allowed without a prompt");
  assert.deepEqual(ctx.customCalls, [], "no dialog for a read-mode harness shell command");
});

test("ro-shell: without bwrap a read-mode command falls to the gate, never a silent allow", { skip: bwrapInstalled }, async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "no" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const blocked = (await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "pi_harness_bash", input: { command: "wc -l x" } }, ctx)) as { block?: boolean };
  assert.equal(blocked?.block, true, "no bwrap -> the gate (declined here), not a silent allow");
  assert.equal(ctx.customCalls.length, 1, "the confirm dialog was shown instead of auto-allowing");
});

// ---- Diagnostic + confirm text: no bare "?" or permanent "Unavailable" -----

test("diagnostic line: every kind renders its kind and subject, never a bare ?", () => {
  // The bug: a diagnostic with no toolName used to render with a bare "?"
  // placeholder. It must render its real kind + subject.
  const denied = formatDiagnosticLine({ kind: "read-out-of-scope-denied", target: "/etc/hostname", at: "T" });
  assert.ok(!denied.includes('"?"'), "no bare ? placeholder");
  assert.match(denied, /read-out-of-scope-denied \/etc\/hostname \(T\)/);

  const consult = formatDiagnosticLine({ kind: "advisor-consult", at: "T" });
  assert.ok(!consult.includes('"?"'));
  assert.match(consult, /advisor-consult \(T\)/);

  // A kind with no name shows no "?" either.
  assert.ok(!formatDiagnosticLine({ kind: "backup-before-edit-failed", at: "T" }).includes('"?"'));
});

test("confirm detail: no permanent 'Unavailable' lines; pathless tools say so plainly", () => {
  // A harness tool with no file target: no "Inside project root: Unavailable",
  // no "Model's stated reason", a plain "no file target".
  const harness = formatConfirmDetail({
    toolName: "harness_memory_search", riskCategory: "harness-tool",
    path: null, command: null, insideRoot: null, reason: "why",
  });
  assert.ok(!harness.includes("Unavailable"), "no Unavailable framing");
  assert.ok(!harness.includes("Model's stated reason"), "the permanently-absent rationale line is gone");
  assert.ok(!/Inside project root/.test(harness), "inside-root omitted when meaningless");
  assert.match(harness, /Target: no file target/);

  // A path tool: inside-root shows a real yes/no.
  const pathTool = formatConfirmDetail({
    toolName: "write", riskCategory: "file-write",
    path: "/p/f.txt", command: null, insideRoot: true, reason: "why",
  });
  assert.match(pathTool, /Target: \/p\/f\.txt/);
  assert.match(pathTool, /Inside project root: yes/);
  assert.ok(!pathTool.includes("Unavailable"));

  // A shell command: shows the command, no spurious "no file target", no
  // inside-root line (none resolved).
  const shell = formatConfirmDetail({
    toolName: "pi_harness_bash", riskCategory: "shell",
    path: null, command: "touch f", insideRoot: true, reason: "why",
  });
  assert.match(shell, /Command: touch f/);
  assert.ok(!shell.includes("no file target"), "a command is not 'no file target'");
  assert.match(shell, /Inside project root: yes/);
});

test("confirm detail: every body line is clamped to the terminal width (regression: over-wide Command line crashed the renderer)", () => {
  // Reproduces the 2026-09-16 crash: terminal width 191, a long bash command.
  // The old fixed 200-char cap + "Command: " prefix rendered a 210-wide line and
  // base pi's doRender threw "Rendered line exceeds terminal width", exiting pi.
  const columns = 191;
  const maxWidth = safeDialogWidth(columns);
  assert.ok(maxWidth < columns, "safe width must leave margin under the terminal width");
  const longCommand = "identify ~/Downloads/pi-man.png; montage ~/Downloads/pi-man.png -tile 3x1 -geometry +2+2 ~/pi-man-frames.png && echo ok; ls ~/.pi/agent/extensions 2>/dev/null; echo ---; ls ~/.pi/agent/npm/node_modules/pi-subagents 2>/dev/null | head; ".repeat(2);
  assert.ok(Array.from(longCommand).length > 200, "fixture must exceed the old 200-char cap");
  const detail = formatConfirmDetail(
    { toolName: "bash", riskCategory: "shell", path: null, command: longCommand, insideRoot: true, reason: "why" },
    maxWidth,
  );
  for (const line of detail.split("\n")) {
    assert.ok(Array.from(line).length <= maxWidth, `line overflows safe width (${Array.from(line).length} > ${maxWidth}): ${line}`);
  }
  assert.match(detail, /^Command: identify ~\/Downloads\/pi-man\.png/m, "the command is still shown, just clamped");
  assert.match(detail, /…$/m, "the clamped command is ellipsized");
  // A long Target path is clamped too (the whole body is line-clamped, not just Command).
  const longPath = "/" + "d/".repeat(200) + "f.txt";
  const pathDetail = formatConfirmDetail(
    { toolName: "write", riskCategory: "file-write", path: longPath, command: null, insideRoot: true, reason: "why" },
    maxWidth,
  );
  for (const line of pathDetail.split("\n")) {
    assert.ok(Array.from(line).length <= maxWidth, `path line overflows safe width: ${line}`);
  }
  // clampBodyLines itself: short lines untouched, long lines ellipsized to exactly maxWidth.
  assert.equal(clampBodyLines("short\nline", 40), "short\nline");
  const clamped = clampBodyLines("x".repeat(100), 40);
  assert.equal(Array.from(clamped).length, 40);
  assert.ok(clamped.endsWith("…"));
});

test("ro-shell: a write-mode pi_harness_bash command still gates and is rememberable", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "always" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  const r = await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "pi_harness_bash", input: { command: "touch f", mode: "write" } }, ctx);
  assert.equal(r, undefined, "Always allows the write-mode command");
  assert.equal(ctx.customCalls.length, 1, "write mode is gated by the three-option dialog, never auto-allowed");
  const added = findRuleAdded(pi);
  assert.ok(added, "the write-mode confirm is rememberable");
  assert.equal((added!.data as { target: string }).target, "touch f", "keyed by the exact write command");
});

// ---- Gate fatigue: P1 (effect) + P2 (one door per decision) ---------------
// GATE-FATIGUE-REDESIGN.md. Read-effect harness tools stop prompting; when the
// attended layer collects an answer, it is stamped on the event so the harness
// seam consumes it instead of asking the same question twice.

test("P1: read-effect harness tools flow free; write/escalate ones still gate", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot(), withCustom: true, customChoice: "no" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx); // attended

  for (const toolName of ["harness_find_capability", "harness_memory_search"]) {
    const r = await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName, input: {} }, ctx);
    assert.equal(r, undefined, `${toolName} is allowed`);
  }
  assert.deepEqual(ctx.customCalls, [], "read-effect harness tools show no dialog at all");

  // The ones that change something keep their gate (declined here -> blocked).
  // harness_request_scope is in this list on purpose: its auto-granted path
  // widens the scope itself (scope.ts:270 returns a new root, which pi-harness
  // then persists), so it is authority-expanding, not a mere request. It was
  // briefly downgraded in 5a8d194 and that was a real loosening.
  for (const toolName of ["harness_note", "harness_set_posture", "harness_delegate", "harness_request_scope"]) {
    const r = (await pi.emit("tool_call", { type: "tool_call", toolCallId: "2", toolName, input: {} }, ctx)) as {
      block?: boolean;
    };
    assert.equal(r?.block, true, `${toolName} still gates`);
  }
  assert.equal(ctx.customCalls.length, 4, "one dialog each for the write/escalate tools");
});

test("P2: an approved call is stamped for the harness, keyed to that exact call", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "once" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);

  const event = { type: "tool_call", toolCallId: "call-42", toolName: "write", input: { path: "out.txt", content: "x" } };
  const r = await pi.emit("tool_call", event, ctx);
  assert.equal(r, undefined, "approved");
  const stamp = (event as { __cpUserApproved?: { callId: string } }).__cpUserApproved;
  assert.ok(stamp, "the human's answer is stamped on the event for the harness seam");
  assert.equal(stamp!.callId, "call-42", "stamped with THIS call's id, so it cannot be replayed");
});

test("P2: a declined call is never stamped (a denial cannot satisfy the second layer)", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot(), withCustom: true, customChoice: "no" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);

  const event = { type: "tool_call", toolCallId: "call-7", toolName: "write", input: { path: "out.txt", content: "x" } };
  const r = (await pi.emit("tool_call", event, ctx)) as { block?: boolean };
  assert.equal(r?.block, true, "declined -> blocked here");
  assert.equal((event as { __cpUserApproved?: unknown }).__cpUserApproved, undefined, "no stamp on a denial");
});


test("minimal UI renders one row, hides counters, and details remains available", async () => {
  const pi = new FakePi();
  await controlPlaneExtension(pi as never);
  const ctx = makeCtx();
  Object.assign(ctx.sessionManager, {
    getEntries: () => [], getCwd: () => "/work/project", getSessionName: () => undefined,
  });
  let footer: { render: (width: number) => string[] } | undefined;
  let counter: { render: (width: number) => string[] } | undefined;
  const colors: { color: string; text: string }[] = [];
  const theme = { fg: (color: string, text: string) => {
    colors.push({ color, text });
    return text;
  } };
  ctx.ui.setFooter = (factory: Function) => {
    footer = factory({}, theme, {
      getGitBranch: () => "main", getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => new Map(Object.entries(ctx.statuses).filter(([, value]) => value !== undefined)),
    });
  };
  ctx.ui.getEditorText = () => "draft";
  ctx.ui.setWidget = (key: string, factory: unknown) => {
    if (key === "control-plane-draft-counter" && typeof factory === "function") counter = factory({}, theme);
  };
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.ok(footer);
  assert.ok(counter);
  // One natural-width status row. No reserved blank rows or 100-column cap.
  const initial = footer.render(140);
  assert.deepEqual(initial, [
    // Fresh session opens in Auto (Execute + unattended); see state.ts freshState().
    // Context reads as used/window (fixture: 100 of 1000), not a bare percent,
    // so the loaded model's context size is always on screen.
    " /work/project  ·  Auto  ·  ctx ~100/1.0k  ·  OpenRouter loading  ·  test-model  ·  alt+h help",
  ]);
  assert.match(initial[0], /ctx ~100\/1\.0k  ·  OpenRouter loading  ·  test-model/);
  assert.equal(footer.render(80).length, 1);
  assert.ok(colors.some((c) => c.color === "accent" && c.text === "Auto"));
  assert.deepEqual(counter.render(80), []);
  assert.ok(colors.some((item) => item.color === "accent" && item.text === "Auto"));
  assert.ok(colors.some((item) => item.color === "muted" && item.text.includes("project")),
    "cwd sits in the quiet muted baseline");
  for (const width of [0, 1, 12, 24, 40, 80, 120]) {
    assert.ok(footer.render(width).every((line) => line.length <= width));
  }
  assert.deepEqual(footer.render(200), initial);
  ctx.statuses.lsp = "\x1b[90mLSP Inactive\x1b[0m";
  assert.equal(footer.render(80).length, 1, "idle status does not reserve a row");
  ctx.statuses.lsp = "LSP Error: server disconnected";
  assert.equal(footer.render(120).length, 2);
  assert.match(footer.render(80).join("\n"), /LSP Error/);
  ctx.statuses.lsp = "LSP Inactive";
  ctx.statuses.other = "External operation running";
  assert.match(footer.render(80).join("\n"), /External operation running/);
  await pi.commands.get("control-ui")!.handler("details", ctx);
  assert.match(footer.render(80).join("\n"), /context/);
  assert.match(footer.render(80).join("\n"), /LSP Inactive/);
  assert.match(footer.render(80).join("\n"), /OpenRouter/);
  assert.equal(counter.render(80).length, 2);
  assert.ok(counter.render(8).every((line) => line.length <= 8));
  await pi.commands.get("control-ui")!.handler("minimal", ctx);
  assert.deepEqual(counter.render(80), []);
  ctx.getContextUsage = () => ({ tokens: 950, contextWindow: 1000, percent: 95 });
  colors.length = 0;
  footer.render(80);
  assert.ok(colors.some((item) => item.color === "error" && item.text.includes("95%")));
  assert.ok(colors.some((item) => item.color === "accent" && item.text === "Auto"));
  const narrow = footer.render(12);
  assert.ok(narrow.every((line) => line.length <= 12));
  // Every attention row carries the 1-column grid pad; final row is status.
  assert.ok(narrow.slice(0, -1).every((line) => line.startsWith(" ")), "attention rows sit on the grid");
  assert.match(narrow.map((line) => line.replace(/^ /, "")).join(""), /Context ~95% estimated — \/compact/);
});


test("top-right context tools header reads active registry on every render", async () => {
  const pi = new FakePi();
  await controlPlaneExtension(pi as never);
  const ctx = makeCtx();
  let header: { render: (width: number) => string[] } | undefined;
  ctx.ui.setHeader = (factory: Function) => {
    header = factory({}, { fg: (_color: string, text: string) => text });
  };
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.ok(header);
  assert.ok(
    !ctx.notifications.some((notification) => /Profile "minimal"/.test(notification.message)),
    "fresh-session profile confirmation stays in the persistent header",
  );
  assert.equal(header.render(80).length, 1, "header is one line");
  assert.ok(header.render(80)[0].startsWith(" PROFILE minimal"), "profile and left grid");
  pi.setActiveTools(["read", "custom_tool"]);
  assert.match(header.render(80).join("\n"), /PROFILE custom/);
  assert.match(header.render(80).join("\n"), /custom_tool · read/);
  assert.doesNotMatch(header.render(80).join("\n"), /bash/);
  await pi.commands.get("context")!.handler("toggle tool:read", ctx);
  assert.match(header.render(80).join("\n"), /TOOLS 1/);
  assert.doesNotMatch(header.render(80).join("\n"), /read/);
  await pi.commands.get("context")!.handler("profile reading", ctx);
  const rendered = header.render(120).join("\n");
  for (const tool of pi.getActiveTools()) assert.ok(rendered.includes(tool));
  pi.setActiveTools(pi.allToolNames);
  assert.match(header.render(120)[0], /\+4 more  ·  ctrl\+alt\+t/, "11 tools collapse to 7 + more");
  for (const width of [1, 12, 40, 80]) assert.ok(header.render(width).every((line) => line.length <= width));
});

test("/task add appends, persists, repaints, and informs the current model without starting a turn", async () => {
  const previous = process.env.PI_CONTROL_PLANE_STATE_DIR;
  const stateDirectory = tmpRoot();
  const workspace = tmpRoot();
  process.env.PI_CONTROL_PLANE_STATE_DIR = stateDirectory;
  try {
    const pi = await boot();
    const ctx = makeCtx({ cwd: workspace });
    let renders = 0;
    let overlay: { render(width: number): string[] } | undefined;
    ctx.ui.setWidget = (key: string, factory: unknown) => {
      if (key !== "control-plane-todo" || typeof factory !== "function") return;
      factory({
        requestRender() { renders++; },
        showOverlay(component: { render(width: number): string[] }) { overlay = component; return { hide() {} }; },
      }, { fg: (_color: string, text: string) => text });
    };
    await pi.emit("session_start", { reason: "startup" }, ctx);
    const tool = pi.tools.get("todo")!;
    await tool.execute("seed", { op: "add", text: "Existing task" }, undefined, undefined, ctx);
    const command = pi.commands.get("task")!;
    const before = renders;
    await command.handler("add User task", ctx);
    ctx.isIdle = () => false;
    await command.handler("add Busy task", ctx);
    assert.ok(renders > before);
    assert.match(overlay!.render(44).join("\n"), /User task/);
    assert.equal(pi.sentMessages.length, 2);
    for (const sent of pi.sentMessages) {
      assert.equal(sent.message.customType, "pi-control-plane-task-added");
      assert.equal(sent.message.display, true);
      assert.deepEqual(sent.options, { deliverAs: "steer", triggerTurn: false });
      assert.match(sent.message.content, /already tracked; do not add a duplicate/);
    }
    assert.match(pi.sentMessages[0].message.content, /Added \[2\] User task/);
    assert.match(pi.sentMessages[1].message.content, /Added \[3\] Busy task/);
    const { readWorkspaceTodo } = await import("../src/control-plane/todo-store.ts");
    assert.deepEqual(readWorkspaceTodo(workspace).todo?.items.map((i) => i.text), ["Existing task", "User task", "Busy task"]);
    const injection = await pi.emit("before_agent_start", {
      systemPrompt: "BASE", systemPromptOptions: ctx.getSystemPromptOptions(),
    }, ctx);
    assert.match(JSON.stringify(injection), /User task/);
    const count = pi.entries.length;
    for (const args of ["", "add", "add   ", "remove 1", `add ${"x".repeat(501)}`]) await command.handler(args, ctx);
    assert.equal(pi.entries.length, count, "invalid input must not mutate state");
    assert.equal(pi.sentMessages.length, 2, "invalid input must not notify model");
    const restored = await boot();
    const restoredCtx = makeCtx({ cwd: workspace });
    await restored.emit("session_start", { reason: "new" }, restoredCtx);
    const list = await restored.tools.get("todo")!.execute("list", { op: "list" }, undefined, undefined, restoredCtx);
    assert.match(JSON.stringify(list), /User task/);
    pi.sendMessage = () => { throw Error("delivery unavailable"); };
    await command.handler("add Retain after notification failure", ctx);
    assert.equal(readWorkspaceTodo(workspace).todo?.items.length, 4);
    assert.ok(ctx.notifications.some((n) => /Model notification failed/.test(n.message)));
  } finally {
    if (previous === undefined) delete process.env.PI_CONTROL_PLANE_STATE_DIR;
    else process.env.PI_CONTROL_PLANE_STATE_DIR = previous;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("/todo-clear removes unfinished tasks, persists empty state, and refreshes the widget", async () => {
  const oldStateDirectory = process.env.PI_CONTROL_PLANE_STATE_DIR;
  const stateDirectory = tmpRoot();
  const workspace = tmpRoot();
  process.env.PI_CONTROL_PLANE_STATE_DIR = stateDirectory;
  try {
    const pi = await boot();
    const ctx = makeCtx({ branchEntries: [], cwd: workspace });
    let renderRequests = 0;
    let overlay: { render(width: number): string[] } | undefined;
    ctx.ui.setWidget = (key: string, factory: unknown) => {
      if (key !== "control-plane-todo" || typeof factory !== "function") return;
      factory({
        requestRender: () => { renderRequests++; },
        showOverlay: (component: { render(width: number): string[] }) => {
          overlay = component;
          return { hide() {} };
        },
      }, { fg: (_color: string, text: string) => text });
    };
    await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const tool = pi.tools.get("todo")!;
    await tool.execute("add-1", { op: "add", text: "Unfinished task" }, undefined, undefined, ctx);
    await tool.execute("add-2", { op: "add", text: "Another unfinished task" }, undefined, undefined, ctx);
    assert.match(overlay!.render(44).join("\n"), /Unfinished task/);
    const command = pi.commands.get("todo-clear");
    assert.ok(command, "/todo-clear is registered");
    const before = renderRequests;
    await command.handler("", ctx);
    assert.ok(renderRequests > before, "clear requests a fresh frame");
    assert.deepEqual(overlay!.render(44), []);
    const { readWorkspaceTodo } = await import("../src/control-plane/todo-store.ts");
    const saved = readWorkspaceTodo(workspace).todo;
    assert.ok(saved);
    assert.deepEqual(saved.items, []);
    assert.equal(saved.nextId, 3, "clearing must not reuse task IDs");
    assert.deepEqual(pi.entries.filter((entry) => entry.customType === "pi-control-plane-todo").at(-1)?.data, saved);
    assert.ok(!pi.entries.some((entry) => entry.customType === "pi-control-plane-todo-complete"), "clearing is not completion");
    const reloaded = await boot();
    const resumedCtx = makeCtx({ branchEntries: [], cwd: workspace });
    await reloaded.emit("session_start", { type: "session_start", reason: "new" }, resumedCtx);
    const listed = await reloaded.tools.get("todo")!.execute("list", { op: "list" }, undefined, undefined, resumedCtx);
    assert.match(JSON.stringify(listed), /No tasks/);
    await command.handler("", ctx);
    assert.ok(ctx.notifications.some((n) => /No tasks to clear/.test(n.message)));
    await tool.execute("add-3", { op: "add", text: "Preserve on invalid args" }, undefined, undefined, ctx);
    await command.handler("unexpected", ctx);
    assert.equal(readWorkspaceTodo(workspace).todo?.items.length, 1);
  } finally {
    if (oldStateDirectory === undefined) delete process.env.PI_CONTROL_PLANE_STATE_DIR;
    else process.env.PI_CONTROL_PLANE_STATE_DIR = oldStateDirectory;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("todo uses top-right overlay, repaints immediately, and persists across new sessions", async () => {
  const oldStateDirectory = process.env.PI_CONTROL_PLANE_STATE_DIR;
  const stateDirectory = tmpRoot();
  const workspace = tmpRoot();
  process.env.PI_CONTROL_PLANE_STATE_DIR = stateDirectory;
  try {
    const pi = await boot();
    const ctx = makeCtx({ branchEntries: [], cwd: workspace });
    let overlayWidget: { render(width: number): string[] } | undefined;
    let overlayOptions: Record<string, unknown> | undefined;
    let ownerWidget: { render(width: number): string[]; dispose?(): void } | undefined;
    let renderRequests = 0;
    let overlayHides = 0;
    ctx.ui.setWidget = (key: string, factory: unknown) => {
      if (key !== "control-plane-todo" || typeof factory !== "function") return;
      ownerWidget = factory(
        {
          requestRender: () => { renderRequests++; },
          showOverlay: (component: { render(width: number): string[] }, options: Record<string, unknown>) => {
            overlayWidget = component;
            overlayOptions = options;
            return { hide: () => { overlayHides++; } };
          },
        },
        { fg: (_color: string, text: string) => text },
      );
    };

    await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.equal(overlayOptions?.anchor, "top-right");
    assert.equal(overlayOptions?.nonCapturing, true);
    assert.deepEqual(ownerWidget?.render(80), [], "lifecycle widget consumes no document-flow rows");
    assert.deepEqual(overlayWidget?.render(44), []);

    const tool = pi.tools.get("todo");
    assert.ok(tool);
    assert.match(
      String((tool as unknown as { promptGuidelines?: string[] }).promptGuidelines?.join("\n")),
      /multi-step work.*mark each task done/i,
      "tool prompt tells models to maintain task lifecycle",
    );
    const beforeAdd = renderRequests;
    await tool!.execute("todo-1", { op: "add", text: "Keep visible" }, undefined, undefined, ctx);
    assert.ok(renderRequests > beforeAdd, "task mutation requests an immediate TUI frame");
    assert.match(overlayWidget!.render(44).join("\n"), /○ \[1\] Keep visible/);
    assert.match(overlayWidget!.render(44)[0]!, /╭─* Tasks 0\/1 ─*╮$/);
    assert.ok(pi.entries.some((entry) => entry.customType === "pi-control-plane-todo"));

    const reloaded = await boot();
    const resumedCtx = makeCtx({ branchEntries: [], cwd: workspace });
    let resumedOverlay: { render(width: number): string[] } | undefined;
    resumedCtx.ui.setWidget = (key: string, factory: unknown) => {
      if (key !== "control-plane-todo" || typeof factory !== "function") return;
      factory(
        {
          requestRender() {},
          showOverlay: (component: { render(width: number): string[] }) => {
            resumedOverlay = component;
            return { hide() {} };
          },
        },
        { fg: (_color: string, text: string) => text },
      );
    };
    await reloaded.emit("session_start", { type: "session_start", reason: "new" }, resumedCtx);
    assert.match(resumedOverlay!.render(44).join("\n"), /○ \[1\] Keep visible/);

    const resumedTool = reloaded.tools.get("todo");
    await resumedTool!.execute("todo-2", { op: "done", id: 1 }, undefined, undefined, resumedCtx);
    assert.deepEqual(resumedOverlay!.render(44), [], "completed tasks leave the live widget");
    assert.deepEqual(
      reloaded.entries.find((entry) => entry.customType === "pi-control-plane-todo-complete")?.data,
      { message: "Task [1] - Keep visible has completed." },
      "completion stays visible in the conversation transcript",
    );

    await reloaded.emit("session_tree", { type: "session_tree" }, makeCtx({ branchEntries: [], cwd: workspace }));
    assert.deepEqual(resumedOverlay!.render(44), []);
    ownerWidget?.dispose?.();
    assert.equal(overlayHides, 1, "session UI cleanup removes overlay");
  } finally {
    if (oldStateDirectory === undefined) delete process.env.PI_CONTROL_PLANE_STATE_DIR;
    else process.env.PI_CONTROL_PLANE_STATE_DIR = oldStateDirectory;
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("describeDiagnostic: glyph/tone/label per kind, unknown kind pending", () => {
  assert.deepEqual(describeDiagnostic({ kind: "blocked-read-before-edit", toolName: "write", at: "T" }), {
    glyph: "✗", tone: "error", label: "Blocked: read before edit", subject: '"write"', at: "T",
  });
  assert.deepEqual(describeDiagnostic({ kind: "backup-before-edit", target: "/p/f", at: "T" }), {
    glyph: "✓", tone: "success", label: "Backup before edit", subject: "/p/f", at: "T",
  });
  const consult = describeDiagnostic({ kind: "advisor-consult" });
  assert.equal(consult.glyph, "◐");
  assert.equal(consult.tone, "warning");
  assert.deepEqual(describeDiagnostic({ kind: "something-new" }), {
    glyph: "○", tone: "dim", label: "something-new", subject: "", at: "",
  });
  for (const data of [{ kind: "something-new" }, { kind: "read-out-of-scope-denied" }, undefined]) {
    const row = describeDiagnostic(data);
    assert.ok(!JSON.stringify(row).includes("?"), "no bare ? anywhere");
  }
});

test("diagnostic entry renderer paints an opaque background and spacing", () => {
  const themeCalls: string[] = [];
  const theme = {
    fg: (color: string, text: string) => { themeCalls.push(`fg:${color}`); return text; },
    bg: (color: string, text: string) => { themeCalls.push(`bg:${color}`); return `[${color}]${text}`; },
  };
  class FakeBox { args: unknown[]; children: unknown[] = []; constructor(...args: unknown[]) { this.args = args; } addChild(c: unknown) { this.children.push(c); } }
  class FakeText { text: string; px?: number; py?: number; constructor(text: string, px?: number, py?: number) { this.text = text; this.px = px; this.py = py; } }
  class FakeContainer { children: unknown[] = []; addChild(c: unknown) { this.children.push(c); } }
  class FakeSpacer { lines?: number; constructor(lines?: number) { this.lines = lines; } }
  const entry = buildDiagnosticEntry(
    { kind: "blocked-read-before-edit", toolName: "write", at: "T" },
    theme,
    { Box: FakeBox as never, Text: FakeText as never, Container: FakeContainer as never, Spacer: FakeSpacer as never },
  ) as FakeContainer;
  assert.equal(entry.children.length, 2);
  const [box, spacer] = entry.children as [FakeBox, FakeSpacer];
  assert.ok(box instanceof FakeBox && spacer instanceof FakeSpacer);
  assert.equal(spacer.lines, 1);
  assert.deepEqual(box.args.slice(0, 2), [1, 0]);
  const bgFn = box.args[2] as (s: string) => string;
  assert.equal(bgFn("x"), "[customMessageBg]x", "Box background paints customMessageBg");
  const text = box.children[0] as FakeText;
  assert.ok(text.text.includes("✗") && text.text.includes("Blocked: read before edit") && text.text.includes('"write"'));
  assert.ok(themeCalls.includes("fg:error") && themeCalls.includes("fg:text") && themeCalls.includes("fg:muted"));
  assert.ok(!themeCalls.includes("fg:accent"), "diagnostic rows never use accent");
  // A theme without bg() (older pi) still renders, just without the background fill.
  const plain = buildDiagnosticEntry({ kind: "advisor-consult" }, { fg: (_c, t) => t }, {
    Box: FakeBox as never, Text: FakeText as never, Container: FakeContainer as never, Spacer: FakeSpacer as never,
  }) as FakeContainer;
  assert.equal((plain.children[0] as FakeBox).args[2], undefined);
});

test("alt+i registered without shadowing Pi's alt+d editor binding", async () => {
  const pi = await boot();
  const branchEntries = [
    { type: "custom", customType: DIAGNOSTIC_ENTRY_TYPE, data: { kind: "advisor-consult", at: "T1" } },
    { type: "message", message: { role: "user" } },
    { type: "custom", customType: DIAGNOSTIC_ENTRY_TYPE, data: { kind: "read-out-of-scope-denied", target: "/etc/x", at: "T2" } },
  ];
  const ctx = makeCtx({ cwd: tmpRoot(), branchEntries });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.ok(pi.shortcuts.has("alt+i"));
  assert.ok(!pi.shortcuts.has("alt+d"));
  await pi.shortcuts.get("alt+i")!(ctx);
  const output = pi.entries.filter((e) => e.customType === "pi-control-plane-output").at(-1);
  assert.ok(output, "diagnostics emitted as chat entry when no modal UI exists");
  const data = output!.data as { title: string; lines: string[] };
  assert.equal(data.title, "diagnostics");
  assert.deepEqual(data.lines, ["◐ Advisor consult  T1", "✗ Read out of scope /etc/x  T2"]);
});

test("custom render paths never exceed the given width", async () => {
  const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;:]*m/g, "");
  const widths = [0, 1, 12, 24, 40, 80, 120];
  const check = (label: string, render: (w: number) => string[]) => {
    for (const w of widths) {
      for (const line of render(w)) {
        assert.ok(Array.from(stripAnsi(line)).length <= w, `${label} overflows at ${w}: ${line}`);
      }
    }
  };
  const theme = {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
  };
  const tui = { requestRender() {}, stop() {}, start() {} };
  type Factory = (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => { render: (w: number) => string[] };

  const pi = await boot();
  const root = tmpRoot();
  const diagnostics = Array.from({ length: 3 }, (_, i) => ({
    type: "custom", customType: DIAGNOSTIC_ENTRY_TYPE,
    data: { kind: "backup-before-edit", target: `/${"long/".repeat(30)}f${i}.txt`, at: "2026-09-16T00:00:00.000Z" },
  }));
  const ctx = makeCtx({ cwd: root, withCustom: true, customChoice: "no", branchEntries: diagnostics });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

  for (const key of ["alt+h", "ctrl+alt+t", "alt+i"]) {
    const before = ctx.customCalls.length;
    await pi.shortcuts.get(key)!(ctx);
    assert.equal(ctx.customCalls.length, before + 1, `${key} opened a modal`);
    const component = (ctx.customCalls.at(-1) as Factory)(tui, theme, {}, () => {});
    check(key, component.render);
  }

  // Attended confirm with a 300-char command: header lines clipped at render time
  // on top of the existing safeDialogWidth clamp.
  await pi.commands.get("mode")!.handler("execute", ctx);
  const before = ctx.customCalls.length;
  await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "x".repeat(300) } }, ctx);
  assert.equal(ctx.customCalls.length, before + 1, "the attended dialog was shown");
  const dialog = (ctx.customCalls.at(-1) as Factory)(tui, theme, {}, () => {});
  check("attended confirm", dialog.render);
});


test("prompt lifecycle refreshes credits without blocking and exposes timing", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: requests / 100 } }));
  };
  try {
    const pi = new FakePi();
    await controlPlaneExtension(pi as never);
    const ctx = makeCtx();
    Object.assign(ctx.sessionManager, {
      getCwd: () => "/work/project", getSessionName: () => undefined, getEntries: () => [],
    });
    let footer: { render: (width: number) => string[] } | undefined;
    ctx.ui.setFooter = (factory: Function) => {
      footer = factory({}, { fg: (_color: string, text: string) => text }, {
        getGitBranch: () => undefined,
        getAvailableProviderCount: () => 1,
        getExtensionStatuses: () => new Map(),
      });
    };
    Object.assign(ctx, { modelRegistry: { getApiKeyForProvider: async () => "test-key" } });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 1, "session startup fetches the initial balance without waiting for a prompt");
    assert.match(footer!.render(140).join("\n"), /OpenRouter · \$9\.99/);
    await pi.emit("before_agent_start", { systemPrompt: "", systemPromptOptions: {} }, ctx);
    await pi.emit("message_update", { assistantMessageEvent: { type: "text_delta" } }, ctx);
    await pi.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openrouter",
        usage: { cost: { total: 0.2 } },
      },
    }, ctx);
    assert.match(
      footer!.render(140).join("\n"),
      /OpenRouter · ~\$9\.79 · Δ −\$0\.20/,
      "completed OpenRouter response cost updates the footer before endpoint billing settles",
    );
    await pi.emit("agent_end", { messages: [] }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 3);
    await pi.commands.get("control-ui")!.handler("timing", ctx);
    // The workload ledger: last turn (TTFT + total) and the cumulative line.
    const timingNotifications = ctx.notifications.slice(-3).map((n: { message: string }) => n.message).join("\n");
    assert.match(timingNotifications, /Last turn: first text [0-9.]+s · total [0-9.]+s/);
    assert.match(timingNotifications, /Workload: 1 turn · [0-9.]+s model time · avg [0-9.]+s\/turn/);
    // Every completed turn persists its own ledger entry.
    const timingEntries = pi.entries.filter((e) => e.customType === "pi-control-plane-timing");
    assert.equal(timingEntries.length, 1);
    assert.equal((timingEntries[0]!.data as { turns: number }).turns, 1);
    // A fresh instance restores the ledger from the session entries.
    const pi2 = new FakePi();
    await controlPlaneExtension(pi2 as never);
    const ctx2 = makeCtx({ branchEntries: [...pi.entries] });
    await pi2.emit("session_start", { reason: "resume" }, ctx2);
    await pi2.commands.get("control-ui")!.handler("timing", ctx2);
    const restored = ctx2.notifications.at(-1)!.message;
    assert.match(restored, /Workload: 1 turn · [0-9.]+s model time/);
    // The detailed footer carries the timer segment once a turn completed
    // (the footer factory reads detailedUI at render time, so no reload is
    // needed — and a reload on this ctx's empty branch would reset the ledger).
    await pi.commands.get("control-ui")!.handler("details", ctx);
    const detailLines = footer!.render(140).join("\n");
    assert.match(detailLines, /time [0-9.]+s · 1 turn/);
  } finally { globalThis.fetch = originalFetch; }
});

// ---- keybind consent (shift+tab conflict, resolved only with consent) ----

/** Runs a test against a FRESH fake agent dir, restoring the env afterwards. */
async function withFreshAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = tmpRoot();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

/** Drains the fire-and-forget consent flow: its only awaits are promise
 *  microtasks (fake ui.custom/confirm), so one event-loop turn suffices. */
const settleKeybindFlow = () => new Promise<void>((resolve) => setImmediate(resolve));

const consentPath = (agentDir: string) => path.join(agentDir, "control-plane-keys.json");
const bindingsPath = (agentDir: string) => path.join(agentDir, "keybindings.json");

test("keybind consent: default boots stay silent and never write the real agent dir", async () => {
  // The seeded file-scoped agent dir carries keep-pi-defaults, so a normal
  // boot neither prompts nor claims shift+tab, and every default-boot ctx
  // (even with withCustom) sees zero custom calls.
  const pi = await boot();
  assert.ok(!pi.shortcuts.has("shift+tab"), "no reserved claim without consent");
  assert.ok(pi.shortcuts.has("alt+p"));
  const ctx = makeCtx({ withCustom: true });
  await pi.emit("session_start", { reason: "startup" }, ctx);
    await settleKeybindFlow();
  assert.equal(ctx.customCalls.length, 0, "seeded consent suppresses the dialog");
  assert.equal(ctx.notifications.length, 0, "drift check is silent when nothing drifted");
});

test("keybind consent: claude preset unbinds thinking-cycle and claims shift+tab after consent", async () => {
  await withFreshAgentDir(async (agentDir) => {
    const pi = await boot();
    assert.ok(!pi.shortcuts.has("shift+tab"), "no claim before consent");
    const ctx = makeCtx({ withCustom: true, customChoices: ["claude"] });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await settleKeybindFlow();
    assert.equal(JSON.parse(fs.readFileSync(consentPath(agentDir), "utf8")).decision, "claude");
    assert.deepEqual(JSON.parse(fs.readFileSync(bindingsPath(agentDir), "utf8")), { "app.thinking.cycle": [] });
    assert.ok(ctx.notifications.some((n) => /shift\+tab now cycles modes/.test(n.message)));
    const pi2 = await boot();
    assert.ok(pi2.shortcuts.has("shift+tab"), "claim registers after consent");
    assert.ok(pi2.shortcuts.has("alt+p"), "alt+p is unconditional");
  });
});

test("keybind consent: custom key with no conflicts records consent without touching keybindings.json", async () => {
  await withFreshAgentDir(async (agentDir) => {
    const pi = await boot();
    const ctx = makeCtx({ withCustom: true, customChoices: ["custom", "ctrl+shift+m"] });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await settleKeybindFlow();
    const consent = JSON.parse(fs.readFileSync(consentPath(agentDir), "utf8"));
    assert.equal(consent.decision, "custom");
    assert.equal(consent.customKey, "ctrl+shift+m");
    assert.deepEqual(consent.unboundActions, []);
    assert.ok(!fs.existsSync(bindingsPath(agentDir)), "no unbinds needed, no file written");
    assert.ok(ctx.notifications.some((n) => /ctrl\+shift\+m now cycles modes/.test(n.message)));
    const pi2 = await boot();
    assert.ok(pi2.shortcuts.has("ctrl+shift+m"));
    assert.ok(!pi2.shortcuts.has("shift+tab"));
  });
});

test("keybind consent: custom key over a reserved builtin unbinds exactly that action, on explicit confirm", async () => {
  await withFreshAgentDir(async (agentDir) => {
    fs.writeFileSync(bindingsPath(agentDir), JSON.stringify({ "app.session.toggleSort": "ctrl+s", "app.thinking.toggle": "ctrl+t" }));
    const pi = await boot();
    const ctx = makeCtx({ withCustom: true, customChoices: ["custom", "ctrl+t"], confirmResult: true });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await settleKeybindFlow();
    assert.deepEqual(JSON.parse(fs.readFileSync(bindingsPath(agentDir), "utf8")), {
      "app.session.toggleSort": "ctrl+s",
      "app.thinking.toggle": [],
    });
    const consent = JSON.parse(fs.readFileSync(consentPath(agentDir), "utf8"));
    assert.deepEqual(consent.unboundActions, ["app.thinking.toggle"]);
    assert.ok(ctx.notifications.some((n) => /ctrl\+t now cycles modes/.test(n.message)));
  });
});

test("keybind consent: declining the unbind confirm changes nothing", async () => {
  await withFreshAgentDir(async (agentDir) => {
    fs.writeFileSync(bindingsPath(agentDir), JSON.stringify({ "app.thinking.toggle": "ctrl+t" }));
    const pi = await boot();
    const ctx = makeCtx({ withCustom: true, customChoices: ["custom", "ctrl+t"], confirmResult: false });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await settleKeybindFlow();
    assert.ok(!fs.existsSync(consentPath(agentDir)), "declined consent is not recorded");
    assert.deepEqual(JSON.parse(fs.readFileSync(bindingsPath(agentDir), "utf8")), { "app.thinking.toggle": "ctrl+t" });
    assert.ok(ctx.notifications.some((n) => /nothing was changed/i.test(n.message)));
  });
});

test("keybind consent: invalid and self-conflicting recordings re-prompt instead of writing", async () => {
  await withFreshAgentDir(async (agentDir) => {
    const pi = await boot();
    const ctx = makeCtx({ withCustom: true, customChoices: ["custom", "a", "alt+h", "ctrl+shift+m"] });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await settleKeybindFlow();
    assert.ok(ctx.notifications.some((n) => /needs ctrl, alt or super/.test(n.message)), "unmodified key refused");
    assert.ok(ctx.notifications.some((n) => /already used by this extension/.test(n.message)), "own shortcut refused");
    assert.equal(JSON.parse(fs.readFileSync(consentPath(agentDir), "utf8")).customKey, "ctrl+shift+m");
  });
});

test("keybind consent: esc at any stage records nothing", async () => {
  await withFreshAgentDir(async (agentDir) => {
    const pi = await boot();
    await pi.emit("session_start", { reason: "startup" }, ctxDialogEscapeAtDialog());
    await settleKeybindFlow();
    assert.ok(!fs.existsSync(consentPath(agentDir)), "dialog escape records nothing");

    const pi2 = await boot();
    const ctx = makeCtx({ withCustom: true, customChoices: ["custom", null] });
    await pi2.emit("session_start", { reason: "startup" }, ctx);
    await settleKeybindFlow();
    assert.ok(!fs.existsSync(consentPath(agentDir)), "recorder escape records nothing");
    assert.ok(ctx.notifications.some((n) => /recording cancelled/i.test(n.message)));

    function ctxDialogEscapeAtDialog() {
      return makeCtx({ withCustom: true, customChoices: [null] });
    }
  });
});

test("keybind consent: keep-pi-defaults records the decision and claims nothing", async () => {
  await withFreshAgentDir(async (agentDir) => {
    const pi = await boot();
    const ctx = makeCtx({ withCustom: true, customChoices: ["keep-pi-defaults"] });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await settleKeybindFlow();
    assert.equal(JSON.parse(fs.readFileSync(consentPath(agentDir), "utf8")).decision, "keep-pi-defaults");
    assert.ok(!fs.existsSync(bindingsPath(agentDir)), "keep never writes keybindings.json");
    assert.ok(ctx.notifications.some((n) => /Pi defaults kept/.test(n.message)));
    const pi2 = await boot();
    assert.ok(!pi2.shortcuts.has("shift+tab"));
    // A later session on the same consent does not re-prompt.
    const ctx2 = makeCtx({ withCustom: true });
    await pi2.emit("session_start", { reason: "resume" }, ctx2);
    await settleKeybindFlow();
    assert.equal(ctx2.customCalls.length, 0);
  });
});

test("keybind consent: re-bound unbind actions are reported as drift, never auto-repaired", async () => {
  await withFreshAgentDir(async (agentDir) => {
    fs.writeFileSync(consentPath(agentDir), JSON.stringify({ version: 1, decision: "claude", unboundActions: ["app.thinking.cycle"], decidedAt: "x" }));
    fs.writeFileSync(bindingsPath(agentDir), JSON.stringify({ "app.thinking.cycle": "shift+tab" }));
    const pi = await boot(); // claim still registered (claude consent)...
    assert.ok(pi.shortcuts.has("shift+tab"));
    const ctx = makeCtx({});
    await pi.emit("session_start", { reason: "resume" }, ctx);
    await settleKeybindFlow();
    assert.ok(ctx.notifications.some((n) => /app\.thinking\.cycle is bound again/.test(n.message)));
    assert.deepEqual(JSON.parse(fs.readFileSync(bindingsPath(agentDir), "utf8")), { "app.thinking.cycle": "shift+tab" }, "drift is not auto-repaired");
  });
});

test("keybind consent: a malformed consent file is reported, ignored, and replaceable", async () => {
  await withFreshAgentDir(async (agentDir) => {
    fs.writeFileSync(consentPath(agentDir), "{broken");
    const pi = await boot();
    assert.ok(!pi.shortcuts.has("shift+tab"), "malformed consent claims nothing");
    const ctx = makeCtx({ withCustom: true, customChoices: ["keep-pi-defaults"] });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await settleKeybindFlow();
    assert.ok(ctx.notifications.some((n) => /invalid and was ignored/.test(n.message)));
    assert.equal(JSON.parse(fs.readFileSync(consentPath(agentDir), "utf8")).decision, "keep-pi-defaults");
  });
});

test("/control-keys: usage, forced re-run, and conversion from keep to claude", async () => {
  await withFreshAgentDir(async (agentDir) => {
    const pi = await boot();
    const ctx = makeCtx({ withCustom: true });
    await pi.commands.get("control-keys")!.handler("now", ctx);
    await settleKeybindFlow();
    assert.ok(ctx.notifications.some((n) => /Usage: \/control-keys/.test(n.message)));
    assert.ok(!fs.existsSync(consentPath(agentDir)), "usage errors write nothing");
    const ctx2 = makeCtx({ withCustom: true, customChoices: ["claude"] });
    await pi.commands.get("control-keys")!.handler("", ctx2);
    await settleKeybindFlow();
    assert.equal(JSON.parse(fs.readFileSync(consentPath(agentDir), "utf8")).decision, "claude");
    assert.deepEqual(JSON.parse(fs.readFileSync(bindingsPath(agentDir), "utf8")), { "app.thinking.cycle": [] });
    assert.ok(ctx2.notifications.some((n) => /shift\+tab now cycles modes/.test(n.message)));
  });
});

// ---- thinking budget (anti-overexpansion) wiring ----

function thinkingCtx(level: string | undefined) {
  const aborts = { count: 0 };
  const ctx = { ...makeCtx({ cwd: tmpRoot() }), thinkingLevel: level, abort: () => { aborts.count += 1; } };
  return { ctx, aborts };
}
const assistantStart = { type: "message_start", message: { role: "assistant" } };
const thinkDelta = (n: number) => ({
  type: "message_update",
  message: { role: "assistant" },
  assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x".repeat(n) },
});
const settle = () => new Promise((r) => setTimeout(r, 20));
const budgetDiags = (pi: FakePi) =>
  pi.entries.filter((e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string }).kind === "blocked-thinking-overexpansion");

test("thinking budget: over budget aborts once, audits, and delivers the fix after agent_end", async () => {
  const pi = await boot();
  const { ctx, aborts } = thinkingCtx("low"); // 2000
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.emit("message_start", assistantStart, ctx);
  await pi.emit("message_update", thinkDelta(1500), ctx);
  assert.equal(aborts.count, 0);
  await pi.emit("message_update", thinkDelta(700), ctx);
  await pi.emit("message_update", thinkDelta(700), ctx); // late deltas before abort lands
  assert.equal(aborts.count, 1, "aborted exactly once");
  const diags = budgetDiags(pi);
  assert.equal(diags.length, 1);
  assert.deepEqual({ ...(diags[0].data as object), at: undefined }, { kind: "blocked-thinking-overexpansion", level: "low", chars: 2200, budget: 2000, at: undefined });
  assert.equal(pi.sentUserMessages.length, 0, "fix not sent mid-stream");
  await pi.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
  await settle();
  assert.equal(pi.sentUserMessages.length, 1);
  assert.match(pi.sentUserMessages[0], /Rule: thinking-budget/);
  await pi.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
  await settle();
  assert.equal(pi.sentUserMessages.length, 1, "fix delivered once");
});

test("thinking budget: under budget, text deltas, and level off never abort", async () => {
  const pi = await boot();
  const { ctx, aborts } = thinkingCtx("medium"); // 4000
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.emit("message_start", assistantStart, ctx);
  await pi.emit("message_update", thinkDelta(3000), ctx);
  await pi.emit("message_update", { ...thinkDelta(0), assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "y".repeat(50000) } }, ctx);
  const off = thinkingCtx(undefined);
  await pi.emit("message_start", assistantStart, off.ctx);
  await pi.emit("message_update", thinkDelta(100000), off.ctx);
  await pi.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
  await settle();
  assert.equal(aborts.count + off.aborts.count, 0);
  assert.equal(pi.sentUserMessages.length, 0);
});

test("thinking budget: cooldown gives two messages 2x room; /harness-thinking-budget off disables", async () => {
  const pi = await boot();
  const { ctx, aborts } = thinkingCtx("low");
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  for (let i = 0; i < 4; i++) {
    await pi.emit("message_start", assistantStart, ctx);
    await pi.emit("message_update", thinkDelta(3000), ctx); // >2000 budget, <4000 cooldown cap
  }
  assert.equal(aborts.count, 2, "trip, two exempt messages, trip again");
  await pi.commands.get("harness-thinking-budget")!.handler("off", ctx);
  await pi.emit("message_start", assistantStart, ctx);
  await pi.emit("message_start", assistantStart, ctx);
  await pi.emit("message_start", assistantStart, ctx);
  await pi.emit("message_update", thinkDelta(50000), ctx);
  assert.equal(aborts.count, 2, "disabled: no abort");
  await pi.commands.get("harness-thinking-budget")!.handler("on", ctx);
  // Deltas streamed while off are not counted; enforcement resumes from re-enable.
  await pi.emit("message_update", thinkDelta(2000), ctx);
  assert.equal(aborts.count, 2, "re-enabled: off-period thinking not counted");
  await pi.emit("message_update", thinkDelta(1), ctx);
  assert.equal(aborts.count, 3, "re-enabled: thinking after re-enable is enforced");
});
