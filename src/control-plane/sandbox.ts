/**
 * Bwrap sandbox: wraps an allowed `bash` command in a bubblewrap invocation
 * so it runs under unprivileged Linux user namespaces instead of directly on
 * the host, before pi's own bash tool executes it.
 *
 * This module is pure: no Pi imports, no filesystem access (matches the
 * layering rule in docs/ARCHITECTURE.md - `fs` is injected by the caller,
 * same as tool-policy.ts's `PathOps`). It only ever assembles a command
 * *string*; it never spawns anything itself.
 *
 * State persistence mirrors scratchpad.ts exactly: its own entry type and
 * schema version, restored by walking the session branch backward for the
 * newest valid entry, falling back to a safe default (disabled) otherwise.
 *
 * See docs/SECURITY.md for what this does and does not guarantee - in short,
 * unprivileged bubblewrap namespaces are real kernel-enforced isolation
 * (unlike the `/mode sandboxed` alias, which is Pi-level policy only), but
 * they still share the host kernel: this is not a defense against a kernel
 * exploit, and it is not a substitute for a VM if the command is untrusted
 * rather than merely "possibly buggy."
 */

import { SANDBOX_SCHEMA_VERSION, type SandboxState } from "./types.ts";

export function emptySandboxState(now: string = new Date().toISOString()): SandboxState {
  return { schemaVersion: SANDBOX_SCHEMA_VERSION, enabled: false, network: false, updatedAt: now };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict validation, same posture as validateScratchpad: anything
 * unexpected -> null -> caller falls back to emptySandboxState() (disabled),
 * never a repaired guess. Unknown extra keys are rejected, matching
 * validatePolicy's exact-shape discipline in tool-policy.ts. */
export function validateSandboxState(value: unknown): SandboxState | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SANDBOX_SCHEMA_VERSION) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (typeof value.network !== "boolean") return null;
  if (typeof value.updatedAt !== "string") return null;
  const knownKeys = new Set(["schemaVersion", "enabled", "network", "updatedAt"]);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) return null;
  }
  return { schemaVersion: SANDBOX_SCHEMA_VERSION, enabled: value.enabled, network: value.network, updatedAt: value.updatedAt };
}

export interface SandboxEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Same walk-backward-take-first-valid restoration pattern as
 * state.ts:restoreFromEntries and scratchpad.ts:restoreScratchpadFromEntries. */
export function restoreSandboxFromEntries(
  entries: SandboxEntryLike[],
  entryType: string,
  now: string = new Date().toISOString(),
): { sandbox: SandboxState; restored: boolean; ignoredMalformed: number } {
  let ignoredMalformed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== entryType) continue;
    const validated = validateSandboxState(entry.data);
    if (validated !== null) {
      return { sandbox: validated, restored: true, ignoredMalformed };
    }
    ignoredMalformed++;
  }
  return { sandbox: emptySandboxState(now), restored: false, ignoredMalformed };
}

/**
 * POSIX single-quote escaping: wraps `s` in single quotes, closing and
 * reopening around any embedded `'`. The standard technique for passing an
 * arbitrary string through a shell as one opaque argument.
 */
export function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

export interface SandboxCommandOptions {
  /** Bound read-write. This is the only place the sandboxed command may
   * write; it is the reason to sandbox at all rather than just chroot. */
  projectRoot: string;
  /** bwrap --chdir target. Should be projectRoot or a path under one of
   * roBindPaths - this function does not check, it only assembles argv. */
  cwd: string;
  /** Adds --share-net when true. Default posture (false) unshares
   * networking entirely, same "safe by default" philosophy as every other
   * default in this package. */
  network: boolean;
  /** Bound read-only, in order. Typically system toolchain directories
   * (/usr, /etc, ...) plus $HOME so language/package-manager tooling
   * resolves. Caller is responsible for filtering to paths that exist -
   * this function does not touch the filesystem. */
  roBindPaths: string[];
  /** Directories to blank with an empty tmpfs, applied after roBindPaths so
   * they shadow anything bound earlier at the same path (e.g. a credential
   * directory inside a read-only-bound $HOME). */
  shadowDirs: string[];
  /** Files to blank by binding /dev/null over them, applied after
   * roBindPaths, for credential files rather than directories (e.g.
   * ~/.docker/config.json). */
  shadowFiles: string[];
}

/**
 * Build the full bwrap command line that runs `command` isolated, as a
 * single string suitable for handing back as the bash tool's new
 * `input.command` (see extensions/control-plane.ts's tool_call handler).
 *
 * `command` is passed through untouched to an inner `/bin/sh -c`, quoted as
 * one opaque argument - full shell semantics (pipes, redirects, `&&`, `$()`)
 * still work exactly as they would unsandboxed, just inside the namespace.
 */
export function buildSandboxedCommand(command: string, options: SandboxCommandOptions): string {
  const argv: string[] = ["bwrap", "--die-with-parent", "--unshare-all"];
  if (options.network) argv.push("--share-net");
  argv.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const p of options.roBindPaths) argv.push("--ro-bind-try", p, p);
  argv.push("--bind", options.projectRoot, options.projectRoot);
  for (const p of options.shadowDirs) argv.push("--tmpfs", p);
  for (const p of options.shadowFiles) argv.push("--ro-bind", "/dev/null", p);
  argv.push("--chdir", options.cwd);
  argv.push("--", "/bin/sh", "-c", command);
  return argv.map(shQuote).join(" ");
}

/** Short status-line label. "" when disabled, so callers can omit an empty
 * segment the same way updateStatus already omits "Context edited" when
 * there is no override (see ui.ts:formatStatus). */
export function describeSandbox(state: SandboxState): string {
  if (!state.enabled) return "";
  return `Sandbox: bwrap (${state.network ? "net on" : "net off"})`;
}
