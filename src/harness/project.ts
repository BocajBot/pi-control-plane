/**
 * Pi Harness - project-root inference (spec section 25 "enter project").
 *
 * The project root determines the project state directory, the WORKSTATE
 * file location, and the initial scope root - so getting it wrong is an
 * authority error, not a cosmetic one. Filesystem access is injected so the
 * marker-precedence rules below are testable against a fake tree.
 *
 * Precedence is deliberate and is *not* simply "nearest marker wins":
 *
 *   1. A `.pi/` directory and a VCS root are weighed by distance from the
 *      start directory: the NEARER of the two wins, and a `.pi/` at the same
 *      depth as a VCS root wins (an explicit `.pi/` is a deliberate override).
 *      So a project-local `.git` outranks a `.pi/` that exists only at an
 *      ancestor such as the home directory (`~/.pi`), while a project-local or
 *      otherwise-nearer `.pi/` still wins. VCS selection itself is OUTERMOST,
 *      not innermost, because a git submodule or nested worktree inside a
 *      repository is part of that repository's authority domain; treating the
 *      submodule as its own project would silently narrow scope below what the
 *      user means by "this project".
 *   2. The nearest package/build marker, when neither a `.pi/` nor a VCS root
 *      is on the chain.
 *   3. The start directory itself. Never the home directory and never `/`:
 *      those are the absence of a boundary (see scope.ts:nextBoundary).
 *
 * (Decision A1, 2026-08-23: previously ANY `.pi/` on the ancestor chain won
 * outright, so a project under $HOME with a `~/.pi` inherited home-wide scope
 * unless it carried its own `.pi/`. Now a nearer project marker wins, and a
 * bare directory with no local marker still falls back to the ancestor `.pi/`.)
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

  // Nearest `.pi/` directory, nearest-first (smaller index = closer to start).
  let piIdx = -1;
  for (let i = 0; i < chain.length; i++) {
    const piDir = path.join(chain[i], ".pi");
    if (ops.exists(piDir) && ops.isDirectory(piDir)) {
      piIdx = i;
      break;
    }
  }

  // Outermost VCS root: walk the chain furthest-first and take the first hit,
  // recording its distance so it can be weighed against the `.pi/` above.
  let vcsIdx = -1;
  let vcsMarker: string | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const marker of VCS_MARKERS) {
      if (ops.exists(path.join(chain[i], marker))) {
        vcsIdx = i;
        vcsMarker = marker;
        break;
      }
    }
    if (vcsIdx !== -1) break;
  }

  // A1: the nearer of {`.pi/`, VCS root} wins; a `.pi/` at the same depth wins
  // (explicit override). A project-local `.git` thus outranks an ancestor
  // `~/.pi`, while a nearer or same-depth `.pi/` still wins. A bare directory
  // with neither still falls through to the ancestor `.pi/` (piIdx set, vcsIdx
  // unset) exactly as before.
  if (piIdx !== -1 && (vcsIdx === -1 || piIdx <= vcsIdx)) {
    return { root: chain[piIdx], reason: "pi-directory", marker: ".pi" };
  }
  if (vcsIdx !== -1) {
    return { root: chain[vcsIdx], reason: "vcs-root", marker: vcsMarker };
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
