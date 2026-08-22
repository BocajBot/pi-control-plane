/**
 * Pi Harness - scope as an authority object (spec sections 3, 20; invariants
 * S1-S6).
 *
 * Scope is not an instruction in a prompt. A model may *request* expansion;
 * this module decides whether that request is automatically allowed, needs
 * user approval, or is refused - and Pi Core, not the model, applies the
 * result.
 *
 * Filesystem access is injected via `PathOps`, the same interface
 * src/control-plane/tool-policy.ts already uses. That is what makes S6
 * (symlink traversal must not bypass scope) testable without creating real
 * symlinks: a test supplies a `realpath` that maps the link to its target
 * and asserts the check follows it.
 *
 * The rule that does the most work here is S2. "One automatic expansion"
 * means one for the lifetime of the scope object, not one per request - so
 * the budget is decremented and never refilled except by a user-authorized
 * `setScopeRoot`, which starts a new scope rather than extending the old.
 */

import * as path from "node:path";

import { HARNESS_SCHEMA_VERSION, type Actor, type ScopeState } from "./types.ts";
import { nowIso, type Clock } from "./util.ts";

export interface PathOps {
  /** Resolve symlinks; must throw when the path does not exist. */
  realpath(p: string): string;
  exists(p: string): boolean;
}

/**
 * Canonicalize a path: absolute, symlinks resolved. For paths that do not
 * exist yet (a file about to be written), the nearest existing ancestor is
 * realpath'd and the missing remainder appended lexically - those segments
 * cannot be symlinks precisely because they do not exist.
 *
 * Returns null when canonicalization fails. Callers must deny on null: an
 * unresolvable path is an unknown authority domain, and S6 does not permit
 * guessing.
 */
export function canonicalize(rawPath: string, cwd: string, ops: PathOps): string | null {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return null;
  if (rawPath.includes("\0")) return null;
  try {
    const absolute = path.resolve(cwd, rawPath);
    if (ops.exists(absolute)) return ops.realpath(absolute);
    let ancestor = absolute;
    const remainder: string[] = [];
    while (!ops.exists(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      remainder.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    return path.join(ops.realpath(ancestor), ...remainder);
  } catch {
    return null;
  }
}

export function isInside(canonical: string, root: string): boolean {
  return canonical === root || canonical.startsWith(root + path.sep);
}

/**
 * Fresh scope at `root`, with the single automatic expansion available.
 *
 * `grantedBy` is required rather than defaulted: every scope has an
 * authority origin, and a default would quietly attribute a model-initiated
 * scope to the user.
 */
export function createScope(
  root: string,
  grantedBy: Actor,
  options: {
    automaticExpansionEnabled?: boolean;
    networkGrant?: boolean;
    /** Used to compute the default ceiling. Passing it stops the ceiling
     * defaulting to the home directory itself when the project sits directly
     * under it. */
    home?: string;
    autoExpansionCeiling?: string;
  } = {},
  clock: Clock = () => new Date(),
): ScopeState {
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    root,
    allowedRoots: [root],
    automaticExpansionEnabled: options.automaticExpansionEnabled ?? true,
    // S2: exactly one, for the life of this scope object.
    automaticExpansionBudget: options.automaticExpansionEnabled === false ? 0 : 1,
    networkGrant: options.networkGrant ?? false,
    unsafeBuiltinBashGrant: false,
    autoExpansionCeiling: options.autoExpansionCeiling ?? defaultCeiling(root, options.home ?? ""),
    grantedBy,
    updatedAt: nowIso(clock),
  };
}

/**
 * The default automatic-expansion ceiling for a scope rooted at `root`: one
 * boundary out, or `root` itself when there is no boundary to go out to.
 *
 * Defaulting to exactly one step rather than to something broader is what
 * makes the ceiling a real constraint from the first session. A ceiling of
 * "the filesystem" would satisfy the letter of section 32 while permitting
 * precisely the walk it exists to stop.
 */
export function defaultCeiling(root: string, home: string): string {
  return nextBoundary(root, home) ?? root;
}

export interface ScopeCheck {
  allowed: boolean;
  /** The canonical path the decision was made about, or null when the path
   * could not be canonicalized at all. */
  canonical: string | null;
  reason: string;
}

/**
 * Is `rawPath` inside the current scope?
 *
 * Note the ordering: canonicalize first, compare second. Comparing the raw
 * string first and canonicalizing only on failure would be the classic
 * symlink bypass - `<root>/link-to-etc/passwd` starts with the root prefix
 * as a string while pointing outside it (S6).
 */
export function checkPath(
  rawPath: string,
  scope: ScopeState,
  cwd: string,
  ops: PathOps,
): ScopeCheck {
  const canonical = canonicalize(rawPath, cwd, ops);
  if (canonical === null) {
    return { allowed: false, canonical: null, reason: `path cannot be resolved: ${rawPath}` };
  }
  for (const root of scope.allowedRoots) {
    if (isInside(canonical, root)) {
      return { allowed: true, canonical, reason: `inside ${root}` };
    }
  }
  return {
    allowed: false,
    canonical,
    reason: `outside scope (allowed roots: ${scope.allowedRoots.join(", ")})`,
  };
}

/**
 * The next boundary out from `from`, as spec section 3 means it:
 *
 *   file -> component -> project -> broader filesystem/service
 *
 * Implemented as the parent directory, which is what "next boundary" is on a
 * filesystem. Refuses to return the filesystem root or a home directory:
 * those are not a boundary, they are the absence of one, and reaching them
 * must go through explicit approval rather than an automatic step.
 */
export function nextBoundary(from: string, home: string): string | null {
  const parent = path.dirname(from);
  if (parent === from) return null;
  if (parent === path.parse(parent).root) return null;
  if (parent === home) return null;
  return parent;
}

export type ExpansionDecision = "auto-granted" | "needs-approval" | "refused";

export interface ExpansionOutcome {
  decision: ExpansionDecision;
  /** Non-null only for "auto-granted": the new scope to persist. The caller
   * must not construct one itself on the other two outcomes. */
  scope: ScopeState | null;
  target: string | null;
  reason: string;
}

/**
 * A model asks for more scope (spec section 3).
 *
 * Three outcomes, deliberately not two: "needs-approval" is distinct from
 * "refused" because the difference is who may say yes. Refusal here means
 * no one can say yes through *this* path - the request has to go through a
 * user-authorized scope reset instead.
 */
export function requestExpansion(
  scope: ScopeState,
  rawTarget: string,
  cwd: string,
  ops: PathOps,
  home: string,
  clock: Clock = () => new Date(),
): ExpansionOutcome {
  const target = canonicalize(rawTarget, cwd, ops);
  if (target === null) {
    return {
      decision: "refused",
      scope: null,
      target: null,
      reason: `expansion target cannot be resolved: ${rawTarget}`,
    };
  }
  if (scope.allowedRoots.some((root) => isInside(target, root))) {
    return {
      decision: "auto-granted",
      scope,
      target,
      reason: "already in scope; no expansion needed",
    };
  }

  const boundary = nextBoundary(scope.root, home);
  const isNextBoundary = boundary !== null && target === boundary;

  if (!isNextBoundary) {
    // S3: anything beyond one boundary out is an approval matter, not an
    // automatic one - regardless of remaining budget.
    return {
      decision: "needs-approval",
      scope: null,
      target,
      reason: boundary
        ? `target is beyond the next boundary (${boundary})`
        : "no automatic boundary available from the current root",
    };
  }
  // Checked after the S2 boundary rule and before the budget.
  //
  // Budget answers "how many automatic steps remain"; the ceiling answers
  // "how far out may an automatic step ever reach". Without the second
  // question, a scope that narrowed automatically could walk back out one
  // legal step at a time and end up broader than anything the user
  // authorized - each individual step defensible under S2, the sequence not.
  //
  // Ordering note: both this and the boundary rule return needs-approval, so
  // the order changes only which limit the message names, never the verdict.
  // The boundary rule goes first because it is the more specific complaint
  // when both apply.
  if (!isInside(target, scope.autoExpansionCeiling)) {
    return {
      decision: "needs-approval",
      scope: null,
      target,
      reason: `target is outside the automatic-expansion ceiling (${scope.autoExpansionCeiling})`,
    };
  }
  if (!scope.automaticExpansionEnabled) {
    return {
      decision: "needs-approval",
      scope: null,
      target,
      reason: "automatic expansion is disabled for this scope",
    };
  }
  if (scope.automaticExpansionBudget <= 0) {
    // S2 in force: the one automatic step has already been taken.
    return {
      decision: "needs-approval",
      scope: null,
      target,
      reason: "automatic expansion budget exhausted (one per scope)",
    };
  }

  return {
    decision: "auto-granted",
    scope: {
      ...scope,
      root: target,
      allowedRoots: dedupeRoots([...scope.allowedRoots, target]),
      automaticExpansionBudget: scope.automaticExpansionBudget - 1,
      // The grant is still Core's: the model requested, Core decided.
      grantedBy: "core",
      updatedAt: nowIso(clock),
    },
    target,
    reason: `automatic one-step expansion to ${target}`,
  };
}

/**
 * Apply an expansion the user approved.
 *
 * Note this does *not* refill `automaticExpansionBudget`. A user approving
 * one broad expansion is not a statement that the model should get another
 * free automatic one afterwards; only `createScope` starts a new budget.
 */
export function approveExpansion(
  scope: ScopeState,
  rawTarget: string,
  cwd: string,
  ops: PathOps,
  clock: Clock = () => new Date(),
): ExpansionOutcome {
  const target = canonicalize(rawTarget, cwd, ops);
  if (target === null) {
    return {
      decision: "refused",
      scope: null,
      target: null,
      reason: `expansion target cannot be resolved: ${rawTarget}`,
    };
  }
  // Leaving the ceiling is exactly the transition section 32 reserves for
  // the user, so an approval moves the ceiling to what was approved - and no
  // further. It is not widened to the union of everything ever approved,
  // because that would make each approval quietly raise the bar for the next
  // automatic step.
  const ceiling = isInside(target, scope.autoExpansionCeiling) ? scope.autoExpansionCeiling : target;
  return {
    decision: "auto-granted",
    scope: {
      ...scope,
      allowedRoots: dedupeRoots([...scope.allowedRoots, target]),
      autoExpansionCeiling: ceiling,
      grantedBy: "user",
      updatedAt: nowIso(clock),
    },
    target,
    reason: `user-approved expansion to ${target}`,
  };
}

/**
 * Narrow a scope to a subset. Used when building a delegation contract
 * (invariant SA3) and when a task freezes its envelope (T2).
 *
 * Returns null when `rawTarget` is not inside the parent scope: a child that
 * cannot be expressed as a subset is not a narrowing, and silently widening
 * it here would break SA3 at the one place it is enforced.
 */
export function narrowScope(
  scope: ScopeState,
  rawTarget: string,
  cwd: string,
  ops: PathOps,
  grantedBy: Actor,
  clock: Clock = () => new Date(),
): ScopeState | null {
  const target = canonicalize(rawTarget, cwd, ops);
  if (target === null) return null;
  if (!scope.allowedRoots.some((root) => isInside(target, root))) return null;
  return {
    ...scope,
    root: target,
    allowedRoots: [target],
    // A child never inherits the parent's unused automatic expansion: that
    // would let delegation manufacture authority the parent had spent.
    automaticExpansionEnabled: false,
    automaticExpansionBudget: 0,
    networkGrant: scope.networkGrant,
    unsafeBuiltinBashGrant: false,
    // A delegate's ceiling is its own root: it has no automatic step to take
    // and nowhere to take one to. Inheriting the parent's ceiling would give
    // the child a reachable region the parent never delegated.
    autoExpansionCeiling: target,
    grantedBy,
    updatedAt: nowIso(clock),
  };
}

/**
 * Narrow the working scope during ordinary work.
 *
 * Distinct from `narrowScope` on purpose, and the difference is the whole
 * reason section 32 introduces a ceiling. Narrowing is authority-reducing,
 * so it may happen automatically - but a scope narrowed automatically must
 * be able to step back out, or the first narrowing would permanently strand
 * the session in a subdirectory. So this keeps the ceiling and restores the
 * single automatic step, while `narrowScope` (used for delegation contracts)
 * grants neither.
 *
 * Two functions rather than a boolean parameter: a caller that passes the
 * wrong boolean gets a delegate with re-expansion rights, and that failure
 * is invisible at the call site. A caller that picks the wrong function is
 * reading a name that says what it does.
 */
export function narrowAutomatically(
  scope: ScopeState,
  rawTarget: string,
  cwd: string,
  ops: PathOps,
  clock: Clock = () => new Date(),
): ScopeState | null {
  const target = canonicalize(rawTarget, cwd, ops);
  if (target === null) return null;
  if (!scope.allowedRoots.some((root) => isInside(target, root))) return null;
  return {
    ...scope,
    root: target,
    allowedRoots: [target],
    automaticExpansionEnabled: true,
    automaticExpansionBudget: 1,
    // Unchanged: narrowing does not lower the ceiling, because the ceiling
    // records what the user authorized, not where work happens to be.
    autoExpansionCeiling: scope.autoExpansionCeiling,
    grantedBy: "core",
    updatedAt: nowIso(clock),
  };
}

/** Drop duplicates and any root already covered by a broader one, so
 * `allowedRoots` stays a minimal set and audit lines stay readable. */
export function dedupeRoots(roots: string[]): string[] {
  const unique = [...new Set(roots)].sort();
  const kept: string[] = [];
  for (const root of unique) {
    if (!kept.some((existing) => isInside(root, existing))) kept.push(root);
  }
  return kept;
}

/** Compact single-line rendering for the `scope` field of an audit event. */
export function describeScope(scope: ScopeState): string {
  const flags = [
    scope.networkGrant ? "net" : "no-net",
    scope.automaticExpansionBudget > 0 ? "auto-expand:1" : "auto-expand:0",
  ];
  flags.push(`ceiling:${scope.autoExpansionCeiling}`);
  if (scope.unsafeBuiltinBashGrant) flags.push("UNSAFE-BASH");
  return `${scope.allowedRoots.join(":")} [${flags.join(" ")}]`;
}
