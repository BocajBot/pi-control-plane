/**
 * Tool authorization: classification, path canonicalization, Restricted-mode
 * policy validation, and the combined decision function.
 *
 * Precedence (most restrictive applicable rule wins):
 *   interpretation guard -> workflow phase -> autonomy policy
 *   -> tool classification -> path and destination checks
 *
 * Design rules baked in:
 * - Unknown tools are never classified as safe.
 * - Shell commands are never pattern-parsed to decide safety. The bash tool is
 *   allowed or denied as a whole (empirically, command-pattern allow/deny is
 *   unreliable in comparable agent harnesses; whole-tool denial is reliable).
 * - Unresolvable or malformed paths are denied.
 * - A missing or invalid Restricted policy degrades to Read-only semantics.
 */

import * as path from "node:path";
import {
  type Autonomy,
  type Phase,
  POLICY_SCHEMA_VERSION,
  type RestrictedPolicy,
  type RiskCategory,
  type ToolDecision,
} from "./types.ts";

/** "web_search" is the control plane's own registered tool (searxng-backed,
 * see websearch.ts): it never mutates and never touches the filesystem, so
 * it is classified as read - available in Discuss/Plan/Verify like any other
 * read tool, not treated as an unclassified "unknown" tool. */
export const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "web_search"]);
export const MUTATING_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash"]);

export type ToolCategory = "read" | "mutate" | "shell" | "unknown";

export function classifyTool(toolName: string): ToolCategory {
  if (READ_TOOLS.has(toolName)) return "read";
  if (MUTATING_TOOLS.has(toolName)) return "mutate";
  if (SHELL_TOOLS.has(toolName)) return "shell";
  return "unknown";
}

export function riskCategoryFor(toolName: string): RiskCategory {
  switch (classifyTool(toolName)) {
    case "read":
      return "read";
    case "shell":
      return "shell";
    case "mutate":
      return toolName === "write" ? "file-write" : "file-edit";
    default:
      return "unknown-tool";
  }
}

/** Injectable filesystem operations so path logic is unit-testable. */
export interface PathOps {
  /** Resolve symlinks; must throw when the path does not exist. */
  realpath(p: string): string;
  exists(p: string): boolean;
}

/**
 * Canonicalize a path: absolute, symlinks resolved. For paths that do not
 * exist yet (e.g. a new file being written), the nearest existing ancestor is
 * realpath'd and the non-existent remainder is appended lexically (those
 * segments cannot be symlinks because they do not exist).
 *
 * Returns null when the path cannot be canonicalized. Callers must deny then.
 */
export function canonicalizePath(rawPath: string, cwd: string, ops: PathOps): string | null {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return null;
  if (rawPath.includes("\0")) return null;
  try {
    const absolute = path.resolve(cwd, rawPath);
    if (ops.exists(absolute)) {
      return ops.realpath(absolute);
    }
    // Walk up to the nearest existing ancestor.
    let ancestor = absolute;
    const remainder: string[] = [];
    while (!ops.exists(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null; // hit filesystem root without finding anything
      remainder.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    return path.join(ops.realpath(ancestor), ...remainder);
  } catch {
    return null;
  }
}

export function isInsideRoot(canonical: string, canonicalRoot: string): boolean {
  return canonical === canonicalRoot || canonical.startsWith(canonicalRoot + path.sep);
}

/**
 * Resolve policy.allowPathPrefixes to canonical (realpath'd) directories,
 * silently dropping any entry that does not exist. Never falls back to a
 * literal-string match for a missing entry - an allowlist entry that cannot
 * be resolved grants nothing, the same fail-closed posture as every other
 * path check in this module. Resolved fresh on every call (no caching): this
 * module is synchronous and already does per-call fs work in canonicalizePath.
 */
export function resolveAllowPrefixes(policy: RestrictedPolicy, ops: PathOps): string[] {
  const resolved: string[] = [];
  for (const raw of policy.allowPathPrefixes) {
    try {
      if (ops.exists(raw)) resolved.push(ops.realpath(raw));
    } catch {
      // Unresolvable configured prefix grants nothing.
    }
  }
  return resolved;
}

/** True when canonical falls inside the project root OR inside one of the
 * policy's allowlisted prefixes. Restricted-mode mutation uses this in place
 * of a bare isInsideRoot check; deny patterns still apply either way. */
export function isAllowedDestination(
  canonical: string,
  projectRoot: string,
  policy: RestrictedPolicy,
  ops: PathOps,
): boolean {
  if (isInsideRoot(canonical, projectRoot)) return true;
  return resolveAllowPrefixes(policy, ops).some((prefix) => isInsideRoot(canonical, prefix));
}

/** Returns the matching deny rule as a string, or null when nothing matches. */
export function matchesDenyPatterns(canonical: string, policy: RestrictedPolicy): string | null {
  const segments = canonical.split(path.sep).filter((s) => s.length > 0);
  for (const base of policy.denyPathBasenames) {
    for (const segment of segments) {
      // ".env" also matches ".env.local"; "id_rsa" also matches "id_rsa.pub".
      if (segment === base || segment.startsWith(base + ".")) {
        return `deny basename "${base}"`;
      }
    }
  }
  for (const sub of policy.denyPathSubstrings) {
    if (canonical.includes(sub)) {
      return `deny substring "${sub}"`;
    }
  }
  return null;
}

function isStringArrayOfNonEmpty(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim().length > 0)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Strict policy validation. Anything unexpected -> null -> Read-only fallback. */
export function validatePolicy(value: unknown): RestrictedPolicy | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== POLICY_SCHEMA_VERSION) return null;
  if (!isStringArrayOfNonEmpty(record.denyPathBasenames)) return null;
  if (!isStringArrayOfNonEmpty(record.denyPathSubstrings)) return null;
  if (typeof record.allowBash !== "boolean") return null;
  // Entries themselves may not be empty strings (same rule as deny lists),
  // but the array itself may be empty (no allowlist widening at all).
  if (!isStringArray(record.allowPathPrefixes)) return null;
  if ((record.allowPathPrefixes as string[]).some((p) => p.trim().length === 0)) return null;
  const knownKeys = new Set([
    "schemaVersion",
    "denyPathBasenames",
    "denyPathSubstrings",
    "allowBash",
    "allowPathPrefixes",
  ]);
  for (const key of Object.keys(record)) {
    if (!knownKeys.has(key)) return null;
  }
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    denyPathBasenames: record.denyPathBasenames,
    denyPathSubstrings: record.denyPathSubstrings,
    allowBash: record.allowBash,
    allowPathPrefixes: record.allowPathPrefixes as string[],
  };
}

export interface EvaluateInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  guardActive: boolean;
  phase: Phase;
  autonomy: Autonomy;
  /** Canonicalized project root. */
  projectRoot: string;
  cwd: string;
  /** Null means the Restricted policy failed to load/validate. */
  policy: RestrictedPolicy | null;
  ops: PathOps;
  /**
   * Whether an accepted task brief currently exists. Only consulted for
   * autonomy "unattended": mutation is refused entirely without one. Ignored
   * by every other autonomy level (Attended and Restricted both already
   * require a human to have explicitly chosen that mode for this session;
   * Unattended is the one level meant to run with nobody watching in real
   * time, so it is the one level that requires a human-reviewed scope
   * boundary to already be in place before it starts).
   */
  hasAcceptedTask: boolean;
}

function targetPathOf(toolInput: Record<string, unknown>): string | null {
  const p = toolInput["path"];
  return typeof p === "string" && p.trim().length > 0 ? p : null;
}

function block(
  rule: string,
  reason: string,
  riskCategory: RiskCategory,
  insideRoot: boolean | null,
  hint?: string,
): ToolDecision {
  return { action: "block", rule, reason, riskCategory, insideRoot, hint };
}

function allow(rule: string, riskCategory: RiskCategory, insideRoot: boolean | null): ToolDecision {
  return { action: "allow", rule, reason: "allowed", riskCategory, insideRoot };
}

function confirm(
  rule: string,
  reason: string,
  riskCategory: RiskCategory,
  insideRoot: boolean | null,
): ToolDecision {
  return { action: "confirm", rule, reason, riskCategory, insideRoot };
}

const HINT_PHASE = "Mutation is only possible in the Execute phase: /phase execute (autonomy must also permit it).";
const HINT_AUTONOMY =
  "Raise autonomy for this to run: /autonomy attended (confirm each risky action) or /autonomy restricted (project-bound policy).";

export function evaluateToolCall(input: EvaluateInput): ToolDecision {
  const { toolName, guardActive, phase, autonomy, projectRoot, cwd, policy, ops } = input;
  const category = classifyTool(toolName);
  const risk = riskCategoryFor(toolName);

  // Layer 1: interpretation guard blocks everything, including reads.
  if (guardActive) {
    return block(
      "interpretation-guard",
      "All tools are disabled during the /interpret turn. Interpretation is analysis only.",
      risk,
      null,
      "Wait for the interpretation to finish, then /task accept or /task reject.",
    );
  }

  // Resolve the target path once, when one is present.
  const rawPath = targetPathOf(input.toolInput);
  let canonical: string | null = null;
  let insideRoot: boolean | null = null;
  if (rawPath !== null) {
    canonical = canonicalizePath(rawPath, cwd, ops);
    if (canonical === null) {
      return block(
        "path-unresolvable",
        `The path "${rawPath}" could not be canonicalized. Unresolvable paths are denied.`,
        risk,
        null,
      );
    }
    insideRoot = isInsideRoot(canonical, projectRoot);
  }

  // Read-oriented tools: allowed in every phase, subject to autonomy checks.
  if (category === "read") {
    // Unattended reuses Restricted's read policy unchanged: observation is
    // not the risk this level gates (mutation is, via hasAcceptedTask below),
    // so reads are not held back waiting on a task brief.
    if (autonomy === "restricted" || autonomy === "unattended") {
      if (policy === null) {
        // Policy failed: Read-only semantics. Reads are still allowed.
        return allow("policy-fallback:read", risk, insideRoot);
      }
      if (canonical !== null) {
        const denied = matchesDenyPatterns(canonical, policy);
        if (denied !== null) {
          return block(
            "restricted:credential-path",
            `Reading "${canonical}" is blocked by the Restricted policy (${denied}). This path category is categorically protected.`,
            risk,
            insideRoot,
          );
        }
      }
      return allow("restricted:read", risk, insideRoot);
    }
    if (autonomy === "attended" && insideRoot === false) {
      return confirm(
        "attended:read-outside-root",
        `Read target "${canonical}" is outside the project root.`,
        risk,
        insideRoot,
      );
    }
    return allow(`${autonomy}:read`, risk, insideRoot);
  }

  // Everything below can mutate. Phase gate first: only Execute may mutate.
  if (phase !== "execute") {
    return block(
      `phase:${phase}`,
      `The ${capitalize(phase)} phase prohibits mutating tool calls (tool "${toolName}").`,
      risk,
      insideRoot,
      HINT_PHASE,
    );
  }

  // Execute phase: autonomy decides.
  if (autonomy === "read-only") {
    const detail =
      category === "shell"
        ? "Shell execution is entirely blocked in Read-only mode; commands are never pattern-parsed to decide safety."
        : category === "unknown"
          ? `Tool "${toolName}" is not classified as read-only. Unknown tools are treated as unsafe.`
          : `Tool "${toolName}" can modify state.`;
    return block("autonomy:read-only", `Read-only mode blocks this call. ${detail}`, risk, insideRoot, HINT_AUTONOMY);
  }

  if (autonomy === "attended") {
    const target =
      category === "shell"
        ? "a shell command"
        : canonical !== null
          ? `"${canonical}"`
          : "an unspecified target";
    return confirm(
      `attended:${category}`,
      `Attended mode requires explicit confirmation before ${riskLabel(risk)} affecting ${target}.`,
      risk,
      insideRoot,
    );
  }

  // Unattended: gated on an accepted task brief existing before ANY mutation
  // is permitted (no human is watching in real time to catch scope drift).
  // Once gated, enforcement below is byte-for-byte the same RestrictedPolicy
  // logic Restricted uses - autonomy is not referenced again past this point,
  // so both levels share every remaining check (policy fallback, shell,
  // unknown tools, destination, deny patterns).
  if (autonomy === "unattended" && !input.hasAcceptedTask) {
    return block(
      "unattended:no-task",
      "Unattended mode requires an accepted task brief before any mutation is permitted - there is no human in the loop to catch scope drift here.",
      risk,
      insideRoot,
      "Run /interpret then /task accept, or /task set <text>, first. Or use /mode execute-restricted / execute for a human-attended session instead.",
    );
  }

  // Restricted (and, past the gate above, Unattended).
  if (policy === null) {
    return block(
      "policy-fallback",
      "The Restricted policy failed to load or validate; falling back to Read-only behavior for this call.",
      risk,
      insideRoot,
      "Fix policy/default-policy.json, then /reload.",
    );
  }
  if (category === "shell") {
    if (!policy.allowBash) {
      return block(
        "restricted:shell",
        "Shell execution is blocked by the Restricted policy (allowBash: false). Commands are never pattern-parsed to decide safety.",
        risk,
        insideRoot,
        "Use /autonomy attended to approve individual shell commands interactively.",
      );
    }
    return confirm(
      "restricted:shell-opt-in",
      "The Restricted policy permits bash (allowBash: true), but shell commands cannot be classified; each command still requires confirmation.",
      risk,
      insideRoot,
    );
  }
  if (category === "unknown") {
    return block(
      "restricted:unknown-tool",
      `Tool "${toolName}" is unknown to the control plane. Unknown tools are categorically denied in Restricted mode.`,
      risk,
      insideRoot,
      "Use /autonomy attended to approve unknown tools interactively.",
    );
  }
  // Mutating tool under Restricted: destination checks.
  if (canonical === null) {
    return block(
      "restricted:unknown-destination",
      `Tool "${toolName}" did not provide a resolvable target path. Unknown destinations are denied.`,
      risk,
      null,
    );
  }
  if (!isAllowedDestination(canonical, projectRoot, policy, ops)) {
    const hint =
      policy.allowPathPrefixes.length > 0
        ? ` (also checked ${policy.allowPathPrefixes.length} allowlisted prefix(es) in policy.allowPathPrefixes; none matched)`
        : "";
    return block(
      "restricted:outside-root",
      `Writing to "${canonical}" is blocked: it is outside the project root "${projectRoot}"${hint}.`,
      risk,
      false,
    );
  }
  const denied = matchesDenyPatterns(canonical, policy);
  if (denied !== null) {
    return block(
      "restricted:credential-path",
      `Writing to "${canonical}" is blocked by the Restricted policy (${denied}).`,
      risk,
      isInsideRoot(canonical, projectRoot),
    );
  }
  return allow(
    isInsideRoot(canonical, projectRoot) ? "restricted:in-root" : "restricted:allowlisted-outside-root",
    risk,
    isInsideRoot(canonical, projectRoot),
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function riskLabel(risk: RiskCategory): string {
  switch (risk) {
    case "file-write":
      return "a file write";
    case "file-edit":
      return "a file edit";
    case "shell":
      return "shell execution";
    case "unknown-tool":
      return "an unclassified tool call";
    default:
      return "an operation";
  }
}
