/**
 * Integration tests that load the real extension entry against a fake Pi API.
 * Covers wiring that pure-module tests cannot: attended confirmation flow,
 * interpretation guard lifecycle, command handling, restoration, and the
 * injected system-prompt block.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import controlPlaneExtension, {
  formatConfirmDetail,
  formatDiagnosticLine,
} from "../extensions/control-plane.ts";
import { REQUIRED_SECTIONS } from "../src/control-plane/interpretation.ts";
import { STATE_ENTRY_TYPE, DIAGNOSTIC_ENTRY_TYPE } from "../src/control-plane/types.ts";

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
  allToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "local_web_search", "todo"];
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
    ui.custom = async (factory: unknown) => {
      customCalls.push(factory);
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

test("registers the commands, the local_web_search tool, and the shortcuts", async () => {
  const pi = await boot();
  for (const name of ["context", "task", "mode", "interpret", "scratchpad", "bwrap", "harness-rules"]) {
    assert.ok(pi.commands.has(name), `missing /${name}`);
  }
  assert.ok(!pi.commands.has("phase") && !pi.commands.has("autonomy"), "phase/autonomy merged into /mode");
  assert.ok(pi.tools.has("local_web_search"), "local_web_search tool not registered");
  for (const key of ["alt+c", "alt+p"]) {
    assert.ok(pi.shortcuts.has(key), `missing shortcut ${key}`);
  }
});

test("defaults after session_start: Discuss mode shown in status", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Discuss \| No task/);
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
  assert.match(ctx.statuses["control-plane"] ?? "", /Execute/);
  const audit = pi.entries.find(
    (e) => e.customType === DIAGNOSTIC_ENTRY_TYPE && (e.data as { kind?: string })?.kind === "phase-switch-via-dialog",
  );
  assert.ok(audit, "phase switch must be audited");
  const d = audit!.data as Record<string, unknown>;
  assert.equal(d.actor, "user");
  assert.equal(d.provenance, "attended-phase-dialog");
  assert.equal(d.from, "discuss");
  assert.equal(d.to, "execute");
  assert.equal(d.blockedTool, "write");
  assert.equal(d.blockedRule, "phase:discuss");
});

test("phase-switch dialog: decline switch → identical plain block, no phase change", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  const titles: string[] = [];
  scriptConfirm(ctx, { "Switch to Execute phase?": false }, titles);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /phase:discuss/, "declined switch blocks exactly as today");
  assert.deepEqual(titles, ["Switch to Execute phase?"], "no per-call confirm after a declined switch");
  assert.match(ctx.statuses["control-plane"] ?? "", /Discuss/, "phase must not change on decline");
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
  assert.match(ctx.statuses["control-plane"] ?? "", /Execute/);
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
  const titles: string[] = [];
  scriptConfirm(ctx, {}, titles);
  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "1", toolName: "write", input: { path: "f.txt", content: "x" } },
    ctx,
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /phase:discuss/);
  assert.deepEqual(titles, [], "no confirmation dialog without a UI");
});

// ---- read-before-edit (hard rule) ----
// An edit/write of an EXISTING file must have read that exact file this session
// (and it must be unchanged on disk since). New files are exempt; the rule
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

test("backup-before-edit: a failed snapshot blocks the mutation and leaves the target unchanged", async () => {
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
    const blocked = (await pi.emit(
      "tool_call",
      { type: "tool_call", toolCallId: "2", toolName: "edit", input: { path: "data.txt", oldText: "keep-me", newText: "nope" } },
      ctx,
    )) as { block?: boolean; reason?: string };
    assert.equal(blocked?.block, true, "a failed backup must block the mutation (fail closed)");
    assert.match(blocked?.reason ?? "", /backup-before-edit/);
    const failed = findBackupFailedAudit(pi);
    assert.ok(failed, "a backup-before-edit-failed diagnostic must be emitted");
    assert.equal(fs.readFileSync(file, "utf8"), PRE, "the target file is untouched when the backup fails");
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
  await pi.commands.get("task")!.handler("set do the thing", ctx);
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

test("/interpret guards the turn: all tools blocked, diagnostic recorded, state restored after", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);

  await pi.commands.get("interpret")!.handler("Refactor the loader and encourage tool use", ctx);
  assert.equal(pi.sentUserMessages.length, 1);
  assert.match(ctx.statuses["control-plane"] ?? "", /Interpreting \(tools disabled\)/);

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
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Execute \(attended\) \| Task pending review/);

  // Accept adopts the brief.
  await pi.commands.get("task")!.handler("accept", ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Task accepted/);
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
  assert.match(ctx.statuses["control-plane"] ?? "", /Task pending review/);
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
  assert.match(ctx.statuses["control-plane"] ?? "", /Interpreting \(tools disabled\)/, "guard must survive the stale agent_end");
  // The real interpretation turn then runs and completes normally.
  await startInterpretTurn(pi, ctx);
  await pi.emit(
    "agent_end",
    { type: "agent_end", messages: [{ role: "assistant", content: validInterpretationResponse() }] },
    ctx,
  );
  assert.doesNotMatch(ctx.statuses["control-plane"] ?? "", /Interpreting \(tools disabled\)/);
  assert.match(ctx.statuses["control-plane"] ?? "", /Task pending review/);
});

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
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Discuss/);
  assert.ok(ctx.notifications.some((n) => /malformed/i.test(n.message)));
});

test("sandboxed resolves to Execute (restricted) with the required warning and honest status", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("sandboxed", ctx);
  assert.ok(
    ctx.notifications.some((n) => /not a security sandbox/i.test(n.message)),
    "sandbox warning required",
  );
  assert.match(ctx.statuses["control-plane"] ?? "", /Execute \(restricted\)/i);
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
  assert.ok(result?.systemPrompt?.includes("Mode: Discuss"));
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
  assert.match(ctx.statuses["control-plane"] ?? "", /Task accepted/);
  await pi.commands.get("task")!.handler("clear", ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Task accepted/, "clear without force and without UI must not clear");
  await pi.commands.get("task")!.handler("clear force", ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /No task/);
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
  assert.deepEqual([...pi.activeTools].sort(), ["find", "grep", "ls", "read"]);

  const pi2 = new (pi.constructor as new () => FakePi)();
  await controlPlaneExtension(pi2 as never);
  const ctx2 = makeCtx({ cwd: root, branchEntries: pi.entries.filter((e) => e.customType === STATE_ENTRY_TYPE) });
  await pi2.emit("session_start", { type: "session_start", reason: "resume" }, ctx2);
  assert.deepEqual([...pi2.activeTools].sort(), ["find", "grep", "ls", "read"], "profile toggles reapplied on restore");
});

test("mode cycle hotkey advances through all six modes", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot() });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Plan/);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Execute \(attended\)/);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Execute \(restricted\)/);
  await pi.shortcuts.get("alt+p")!(ctx);
  // No task brief accepted in this test, so unattended correctly reports its
  // mutation gate rather than a bare "Unattended" label.
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Execute \(unattended — no accepted task, mutation blocked\)/);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Verify/);
  await pi.shortcuts.get("alt+p")!(ctx);
  assert.match(ctx.statuses["control-plane"] ?? "", /Mode: Discuss/);
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
  const result = (await tool!.execute("call-1", { query: "test query" }, undefined, undefined, {})) as {
    output: string;
  };
  assert.equal(typeof result.output, "string");
  assert.ok(result.output.length > 0);
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

test("Unattended: tool_call is blocked without an accepted task, and logs every allowed call once a task exists", async () => {
  const pi = await boot();
  const root = tmpRoot();
  const ctx = makeCtx({ cwd: root });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute-restricted", ctx);
  await pi.commands.get("mode")!.handler("unattended", ctx);
  assert.ok(
    ctx.notifications.some((n) => /no task brief is accepted/i.test(n.message)),
    "must warn that mutation is gated without an accepted task",
  );

  const blocked = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolName: "write", input: { path: "f.txt", content: "" } },
    ctx,
  )) as { block?: boolean; reason?: string } | undefined;
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /accepted task brief/i);

  // Accept a task, then a mutating call in-root should be allowed AND logged
  // as a diagnostic entry (the audit trail nobody-is-watching requires).
  await pi.commands.get("task")!.handler("set do the thing", ctx);
  const entriesBefore = pi.entries.length;
  const allowed = (await pi.emit(
    "tool_call",
    { type: "tool_call", toolName: "write", input: { path: path.join(root, "f.txt"), content: "" } },
    ctx,
  )) as { block?: boolean } | undefined;
  assert.equal(allowed?.block, undefined, "allowed calls return undefined, same contract as every other mode");
  const diagnostic = pi.entries.slice(entriesBefore).find((e) => e.customType === DIAGNOSTIC_ENTRY_TYPE);
  assert.ok(diagnostic, "an allowed unattended mutation must be logged for later review");
  assert.equal((diagnostic!.data as { kind: string }).kind, "unattended-call-allowed");

  // Reads are not logged (would drown out the signal) and are unaffected by
  // the task-brief gate either way.
  const entriesBeforeRead = pi.entries.length;
  await pi.emit("tool_call", { type: "tool_call", toolName: "read", input: { path: path.join(root, "f.txt") } }, ctx);
  assert.equal(pi.entries.length, entriesBeforeRead, "reads must not add an audit entry");
});

// ---- Advisor-consult budget (soft policy) --------------------------------
// harness_delegate kind:"advisor" is the cloud advisor. The first consult per
// accepted task (or per session when none) is silent; further consults hit the
// attended Yes/No/Always gate; "Always" lifts the cap for the session. It only
// downgrades/gates the attended path and never loosens a hard block.
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

test("advisor budget: a new task resets the per-task budget", async () => {
  const pi = await boot();
  const ctx = makeCtx({ cwd: tmpRoot(), withCustom: true, customChoice: "no" });
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.commands.get("mode")!.handler("execute", ctx);
  await pi.commands.get("task")!.handler("set brief A", ctx);
  await pi.emit("tool_call", consult("1"), ctx); // free under task A
  await pi.commands.get("task")!.handler("set brief B", ctx);
  const r = await pi.emit("tool_call", consult("2"), ctx); // first under task B
  assert.equal(r, undefined, "the first consult under a new task is free again");
  assert.deepEqual(ctx.customCalls, [], "no gate on the first consult of the new task");
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
  const ctx = makeCtx({ cwd: tmpRoot() }); // Discuss default; the phase-switch dialog is declined (confirm=false)
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
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

test("diagnostic line: interpretation block keeps the real tool name; other kinds render their kind, never a bare ?", () => {
  const interpret = formatDiagnosticLine({ kind: "blocked-tool-during-interpret", toolName: "write", at: "T" });
  assert.match(interpret, /blocked tool "write" during interpretation \(T\)/);

  // The bug: a diagnostic with no toolName used to render as `blocked tool "?"
  // during interpretation`. It must now render its real kind + subject, and
  // never claim "during interpretation" for an unrelated kind.
  const denied = formatDiagnosticLine({ kind: "read-out-of-scope-denied", target: "/etc/hostname", at: "T" });
  assert.ok(!denied.includes('"?"'), "no bare ? placeholder");
  assert.ok(!denied.includes("during interpretation"), "an unrelated kind is not mislabelled");
  assert.match(denied, /read-out-of-scope-denied \/etc\/hostname \(T\)/);

  const consult = formatDiagnosticLine({ kind: "advisor-consult", at: "T" });
  assert.ok(!consult.includes('"?"'));
  assert.match(consult, /advisor-consult \(T\)/);

  // An interpret block that genuinely has no name shows no "?" either.
  assert.ok(!formatDiagnosticLine({ kind: "blocked-tool-during-interpret", at: "T" }).includes('"?"'));
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

  for (const toolName of ["harness_find_capability", "harness_memory_search", "harness_request_scope"]) {
    const r = await pi.emit("tool_call", { type: "tool_call", toolCallId: "1", toolName, input: {} }, ctx);
    assert.equal(r, undefined, `${toolName} is allowed`);
  }
  assert.deepEqual(ctx.customCalls, [], "read-effect harness tools show no dialog at all");

  // The ones that change something keep their gate (declined here -> blocked).
  for (const toolName of ["harness_note", "harness_set_posture", "harness_delegate"]) {
    const r = (await pi.emit("tool_call", { type: "tool_call", toolCallId: "2", toolName, input: {} }, ctx)) as {
      block?: boolean;
    };
    assert.equal(r?.block, true, `${toolName} still gates`);
  }
  assert.equal(ctx.customCalls.length, 3, "one dialog each for the write/escalate tools");
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
