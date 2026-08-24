/**
 * Pi Harness - the shell boundary (spec section 9).
 *
 * The spec's position, which this module implements literally: arbitrary
 * shell access cannot honestly be called hard-scoped just because a model
 * was told to stay in the project. So the harness does two things - it
 * blocks Pi's unrestricted builtin `bash`, and it offers `pi_harness_bash`,
 * which runs under an OS-level sandbox or does not run at all.
 *
 * The argv assembly is *not* reimplemented here. It is imported from
 * src/control-plane/sandbox.ts, which already owns it and is already tested.
 * A second bwrap command builder is a second thing to drift, and the two
 * would drift in the direction that matters least visibly: a mount flag
 * fixed in one place and not the other.
 *
 * What this module adds on top is the part that is harness policy rather
 * than command assembly:
 *
 *   1. Fail-safe refusal. If bubblewrap is unavailable, `plan()` returns a
 *      refusal. There is no fallback to an unenforced shell - a sandbox that
 *      silently degrades to no sandbox is worse than no sandbox, because the
 *      user believes the first thing.
 *   2. Mounts derived from scope, not from convenience. The scope root is
 *      the only read-write mount. User data outside it is never bound.
 *   3. Network off unless the scope object carries an explicit grant.
 */

import * as path from "node:path";

import { buildSandboxedCommand, shQuote } from "../control-plane/sandbox.ts";
import type { HarnessConfig, ScopeState } from "./types.ts";

export { shQuote };

/** Injected so the availability check is testable without depending on
 * whether the machine running the tests happens to have bwrap. */
export interface SandboxProbe {
  /** True when a working `bwrap` binary is on PATH. */
  bwrapAvailable(): boolean;
  exists(p: string): boolean;
}

export type SandboxPlan =
  | { ok: true; command: string; mounts: { readWrite: string; readOnly: string[]; network: boolean; writable: boolean } }
  | { ok: false; reason: string; rule: string };

/** HOME-relative credential paths that are always shadowed inside the sandbox
 * as defense-in-depth (dirs -> empty tmpfs, files -> /dev/null), reused across
 * read and write mode. Out-of-scope secrets are already unreachable because
 * only the scope root and the configured read-only paths are ever bound; this
 * closes the residual case where a user adds a broad read-only mount (e.g. a
 * ro-bound $HOME) that would otherwise expose them. Only shadowed when they
 * fall UNDER a bound read-only path - shadowing a path whose parent is not in
 * the namespace would make bwrap error and take the whole shell down. bwrap has
 * no globbing, so this covers known credential paths, not arbitrary *.env files
 * inside the (bound) scope root - see PHASE4-RO-SHELL-DESIGN.md. */
const SENSITIVE_SHADOW_DIRS_REL: readonly string[] = [".ssh", ".aws", ".gnupg", ".config/gh"];
const SENSITIVE_SHADOW_FILES_REL: readonly string[] = [".netrc", ".git-credentials", ".pgpass"];

function underABoundPath(p: string, boundPaths: string[]): boolean {
  return boundPaths.some((b) => p === b || p.startsWith(b + path.sep));
}

/**
 * The install prefix of the interpreter currently running the harness, to be
 * mounted read-only so a runtime living outside the system prefixes (nvm, asdf,
 * Nix, a homedir install) still resolves inside the sandbox. Without this, a
 * `node --test` inside the sandbox fails with "node: not found" on any machine
 * whose node is under $HOME - the exact case that made the sandboxed shell look
 * broken and pushed work toward heavier authority (GATE-FATIGUE-REDESIGN.md P4).
 *
 * `<prefix>/bin/node` -> `<prefix>`. Refused (returns null) when the computed
 * prefix is $HOME itself, an ancestor of $HOME, or a filesystem root: binding
 * any of those would drag the user's whole home - credentials included - into
 * the sandbox, which is precisely what the mount table exists to prevent.
 * Narrow toolchain prefix or nothing.
 */
export function runtimeToolchainPath(execPath: string, homeDir?: string): string | null {
  if (typeof execPath !== "string" || execPath.length === 0) return null;
  const prefix = path.dirname(path.dirname(execPath));
  if (prefix === "" || prefix === path.sep || path.dirname(prefix) === prefix) return null;
  if (homeDir !== undefined && homeDir.length > 0) {
    const home = homeDir.replace(new RegExp(`${path.sep}+$`), "");
    // prefix === home, or prefix is an ANCESTOR of home (home under prefix).
    if (prefix === home || home.startsWith(prefix + path.sep)) return null;
  }
  return prefix;
}

function sensitiveShadows(
  rel: readonly string[],
  homeDir: string | undefined,
  boundPaths: string[],
  probe: SandboxProbe,
): string[] {
  if (homeDir === undefined || homeDir.length === 0) return [];
  return rel
    .map((r) => path.join(homeDir, r))
    .filter((p) => probe.exists(p) && underABoundPath(p, boundPaths));
}

/**
 * Build the sandboxed command for `rawCommand`, or refuse.
 *
 * `cwd` must be inside the scope root; a working directory the sandbox
 * cannot see would produce a confusing runtime failure instead of a clear
 * policy one, and the policy one is the truthful message.
 */
export function plan(
  rawCommand: string,
  scope: ScopeState,
  config: HarnessConfig,
  cwd: string,
  probe: SandboxProbe,
  opts: { writable?: boolean; homeDir?: string; execPath?: string } = {},
): SandboxPlan {
  if (rawCommand.trim().length === 0) {
    return { ok: false, reason: "empty command", rule: "section 9" };
  }
  if (!probe.bwrapAvailable()) {
    // Fail-safe, per spec section 9: refuse rather than fall back.
    return {
      ok: false,
      reason:
        "bubblewrap is not available; the harness shell refuses to run rather than fall back to an unenforced shell",
      rule: "section 9",
    };
  }

  const root = scope.root;
  if (!(cwd === root || cwd.startsWith(root + path.sep))) {
    return {
      ok: false,
      reason: `working directory ${cwd} is outside the scope root ${root}`,
      rule: "S3",
    };
  }

  // Only paths that exist are bound: bwrap fails hard on a missing bind
  // target, and an unconfigured entry in the list should not take the whole
  // shell down.
  const configured = config.sandboxReadOnlyPaths.filter((p) => probe.exists(p));
  // The interpreter's own prefix, so a runtime outside the system prefixes
  // still resolves inside the sandbox. Never $HOME (see runtimeToolchainPath).
  const toolchain = opts.execPath === undefined ? null : runtimeToolchainPath(opts.execPath, opts.homeDir);
  const readOnly =
    toolchain !== null && probe.exists(toolchain) && !underABoundPath(toolchain, configured)
      ? [...configured, toolchain]
      : configured;
  // Deliberately keyed on `configured`, NOT on `readOnly`: the interpreter
  // prefix is an ADDITION to a configured mount set, never a substitute for
  // one. Keying on readOnly would mean an unconfigured instance quietly ran
  // with only the runtime bound instead of refusing - silently dropping the
  // "refuse rather than guess at the host" guarantee this check exists for.
  if (configured.length === 0) {
    // Actionable: name the file, the key, and a copyable value. A refusal that
    // only names the key costs the reader a search, and (before P4) it cost a
    // confirmation prompt too.
    return {
      ok: false,
      reason:
        'no runtime mounts are configured, so the sandboxed shell cannot run. Set "sandboxReadOnlyPaths" in ' +
        "<harness-home>/config.json, for example: " +
        '"sandboxReadOnlyPaths": ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"]. ' +
        "Do not add $HOME: the sandbox binds only what is listed, and $HOME would expose credential paths.",
      rule: "section 9",
    };
  }

  // Read-only by default: the scope root is bound read-only unless the caller
  // explicitly asks for write mode (pi_harness_bash mode:"write", or the
  // operator's scoped_exec whose purpose is execution in its scope). A write in
  // read mode then fails with EROFS - mutation is impossible by construction,
  // no command parsing involved.
  const writable = opts.writable === true;
  const shadowDirs = [...config.sandboxShadowDirs, ...sensitiveShadows(SENSITIVE_SHADOW_DIRS_REL, opts.homeDir, readOnly, probe)];
  const shadowFiles = [...config.sandboxShadowFiles, ...sensitiveShadows(SENSITIVE_SHADOW_FILES_REL, opts.homeDir, readOnly, probe)];

  const command = buildSandboxedCommand(rawCommand, {
    projectRoot: root,
    projectRootReadOnly: !writable,
    cwd,
    // Section 9: network is unshared unless scope policy explicitly grants
    // it. The config cannot turn this on - only the scope object can, and
    // only the user can set that field.
    network: scope.networkGrant,
    roBindPaths: readOnly,
    shadowDirs,
    shadowFiles,
  });

  return {
    ok: true,
    command,
    mounts: { readWrite: writable ? root : "(none: read-only)", readOnly, network: scope.networkGrant, writable },
  };
}

/**
 * Should Pi's builtin `bash` be blocked right now?
 *
 * Returns true unless the user has explicitly granted the unsafe builtin on
 * the scope object. Note the asymmetry with everything else in the harness:
 * this is checked as "is it granted", never "is it denied", so a missing or
 * malformed scope field blocks rather than permits.
 */
export function builtinBashBlocked(scope: ScopeState): boolean {
  return scope.unsafeBuiltinBashGrant !== true;
}

/**
 * The active tool set with the builtin shell removed.
 *
 * Removal from the active set is a usability measure - it keeps the model
 * from planning around a tool it cannot use. It is not the enforcement:
 * the tool_call handler denies `bash` independently, so a tool set restored
 * by another extension does not reopen the path.
 */
export function withoutBuiltinBash(activeTools: string[]): string[] {
  return activeTools.filter((name) => name !== "bash");
}

export function describeSandboxPlan(plan: SandboxPlan): string {
  if (!plan.ok) return `refused: ${plan.reason}`;
  return [
    plan.mounts.writable
      ? `read-write: ${plan.mounts.readWrite}`
      : `read-write: (none: scope root bound read-only)`,
    `read-only: ${plan.mounts.readOnly.join(", ")}`,
    `network: ${plan.mounts.network ? "shared" : "unshared"}`,
  ].join("\n");
}
