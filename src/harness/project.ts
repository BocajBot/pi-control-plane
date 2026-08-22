/**
 * Pi Harness - project-root inference (spec section 25 "enter project").
 *
 * The project root determines the project state directory, the WORKSTATE
 * file location, and the initial scope root - so getting it wrong is an
 * authority error, not a cosmetic one. Filesystem access is injected so the
 * marker-precedence rules below are testable against a fake tree.
 *
 * Precedence is deliberate and is *not* "nearest marker wins":
 *
 *   1. An explicit `.pi/` directory. If someone created harness state here,
 *      here is the project, full stop.
 *   2. The outermost VCS root at or above the start directory. Outermost,
 *      not innermost, because a git submodule or nested worktree inside a
 *      repository is part of that repository's authority domain; treating
 *      the submodule as its own project would silently narrow scope below
 *      what the user means by "this project".
 *   3. The nearest package/build marker, for directories under version
 *      control at some unreachable ancestor or none at all.
 *   4. The start directory itself. Never the home directory and never `/`:
 *      those are the absence of a boundary (see scope.ts:nextBoundary).
 */

import * as path from "node:path";

/** Directory markers that identify a version-control root. */
export const VCS_MARKERS = [".git", ".hg", ".svn", ".jj"] as const;

/** File markers that identify a package or build root, nearest wins. */
export const PACKAGE_MARKERS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
  "deno.json",
] as const;

export interface ProjectFsOps {
  exists(p: string): boolean;
  isDirectory(p: string): boolean;
}

export interface ProjectInference {
  root: string;
  /** Which rule fired. Recorded in the audit event for the session start so
   * a surprising scope root can be explained without re-running inference. */
  reason: "pi-directory" | "vcs-root" | "package-marker" | "start-directory";
  marker: string | null;
}

/** Ancestors of `start`, nearest first, stopping before `home` and before
 * the filesystem root. Both are excluded for the reason given in the module
 * header: they are not boundaries. */
function ancestors(start: string, home: string): string[] {
  const chain: string[] = [];
  let current = path.resolve(start);
  const fsRoot = path.parse(current).root;
  while (true) {
    chain.push(current);
    if (current === home || current === fsRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

export function inferProjectRoot(start: string, home: string, ops: ProjectFsOps): ProjectInference {
  const chain = ancestors(start, home);

  for (const dir of chain) {
    const piDir = path.join(dir, ".pi");
    if (ops.exists(piDir) && ops.isDirectory(piDir)) {
      return { root: dir, reason: "pi-directory", marker: ".pi" };
    }
  }

  // Outermost VCS root: walk the chain furthest-first and take the first hit.
  for (const dir of [...chain].reverse()) {
    for (const marker of VCS_MARKERS) {
      const candidate = path.join(dir, marker);
      if (ops.exists(candidate)) {
        return { root: dir, reason: "vcs-root", marker };
      }
    }
  }

  // Nearest package marker.
  for (const dir of chain) {
    for (const marker of PACKAGE_MARKERS) {
      const candidate = path.join(dir, marker);
      if (ops.exists(candidate)) {
        return { root: dir, reason: "package-marker", marker };
      }
    }
  }

  return { root: path.resolve(start), reason: "start-directory", marker: null };
}
