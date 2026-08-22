/**
 * Pi Harness - externally constrained delegate runtime (spec sections 6.2, 7).
 *
 * Phase 2.1 refused delegation outright, on the finding that a nested Pi
 * session came up with no harness enforcing its contract. That finding was
 * right about enforcement and wrong about the mechanism, and the difference
 * turns out to matter.
 *
 * What is actually true of pi 0.84.1, measured from the runtime objects
 * rather than inferred:
 *
 *  - A nested `createAgentSession()` DOES load every globally discovered
 *    extension. The harness's own extension is in the child's extension
 *    runner, with its `session_start` and `tool_call` handlers registered.
 *  - Those extensions are never INITIALIZED. `session_start` is not
 *    dispatched into a nested session - not by default, and not when
 *    `sessionStartEvent` is supplied. So every handler is registered and
 *    inert, and the harness's gate, which begins `if (session === null)
 *    return`, does nothing at all.
 *  - With default options the child's active tool set is 34 tools including
 *    `bash`, `Agent` and `harness_delegate`. A child built carelessly can
 *    therefore shell out and delegate recursively.
 *  - An explicit `tools` allowlist is exact. `tools: ["read"]` yields exactly
 *    `["read"]` from both `getActiveToolNames()` and `getAllTools()`.
 *  - `customTools` are available with no parent extension involved.
 *  - A substituted `ResourceLoader` removes extensions, skills, prompt
 *    templates and AGENTS.md context entirely.
 *
 * So the enforcement boundary does not have to be an extension inside the
 * child, and it should not be: that was always a request that Pi run our
 * code on our behalf. It is the tool implementations themselves. A child that
 * holds only inline tools this module wrote cannot reach the filesystem
 * except through code that checks the scope, because there is no other tool
 * in its runtime to reach it with.
 *
 * Pure except where the filesystem is the subject: the scope check has to
 * touch real inodes to be worth anything.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Build the deliberately empty loader used for a child. The runtime object
 * must come from Pi itself; its extension runner writes internal fields even
 * when the extension list is empty. Kept here so the live mutation runner can
 * construct and attest the same boundary without loading this extension. */
export function isolatedDelegateResourceLoader(createRuntime: () => unknown): unknown {
  const runtime = createRuntime();
  const none = { diagnostics: [] };
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], ...none }),
    getPrompts: () => ({ prompts: [], ...none }),
    getThemes: () => ({ themes: [], ...none }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** What the child is allowed to reach. Read-only by construction. */
export interface DelegateRuntimeContract {
  contractId: string;
  /** Absolute roots the child may read under. Never widened in place. */
  readRoots: string[];
  /** Exact tool names the child's runtime may expose. */
  allowedTools: string[];
  /** Bytes any single read may return, so a delegate cannot exfiltrate a
   * whole tree through one call. */
  maxBytes: number;
}

export interface ScopeDecision {
  allowed: boolean;
  /** The canonical path of the object actually opened, when one was. */
  resolved: string | null;
  reason: string;
}

/**
 * Is `candidate` inside one of `roots`, both already canonical?
 *
 * String comparison is correct only because both sides are real paths from
 * the kernel; doing this on unresolved input is the bug it exists to avoid.
 */
function withinRoots(candidate: string, roots: string[]): boolean {
  return roots.some((root) => candidate === root || candidate.startsWith(root + path.sep));
}

/**
 * Open a file and authorize *the object that was opened*.
 *
 * The unsafe shape this replaces:
 *
 *     check(pathname) -> attacker swaps the symlink -> open(pathname)
 *
 * Every check here happens against a file descriptor that is already open,
 * so there is no window between the decision and the read: whatever the name
 * pointed at when we opened it is what we authorize and what we then read.
 *
 *  - `O_NOFOLLOW` refuses a symlink in the final component outright.
 *  - `/proc/self/fd/<n>` gives the kernel's own canonical path for the open
 *    description, which resolves symlinked *intermediate* directories too,
 *    and cannot be changed by anything that happens afterwards.
 *  - `fstat` on the same descriptor rejects a directory or device where a
 *    file was expected, and rejects `nlink > 1`: a hardlink alias is a
 *    second name for this inode that something outside the scope can hold,
 *    so the path being inside the scope does not mean the object is.
 *
 * Callers must read through the returned descriptor. Reopening by name would
 * reintroduce exactly the race this closes.
 */
export function openInScope(
  target: string,
  roots: string[],
  expect: "file" | "dir",
): { fd: number | null; decision: ScopeDecision } {
  const deny = (reason: string, resolved: string | null = null): { fd: null; decision: ScopeDecision } => ({
    fd: null,
    decision: { allowed: false, resolved, reason },
  });

  if (!path.isAbsolute(target)) return deny("path must be absolute");

  let fd: number;
  try {
    // O_NOFOLLOW makes a final-component symlink an error rather than a
    // redirect. O_DIRECTORY does the same job for the listing case.
    const flags =
      fs.constants.O_RDONLY |
      fs.constants.O_NOFOLLOW |
      (expect === "dir" ? fs.constants.O_DIRECTORY : 0);
    fd = fs.openSync(target, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return deny("refused: the final path component is a symlink");
    if (code === "ENOTDIR") return deny("refused: not a directory");
    return deny(`refused: cannot open (${code ?? "unknown"})`);
  }

  // From here on the descriptor is the subject. Nothing consults `target`.
  let resolved: string;
  try {
    resolved = fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    fs.closeSync(fd);
    return deny("refused: the opened object could not be canonicalized");
  }

  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(fd);
  } catch {
    fs.closeSync(fd);
    return deny("refused: the opened object could not be stat'd", resolved);
  }

  if (expect === "file" && !stat.isFile()) {
    fs.closeSync(fd);
    return deny("refused: not a regular file", resolved);
  }
  if (expect === "dir" && !stat.isDirectory()) {
    fs.closeSync(fd);
    return deny("refused: not a directory", resolved);
  }
  if (expect === "file" && stat.nlink > 1) {
    fs.closeSync(fd);
    return deny(
      `refused: the file has ${stat.nlink} links, so a name outside the delegated scope refers to the same object`,
      resolved,
    );
  }
  if (!withinRoots(resolved, roots)) {
    fs.closeSync(fd);
    return deny(`refused: ${resolved} is outside the delegated read scope`, resolved);
  }

  return { fd, decision: { allowed: true, resolved, reason: `authorized ${resolved}` } };
}

/** Canonicalise the contract's roots once, so every later comparison is
 * between real paths. A root that does not resolve is dropped rather than
 * carried as a string nothing can match. */
export function canonicalRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    try {
      out.push(fs.realpathSync(root));
    } catch {
      /* a root that does not exist grants nothing */
    }
  }
  return out;
}

export interface DelegateToolCall {
  tool: string;
  argument: string;
  allowed: boolean;
  resolved: string | null;
  reason: string;
  at: string;
}

export interface DelegateRuntimeLog {
  /** Every tool call the child actually made, in order. */
  calls: DelegateToolCall[];
  /** Read-scope expansions the child asked for and has not been answered. */
  pendingRequests: string[];
  /** Enforcement-layer checks made around tool execution. A clean initial
   * attestation is not enough when Pi exposes a mutable tool surface. */
  attestationChecks?: number;
  /** Violations observed by a per-call attestation. Once non-empty the
   * caller must discard the handoff. */
  runtimeViolations?: string[];
}

export interface DelegateToolAttestation {
  /** Called immediately before and after each tool implementation. Throwing
   * aborts the invocation; the wrapper also records the violation so a model
   * cannot turn a failed tool call into an accepted handoff. */
  attest: (phase: "before" | "after", tool: string) => void;
}

/**
 * The child's entire tool surface.
 *
 * Three tools, all read-only, all closing over the same canonical roots.
 * There is deliberately no way to widen `roots` from in here: a grant
 * replaces the contract and rebuilds the tools, so an approved expansion is
 * a new runtime rather than a mutated one.
 */
export function buildDelegateTools(
  contract: DelegateRuntimeContract,
  log: DelegateRuntimeLog,
  now: () => string = () => new Date().toISOString(),
  runtimeAttestation?: DelegateToolAttestation,
): unknown[] {
  const roots = canonicalRoots(contract.readRoots);

  const record = (tool: string, argument: string, decision: ScopeDecision): void => {
    log.calls.push({
      tool,
      argument,
      allowed: decision.allowed,
      resolved: decision.resolved,
      reason: decision.reason,
      at: now(),
    });
  };
  const text = (body: string) => ({ content: [{ type: "text", text: body }] });

  const guarded = <T>(tool: string, execute: () => Promise<T>): Promise<T> => {
    const check = (phase: "before" | "after"): void => {
      if (!runtimeAttestation) return;
      log.attestationChecks = (log.attestationChecks ?? 0) + 1;
      try {
        runtimeAttestation.attest(phase, tool);
      } catch (error) {
        const violation = `${phase} ${tool}: ${String(error)}`;
        (log.runtimeViolations ??= []).push(violation);
        throw error;
      }
    };
    check("before");
    return execute().then(
      (value) => {
        check("after");
        return value;
      },
      (error) => {
        // Even a failed implementation is followed by attestation. If both
        // fail, runtime drift is the authority failure and is retained in
        // runtimeViolations; the original tool error still reaches Pi.
        try { check("after"); } catch { /* recorded above */ }
        throw error;
      },
    );
  };

  return [
    {
      name: "scoped_read",
      label: "Scoped Read",
      description:
        "Read a file inside the delegated read scope. Absolute paths only. Symlinks and hardlinked files are refused, and the authorization applies to the object actually opened.",
      promptSnippet: "scoped_read(file_path) - read a file inside the delegated scope",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string", description: "Absolute path to read." } },
        required: ["file_path"],
      },
      execute: async (_id: unknown, params: unknown) => guarded("scoped_read", async () => {
        const file = String((params as { file_path?: unknown })?.file_path ?? "");
        const { fd, decision } = openInScope(file, roots, "file");
        record("scoped_read", file, decision);
        if (fd === null) return text(decision.reason);
        try {
          // Read through the authorized descriptor. Reopening by name here
          // would put the race straight back.
          const buffer = Buffer.alloc(contract.maxBytes);
          const read = fs.readSync(fd, buffer, 0, contract.maxBytes, 0);
          const body = buffer.subarray(0, read).toString("utf8");
          const truncated = read >= contract.maxBytes ? `\n[truncated at ${contract.maxBytes} bytes]` : "";
          return text(body + truncated);
        } finally {
          fs.closeSync(fd);
        }
      }),
    },
    {
      name: "scoped_list",
      label: "Scoped List",
      description: "List a directory inside the delegated read scope. Absolute paths only.",
      promptSnippet: "scoped_list(dir_path) - list a directory inside the delegated scope",
      parameters: {
        type: "object",
        properties: { dir_path: { type: "string", description: "Absolute directory path." } },
        required: ["dir_path"],
      },
      execute: async (_id: unknown, params: unknown) => guarded("scoped_list", async () => {
        const dir = String((params as { dir_path?: unknown })?.dir_path ?? "");
        const { fd, decision } = openInScope(dir, roots, "dir");
        record("scoped_list", dir, decision);
        if (fd === null) return text(decision.reason);
        try {
          // The descriptor authorized the directory; entries are named
          // relative to it and each is re-checked when it is opened.
          const entries = fs.readdirSync(decision.resolved as string, { withFileTypes: true });
          return text(
            entries
              .map((e) => `${e.isDirectory() ? "d" : e.isSymbolicLink() ? "l" : "-"} ${e.name}`)
              .join("\n") || "(empty)",
          );
        } finally {
          fs.closeSync(fd);
        }
      }),
    },
    {
      name: "request_read_scope",
      label: "Request Read Scope",
      description:
        "Ask the coordinator to widen the delegated READ scope. This does not grant anything; it records a request the user must answer. Nothing else about the contract can be requested.",
      promptSnippet: "request_read_scope(path, reason) - ask the coordinator for more read scope",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path the task needs." },
          reason: { type: "string", description: "Why the task cannot proceed without it." },
        },
        required: ["path", "reason"],
      },
      execute: async (_id: unknown, params: unknown) => guarded("request_read_scope", async () => {
        const p = params as { path?: unknown; reason?: unknown };
        const request = `${String(p.path ?? "")} :: ${String(p.reason ?? "")}`;
        log.pendingRequests.push(request);
        record("request_read_scope", request, {
          allowed: true,
          resolved: null,
          reason: "recorded; awaiting a decision outside this session",
        });
        return text(
          [
            "Recorded. This is a request, not a grant: nothing has been widened and this",
            "session will not receive the path unless the coordinator approves it.",
            "Stop work that depends on it and report what you have, marking the gap",
            "under UNRESOLVED.",
          ].join("\n"),
        );
      }),
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Attestation
 * ------------------------------------------------------------------ */

export interface Attestation {
  ok: boolean;
  activeTools: string[];
  allTools: string[];
  extensions: number;
  skills: number;
  prompts: number;
  agentsFiles: string[];
  systemPromptChars: number;
  violations: string[];
}

/** The parts of a Pi session this module reads. Narrow on purpose: an
 * attestation that depended on Pi internals would break silently on upgrade,
 * and silence is the one thing it cannot afford. */
export interface AttestableSession {
  getActiveToolNames?: () => string[];
  getAllTools?: () => Array<{ name?: string }>;
  systemPrompt?: string;
  resourceLoader?: {
    getExtensions?: () => { extensions?: unknown[] };
    getSkills?: () => { skills?: unknown[] };
    getPrompts?: () => { prompts?: unknown[] };
    getAgentsFiles?: () => { agentsFiles?: Array<{ path: string }> };
  };
}

/**
 * Compare what was asked for against what Pi actually built.
 *
 * Configuration is a request. This reads the constructed session back and
 * reports the difference, because every interesting failure in this area is
 * one where the options looked right and the runtime did not match them -
 * and the whole of Phase 2.1's delegation defect was of exactly that kind.
 *
 * Set equality on tools, not containment: a *missing* tool is also a
 * mismatch, and a delegate that silently lost the tool it needed would
 * fabricate an answer rather than fail, which is what happened live.
 */
export function attestChild(
  session: AttestableSession,
  contract: DelegateRuntimeContract,
): Attestation {
  const violations: string[] = [];
  const safe = <T>(fn: () => T, fallback: T, label: string): T => {
    try {
      return fn();
    } catch (error) {
      violations.push(`${label} could not be inspected: ${String(error)}`);
      return fallback;
    }
  };

  const activeTools = safe(() => session.getActiveToolNames?.() ?? [], [], "active tools").slice().sort();
  const allTools = safe(
    () => (session.getAllTools?.() ?? []).map((t) => String(t?.name ?? "")),
    [],
    "all tools",
  ).slice().sort();
  const loader = session.resourceLoader;
  const extensions = safe(() => loader?.getExtensions?.()?.extensions?.length ?? 0, -1, "extensions");
  const skills = safe(() => loader?.getSkills?.()?.skills?.length ?? 0, -1, "skills");
  const prompts = safe(() => loader?.getPrompts?.()?.prompts?.length ?? 0, -1, "prompt templates");
  const agentsFiles = safe(
    () => (loader?.getAgentsFiles?.()?.agentsFiles ?? []).map((a) => a.path),
    [],
    "context files",
  );
  const systemPromptChars = safe(() => (session.systemPrompt ?? "").length, -1, "system prompt");

  const expected = contract.allowedTools.slice().sort();
  const unexpected = activeTools.filter((t) => !expected.includes(t));
  const missing = expected.filter((t) => !activeTools.includes(t));
  if (unexpected.length > 0) violations.push(`unexpected active tool(s): ${unexpected.join(", ")}`);
  if (missing.length > 0) violations.push(`contracted tool(s) missing: ${missing.join(", ")}`);

  // `getAllTools` is checked too. A tool that is registered but inactive is
  // one `setActiveToolsByName` call away from being active, and that call is
  // reachable from inside the child's own process.
  const unexpectedAll = allTools.filter((t) => t.length > 0 && !expected.includes(t));
  if (unexpectedAll.length > 0) violations.push(`tool(s) registered but not contracted: ${unexpectedAll.join(", ")}`);

  if (extensions !== 0) violations.push(`${extensions} ambient extension(s) loaded`);
  if (skills !== 0) violations.push(`${skills} ambient skill(s) loaded`);
  if (prompts !== 0) violations.push(`${prompts} ambient prompt template(s) loaded`);
  if (agentsFiles.length > 0) violations.push(`ambient context file(s): ${agentsFiles.join(", ")}`);

  return {
    ok: violations.length === 0,
    activeTools,
    allTools,
    extensions,
    skills,
    prompts,
    agentsFiles,
    systemPromptChars,
    violations,
  };
}

/**
 * Did the child stay inside its tool contract while it ran?
 *
 * The initial attestation says what the runtime was at construction. This
 * says what the child actually did, which is a different claim: Pi exposes
 * `setActiveToolsByName` on the session object, so a clean start is not by
 * itself evidence about the end.
 */
export function attestCalls(log: DelegateRuntimeLog, contract: DelegateRuntimeContract): string[] {
  const drift: string[] = [];
  for (const call of log.calls) {
    if (!contract.allowedTools.includes(call.tool)) {
      drift.push(`invoked a tool outside the contract: ${call.tool}`);
    }
  }
  return drift;
}
