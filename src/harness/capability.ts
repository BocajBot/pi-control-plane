/**
 * Pi Harness - capability authority (spec sections 8 and 32; invariants
 * TO1-TO5).
 *
 * The v0.1 harness treated Pi's active tool set as a given: it removed the
 * builtin shell and enforced scope on whatever else happened to be there.
 * That is backwards. Section 8 says Pi should be capability-aware rather
 * than tool-saturated, and TO1 says capability existence does not imply
 * prompt exposure - so the active set has to be *computed* from a catalog,
 * not inherited from whichever extensions loaded first.
 *
 * The distinction this module turns on is epistemic, not a risk rating:
 *
 *   scope-aware  the harness can resolve this tool's filesystem target from
 *                its arguments and check it against the scope before the
 *                call runs.
 *   harness      this package registered it; its enforcement is this
 *                package's own code.
 *   unconfined   everything else. Another extension's tool is opaque. The
 *                harness cannot know what its arguments mean, cannot resolve
 *                a target, and therefore cannot claim it is confined.
 *
 * Section 32 requires the third category be *labelled* unconfined rather
 * than described as sandboxed, and requires an explicit per-session user
 * exception before one becomes active. Both halves matter. Silently
 * activating an opaque tool is the authority leak; describing it as
 * sandboxed afterwards is the false claim that hides the leak.
 *
 * Pure: no Pi imports, no I/O. The extension supplies the registered tool
 * list and applies the result.
 */

import { nowIso, type Clock } from "./util.ts";
import type { Actor, CapabilityEntry, CapabilityException, ToolConfinement } from "./types.ts";

/**
 * Pi builtins whose filesystem target the harness resolves and scope-checks
 * in its `tool_call` handler.
 *
 * Membership here is a claim about *this harness's* enforcement, not about
 * the tool being safe. `write` is in the list precisely because the harness
 * checks where it writes; `bash` is absent because an arbitrary command line
 * has no resolvable target, which is the entire argument of section 9.
 */
export const SCOPE_AWARE_BUILTINS: readonly string[] = [
  "read",
  "write",
  "edit",
  "ls",
  "grep",
  "find",
];

/**
 * Tools this package registers.
 *
 * Kept as data rather than derived from the registration calls so that a
 * tool added to the extension without being added here is classified
 * `unconfined` and stays out of the active set. The failure mode of
 * forgetting to update this list is a tool that does not appear - not a tool
 * that appears unchecked.
 */
export const HARNESS_TOOLS: readonly string[] = [
  "pi_harness_bash",
  "harness_request_scope",
  "harness_memory_search",
  "harness_note",
  "harness_find_capability",
  "harness_delegate",
  "harness_set_posture",
];

/**
 * The builtin shell, which is never active regardless of catalog state.
 *
 * Listed separately from the classification because its removal is a
 * different rule with a different owner (section 9, enforced in sandbox.ts
 * and independently in the tool_call handler). Duplicating the exclusion
 * here keeps the two rules from having to agree about ordering.
 */
export const NEVER_ACTIVE: readonly string[] = ["bash"];

export function classifyTool(name: string): ToolConfinement {
  if (SCOPE_AWARE_BUILTINS.includes(name)) return "scope-aware";
  if (HARNESS_TOOLS.includes(name)) return "harness";
  return "unconfined";
}

/** A tool as Pi reports it. Only the fields the harness actually reads. */
export interface RegisteredTool {
  name: string;
  description?: string;
}

/**
 * The catalog: every registered tool, classified, with whether it is active
 * and why.
 *
 * This is the object behind `/harness capability` and behind TO1. A tool
 * that exists but is not active still appears here - that is the point.
 * "Pi cannot do that" and "Pi could do that but is not currently allowed to"
 * are different answers, and only the catalog can tell them apart.
 */
export function buildCatalog(
  registered: RegisteredTool[],
  exceptions: ReadonlyMap<string, CapabilityException>,
): CapabilityEntry[] {
  const active = new Set(defaultActiveTools(registered, exceptions));
  return registered
    .map((tool) => {
      const confinement = classifyTool(tool.name);
      const exception = exceptions.get(tool.name) ?? null;
      return {
        name: tool.name,
        description: tool.description ?? "",
        confinement,
        active: active.has(tool.name),
        // Only recorded for the case it explains. A scope-aware builtin that
        // happens to have a stale exception should not read as though it
        // needed one.
        exceptionReason: confinement === "unconfined" && exception !== null ? exception.reason : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The set the coordinator should actually see.
 *
 * Scope-aware builtins and harness tools by default; an unconfined tool only
 * with a live per-session exception; the builtin shell never.
 *
 * Note this is computed from the registered list rather than filtered from
 * Pi's current active set. Filtering would preserve whatever another
 * extension had already activated - and an extension that activates its own
 * opaque tool at load time would thereby grant itself the exception this
 * function exists to require.
 */
export function defaultActiveTools(
  registered: RegisteredTool[],
  exceptions: ReadonlyMap<string, CapabilityException>,
): string[] {
  const names: string[] = [];
  for (const tool of registered) {
    if (NEVER_ACTIVE.includes(tool.name)) continue;
    const confinement = classifyTool(tool.name);
    if (confinement === "unconfined" && !exceptions.has(tool.name)) continue;
    names.push(tool.name);
  }
  return [...new Set(names)].sort();
}

export type ExceptionOutcome =
  | { ok: true; exception: CapabilityException }
  | { ok: false; reason: string; rule: string };

/**
 * Grant one unconfined tool for this session.
 *
 * Refused for every actor but the user. Activating an opaque tool widens
 * what the coordinator can do by an amount the harness cannot bound, which
 * is an authority expansion in the plain sense of A2 - the fact that it is
 * spelled "enable a tool" rather than "enlarge my scope" does not change
 * what it does.
 *
 * Granting a tool that is already confined is refused too, rather than
 * quietly succeeding. A no-op grant that returns ok would appear in the
 * audit log as an exception the user made, which is a small lie about what
 * the user was asked to approve.
 */
export function grantException(
  tool: string,
  actor: Actor,
  reason: string,
  clock: Clock = () => new Date(),
): ExceptionOutcome {
  if (actor !== "user") {
    return {
      ok: false,
      reason: `actor "${actor}" cannot activate an unconfined tool; ask the user for a per-session exception`,
      rule: "A2 / section 32",
    };
  }
  if (NEVER_ACTIVE.includes(tool)) {
    return {
      ok: false,
      reason: `${tool} is blocked by the shell boundary and cannot be granted as a capability exception`,
      rule: "section 9",
    };
  }
  if (classifyTool(tool) !== "unconfined") {
    return {
      ok: false,
      reason: `${tool} is already active as a ${classifyTool(tool)} capability; no exception is needed`,
      rule: "TO1",
    };
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: "a capability exception must record why it was granted",
      rule: "meta-invariant",
    };
  }
  return {
    ok: true,
    exception: { tool, grantedBy: actor, grantedAt: nowIso(clock), reason: trimmed },
  };
}

/**
 * How an active tool should be described in an audit event.
 *
 * Returned as a string rather than a boolean so the audit line carries the
 * word "unconfined" verbatim. Section 32's requirement is about what the
 * record says, and a metadata field of `confined: false` is not the same
 * artifact as a line a human reads as unconfined.
 */
export function describeConfinement(name: string, exceptions: ReadonlyMap<string, CapabilityException>): string {
  const confinement = classifyTool(name);
  if (confinement !== "unconfined") return confinement;
  const exception = exceptions.get(name);
  return exception ? `unconfined (user exception: ${exception.reason})` : "unconfined (not granted)";
}

/** Human-readable catalog for `/harness capability`. */
export function describeCatalog(entries: CapabilityEntry[]): string {
  if (entries.length === 0) return "(no tools registered)";
  return entries
    .map((entry) => {
      const state = entry.active ? "active" : "catalog only";
      const suffix = entry.exceptionReason ? ` - exception: ${entry.exceptionReason}` : "";
      return `${entry.name}  [${entry.confinement}, ${state}]${suffix}`;
    })
    .join("\n");
}
