/**
 * Scope invariants S1-S6 (spec section 27).
 *
 * The symlink cases use a fake `PathOps` rather than real symlinks. That is
 * deliberate and it is the stronger test: a real symlink test passes on a
 * machine whose `realpath` happens to behave, whereas the fake pins the
 * exact contract scope.ts depends on ("realpath resolves the link") and
 * fails loudly if the code ever stops calling it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approveExpansion,
  canonicalize,
  checkPath,
  createScope,
  dedupeRoots,
  defaultCeiling,
  describeScope,
  narrowAutomatically,
  narrowScope,
  nextBoundary,
  requestExpansion,
  type PathOps,
} from "../src/harness/scope.ts";

const HOME = "/home/u";

/** Every path exists; nothing is a symlink. */
const plainOps: PathOps = {
  exists: () => true,
  realpath: (p) => p,
};

/** `/home/u/proj/link` points outside the project. This is the S6 case. */
const symlinkOps: PathOps = {
  exists: () => true,
  realpath: (p) =>
    p === "/home/u/proj/link" || p.startsWith("/home/u/proj/link/")
      ? p.replace("/home/u/proj/link", "/etc")
      : p,
};

test("S1: a new scope starts at the given root and nothing wider", () => {
  const scope = createScope("/home/u/proj/src", "user");
  assert.deepEqual(scope.allowedRoots, ["/home/u/proj/src"]);
  assert.equal(scope.root, "/home/u/proj/src");
  assert.equal(scope.unsafeBuiltinBashGrant, false);
  assert.equal(scope.networkGrant, false);
});

test("S2: exactly one automatic expansion is available, and it is spent", () => {
  const scope = createScope("/home/u/proj/src", "user");
  assert.equal(scope.automaticExpansionBudget, 1);

  const first = requestExpansion(scope, "/home/u/proj", "/home/u/proj", plainOps, HOME);
  assert.equal(first.decision, "auto-granted");
  assert.equal(first.scope?.automaticExpansionBudget, 0);
  assert.equal(first.scope?.root, "/home/u/proj");

  // The second next-boundary step is not automatic, however reasonable.
  const second = requestExpansion(first.scope!, "/home/u", "/home/u/proj", plainOps, HOME);
  assert.equal(second.decision, "needs-approval");
});

test("S2: the automatic step is only the *next* boundary, not an arbitrary one", () => {
  const scope = createScope("/home/u/proj/src/deep", "user");
  const outcome = requestExpansion(scope, "/home/u/proj", "/home/u/proj", plainOps, HOME);
  assert.equal(outcome.decision, "needs-approval");
  assert.match(outcome.reason, /beyond the next boundary/);
});

test("S2: a target already inside scope needs no expansion at all", () => {
  const scope = createScope("/home/u/proj", "user");
  const outcome = requestExpansion(scope, "/home/u/proj/src/a.ts", "/home/u/proj", plainOps, HOME);
  assert.equal(outcome.decision, "auto-granted");
  assert.equal(outcome.scope?.automaticExpansionBudget, 1, "budget must not be spent on a no-op");
});

test("S2: user approval does not refill the automatic budget", () => {
  const scope = createScope("/home/u/proj/src", "user");
  const auto = requestExpansion(scope, "/home/u/proj", "/home/u/proj", plainOps, HOME);
  const approved = approveExpansion(auto.scope!, "/home/u/other", "/home/u", plainOps);
  assert.equal(approved.scope?.automaticExpansionBudget, 0);
  assert.equal(approved.scope?.grantedBy, "user");
});

test("S3: expansion is refused automatically when the scope disables it", () => {
  const scope = createScope("/home/u/proj/src", "user", { automaticExpansionEnabled: false });
  assert.equal(scope.automaticExpansionBudget, 0);
  const outcome = requestExpansion(scope, "/home/u/proj", "/home/u/proj", plainOps, HOME);
  assert.equal(outcome.decision, "needs-approval");
});

test("S3/S6: the home directory and the filesystem root are not boundaries", () => {
  assert.equal(nextBoundary("/home/u/proj", HOME), null, "parent is $HOME");
  assert.equal(nextBoundary("/srv", HOME), null, "parent is /");
  assert.equal(nextBoundary("/home/u/proj/src", HOME), "/home/u/proj");
});

test("S6: a symlink out of the project is caught, despite the prefix matching", () => {
  const scope = createScope("/home/u/proj", "user");

  // The raw string starts with the root, which is exactly the trap.
  const check = checkPath("/home/u/proj/link/passwd", scope, "/home/u/proj", symlinkOps);
  assert.equal(check.allowed, false);
  assert.equal(check.canonical, "/etc/passwd");
  assert.match(check.reason, /outside scope/);
});

test("S6: an unresolvable path is denied, not guessed at", () => {
  const scope = createScope("/home/u/proj", "user");
  const throwing: PathOps = {
    exists: () => true,
    realpath: () => {
      throw new Error("EACCES");
    },
  };
  const check = checkPath("/home/u/proj/x", scope, "/home/u/proj", throwing);
  assert.equal(check.allowed, false);
  assert.equal(check.canonical, null);
});

test("S6: a NUL byte in a path is rejected outright", () => {
  assert.equal(canonicalize("/home/u/proj/a\0b", "/home/u/proj", plainOps), null);
});

test("canonicalize: a path that does not exist yet resolves via its nearest ancestor", () => {
  const ops: PathOps = {
    exists: (p) => p === "/home/u/proj",
    realpath: (p) => (p === "/home/u/proj" ? "/real/proj" : p),
  };
  assert.equal(canonicalize("/home/u/proj/new/file.ts", "/home/u/proj", ops), "/real/proj/new/file.ts");
});

test("SA3: narrowScope refuses a target outside the parent, and strips expansion", () => {
  const parent = createScope("/home/u/proj", "user");
  assert.equal(narrowScope(parent, "/home/u/elsewhere", "/home/u", plainOps, "coordinator"), null);

  const child = narrowScope(parent, "/home/u/proj/src", "/home/u/proj", plainOps, "coordinator");
  assert.deepEqual(child?.allowedRoots, ["/home/u/proj/src"]);
  assert.equal(child?.automaticExpansionBudget, 0, "a child must not inherit an unspent expansion");
  assert.equal(child?.unsafeBuiltinBashGrant, false);
});

test("dedupeRoots: a root already covered by a broader one is dropped", () => {
  assert.deepEqual(dedupeRoots(["/a/b", "/a", "/a/b/c", "/d"]), ["/a", "/d"]);
});

test("describeScope: renders the flags an audit line needs", () => {
  const scope = createScope("/home/u/proj", "user");
  // The ceiling is part of what a scope authorizes, so an audit line that
  // omitted it would not be readable without joining against session state.
  assert.equal(describeScope(scope), "/home/u/proj [no-net auto-expand:1 ceiling:/home/u]");
  assert.match(describeScope({ ...scope, unsafeBuiltinBashGrant: true }), /UNSAFE-BASH/);
});

/* ------------------------------------------------------------------ *
 * Automatic expansion ceiling (spec section 32)
 * ------------------------------------------------------------------ */

test("section 32: the ceiling defaults to exactly one boundary out", () => {
  assert.equal(defaultCeiling("/home/u/proj/src", HOME), "/home/u/proj");
  // No boundary to reach: a project directly under home cannot expand into
  // home, so its ceiling is itself.
  assert.equal(defaultCeiling("/home/u/proj", HOME), "/home/u/proj");
});

test("section 32: a target outside the ceiling is refused even when it IS the next boundary", () => {
  // The decisive case. Budget is available, the target is exactly one
  // boundary out, and S2 alone would grant it. Only the ceiling stops it.
  const scope = createScope("/home/u/proj/src", "user", { autoExpansionCeiling: "/home/u/proj/src" });
  assert.equal(scope.automaticExpansionBudget, 1, "budget is available, so the budget is not what refuses");
  const outcome = requestExpansion(scope, "/home/u/proj", "/home/u/proj", plainOps, HOME);
  assert.equal(outcome.decision, "needs-approval");
  assert.match(outcome.reason, /outside the automatic-expansion ceiling/);
  assert.equal(outcome.scope, null, "a refused expansion must not hand back a scope to persist");
});

test("section 32: narrowing automatically cannot be walked back out past the ceiling", () => {
  // This is the sequence the ceiling exists to stop: each step is individually
  // legal under S2, and without a ceiling the walk ends broader than the scope
  // the user authorized.
  const start = createScope("/home/u/proj/src/deep", "user", { home: HOME });
  assert.equal(start.autoExpansionCeiling, "/home/u/proj/src");

  const narrowed = narrowAutomatically(start, "/home/u/proj/src/deep/inner", "/home/u", plainOps);
  assert.ok(narrowed, "narrowing is authority-reducing and may happen automatically");
  assert.equal(narrowed.autoExpansionCeiling, "/home/u/proj/src", "narrowing does not lower the ceiling");
  assert.equal(narrowed.automaticExpansionBudget, 1, "a narrowed scope may step back out once");

  // Step one: back out to the old root. Inside the ceiling, so granted.
  const stepOne = requestExpansion(narrowed, "/home/u/proj/src/deep", "/home/u", plainOps, HOME);
  assert.equal(stepOne.decision, "auto-granted");
  const afterOne = stepOne.scope;
  assert.ok(afterOne);

  // Step two: narrow again to refill the budget, then try to keep walking.
  const again = narrowAutomatically(afterOne, "/home/u/proj/src/deep/inner", "/home/u", plainOps);
  assert.ok(again);
  const stepTwo = requestExpansion(again, "/home/u/proj/src/deep", "/home/u", plainOps, HOME);
  assert.equal(stepTwo.decision, "auto-granted", "still inside the ceiling");

  // Step three: past the ceiling. Refused no matter how many times the
  // budget was refilled by narrowing.
  const past = requestExpansion(
    { ...(stepTwo.scope ?? again), root: "/home/u/proj/src", automaticExpansionBudget: 1 },
    "/home/u/proj",
    "/home/u",
    plainOps,
    HOME,
  );
  assert.equal(past.decision, "needs-approval");
  assert.match(past.reason, /ceiling/);
});

test("section 32: leaving the ceiling is a user-authorized transition that moves it", () => {
  const scope = createScope("/home/u/proj/src", "user", { home: HOME });
  const approved = approveExpansion(scope, "/home/u/other", "/home/u", plainOps);
  assert.equal(approved.decision, "auto-granted");
  assert.equal(approved.scope?.autoExpansionCeiling, "/home/u/other", "approval moves the ceiling to what was approved");
  assert.equal(approved.scope?.grantedBy, "user");
});

test("section 32: an approval inside the existing ceiling does not lower it", () => {
  const scope = createScope("/home/u/proj/src", "user", { home: HOME });
  const approved = approveExpansion(scope, "/home/u/proj/other", "/home/u", plainOps);
  assert.equal(approved.scope?.autoExpansionCeiling, "/home/u/proj", "unchanged, not narrowed to the approved path");
});

test("SA3: a delegation narrowing grants no ceiling beyond the child's own root", () => {
  const parent = createScope("/home/u/proj", "user", { home: HOME });
  const child = narrowScope(parent, "/home/u/proj/src", "/home/u", plainOps, "core");
  assert.ok(child);
  assert.equal(child.autoExpansionCeiling, "/home/u/proj/src", "a child cannot reach a region the parent never delegated");
  assert.equal(child.automaticExpansionBudget, 0);
  assert.equal(child.automaticExpansionEnabled, false);
  // And the refusal is real, not just a zeroed field.
  const attempt = requestExpansion(child, "/home/u/proj", "/home/u", plainOps, HOME);
  assert.equal(attempt.decision, "needs-approval");
});

test("narrowAutomatically refuses a target that is not inside the current scope", () => {
  const scope = createScope("/home/u/proj", "user", { home: HOME });
  assert.equal(narrowAutomatically(scope, "/home/u/elsewhere", "/home/u", plainOps), null);
});
