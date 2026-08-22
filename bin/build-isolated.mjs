#!/usr/bin/env node
/**
 * Build the isolated Pi Harness artifact.
 *
 * The harness lives in this repository as a second extension inside the
 * `pi-control-plane` package, because that is how it actually ships. The
 * isolated artifact is the same code as its own package, laid out exactly as
 * ARCHITECTURE2.md section 29 specifies:
 *
 *     src/index.ts              Pi extension / lifecycle / tools / enforcement
 *     src/agents.ts             advisor, bounded subagent, retrospective reviewer
 *     src/types.ts              state contracts
 *     src/core/*.ts             everything else
 *
 * The mapping is done here, mechanically, rather than by maintaining a second
 * copy of the tree. A hand-copied second tree drifts, and it drifts in the
 * direction that matters least visibly - a rule fixed in one copy and not the
 * other. It also, on one occasion, got clobbered by a stray `cp` and took the
 * inlined sandbox with it. A script that rebuilds the whole layout from the
 * repository every time cannot be half-updated.
 *
 * Two substantive transformations happen on the way:
 *
 *   1. Import specifiers are rewritten for the new layout.
 *   2. src/core/sandbox.ts has the bwrap argv builder INLINED, because the
 *      in-repo version imports it from src/control-plane/sandbox.ts and the
 *      isolated package has no control plane. The inlined text is extracted
 *      from that file at build time rather than kept as a second copy, so the
 *      two cannot disagree.
 *
 * Usage: node bin/build-isolated.mjs [--out <dir>] [--keep]
 * Produces exactly one artifact: pi-harness-isolated-<version>.tar.gz
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_NAME = "pi-harness";
// 0.3.0: an explicitly constructed, attested, read-only delegated child,
// durable read-scope escalation, crash orphaning, and live acceptance.
const VERSION = "0.3.1";

/* ------------------------------------------------------------------ *
 * Layout mapping
 * ------------------------------------------------------------------ */

/** Modules that live at the top of `src/` rather than under `src/core/`. */
const TOP_LEVEL = new Set(["types.ts", "agents.ts"]);

function destForHarnessModule(basename) {
  return TOP_LEVEL.has(basename) ? `src/${basename}` : `src/core/${basename}`;
}

/**
 * Rewrite import specifiers for a file's new home.
 *
 * Driven by where the file lands, not by pattern-matching the text, so a new
 * module added to src/harness/ is handled without editing this function.
 */
function rewriteImports(source, destRelative) {
  const inCore = destRelative.startsWith("src/core/");
  const isEntry = destRelative === "src/index.ts";
  const isTest = destRelative.startsWith("tests/");

  return source.replace(/from "([^"]+)"/g, (match, spec) => {
    // The extension entry: ../src/harness/x.ts -> ./core/x.ts (or ./x.ts).
    if (isEntry) {
      const m = spec.match(/^\.\.\/src\/harness\/(.+\.ts)$/);
      if (m) return `from "./${TOP_LEVEL.has(m[1]) ? m[1] : `core/${m[1]}`}"`;
      return match;
    }
    // Tests: ../src/harness/x.ts and ../extensions/pi-harness.ts.
    if (isTest) {
      const m = spec.match(/^\.\.\/src\/harness\/(.+\.ts)$/);
      if (m) return `from "../src/${TOP_LEVEL.has(m[1]) ? m[1] : `core/${m[1]}`}"`;
      if (spec === "../extensions/pi-harness.ts") return `from "../src/index.ts"`;
      return match;
    }
    // Sibling module references inside the moved tree.
    const sibling = spec.match(/^\.\/(.+\.ts)$/);
    if (sibling) {
      const target = sibling[1];
      if (inCore) {
        // A core module reaching a top-level module goes up one level.
        if (TOP_LEVEL.has(target)) return `from "../${target}"`;
        return match;
      }
      // A top-level module (types.ts, agents.ts) reaching a core module.
      if (!TOP_LEVEL.has(target)) return `from "./core/${target}"`;
      return match;
    }
    return match;
  });
}

/* ------------------------------------------------------------------ *
 * Sandbox inlining
 * ------------------------------------------------------------------ */

/**
 * Extract the bwrap argv builder from the control plane.
 *
 * Sliced between explicit markers and asserted, so a refactor that moves or
 * renames these functions fails the build loudly instead of shipping an
 * isolated package whose sandbox silently does nothing.
 */
function extractBwrapBuilder() {
  const source = fs.readFileSync(path.join(REPO, "src/control-plane/sandbox.ts"), "utf8");
  const start = source.indexOf("/**\n * POSIX single-quote escaping");
  const endMarker = "export function buildSandboxedCommand(command: string, options: SandboxCommandOptions): string {";
  const endStart = source.indexOf(endMarker);
  if (start < 0 || endStart < 0) {
    throw new Error(
      "build-isolated: could not locate shQuote/buildSandboxedCommand in src/control-plane/sandbox.ts. " +
        "The isolated sandbox must not be shipped without a real bwrap builder - fix the markers rather than skipping this.",
    );
  }
  const end = source.indexOf("\n}\n", endStart);
  if (end < 0) throw new Error("build-isolated: buildSandboxedCommand has no closing brace");
  return source.slice(start, end + 3);
}

function inlineSandbox(source) {
  const importLine = 'import { buildSandboxedCommand, shQuote } from "../control-plane/sandbox.ts";\n';
  if (!source.includes(importLine)) {
    throw new Error("build-isolated: src/harness/sandbox.ts no longer imports the control-plane builder");
  }
  const banner = `/* --- inlined bwrap builder ------------------------------------------ *
 *
 * In the pi-control-plane repository this lives in
 * src/control-plane/sandbox.ts and is imported, so there is exactly one copy.
 * The isolated package has no control plane, so the builder is inlined here
 * by bin/build-isolated.mjs, extracted verbatim from that file at build time.
 * Do not edit this block by hand: it is regenerated on every build, and an
 * edit here would be silently discarded on the next one.
 * ------------------------------------------------------------------- */

`;
  let out = source.replace(importLine, "");
  // The re-export of shQuote stays valid: the function is now defined locally.
  out = out.replace('export { shQuote };\n', "");
  const anchor = "/** Injected so the availability check is testable";
  if (!out.includes(anchor)) throw new Error("build-isolated: sandbox.ts anchor comment moved");
  return out.replace(anchor, `${banner}${extractBwrapBuilder()}\n\n${anchor}`);
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

function copyRewritten(srcAbs, destAbs, destRelative, transform) {
  let text = fs.readFileSync(srcAbs, "utf8");
  if (transform) text = transform(text);
  text = rewriteImports(text, destRelative);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.writeFileSync(destAbs, text, "utf8");
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outDir = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : REPO;
  const keep = args.includes("--keep");

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-isolated-"));
  const root = path.join(staging, PKG_NAME);
  fs.mkdirSync(path.join(root, "src", "core"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests", "smoke"), { recursive: true });

  // 1. Harness modules.
  const modules = fs
    .readdirSync(path.join(REPO, "src/harness"))
    .filter((f) => f.endsWith(".ts"))
    .sort();
  for (const basename of modules) {
    const destRelative = destForHarnessModule(basename);
    copyRewritten(
      path.join(REPO, "src/harness", basename),
      path.join(root, destRelative),
      destRelative,
      basename === "sandbox.ts" ? inlineSandbox : null,
    );
  }

  // 2. The extension entry.
  copyRewritten(
    path.join(REPO, "extensions/pi-harness.ts"),
    path.join(root, "src/index.ts"),
    "src/index.ts",
    null,
  );

  // 3. Tests.
  const tests = fs
    .readdirSync(path.join(REPO, "tests"))
    .filter((f) => f.startsWith("harness-") && f.endsWith(".test.ts"))
    .sort();
  for (const basename of tests) {
    copyRewritten(
      path.join(REPO, "tests", basename),
      path.join(root, "tests", basename),
      `tests/${basename}`,
      null,
    );
  }
  for (const basename of fs.readdirSync(path.join(REPO, "tests/smoke")).filter((f) => f.startsWith("harness-"))) {
    copyRewritten(
      path.join(REPO, "tests/smoke", basename),
      path.join(root, "tests/smoke", basename),
      `tests/smoke/${basename}`,
      null,
    );
  }

  // 4. Docs and package metadata.
  for (const doc of [
    "ARCHITECTURE2.md",
    "VALIDATION.md",
    "BUILD_STATUS.md",
    "PHASE3-EVIDENCE.json",
    "README-isolated.md",
  ]) {
    const from = path.join(REPO, doc);
    if (!fs.existsSync(from)) continue;
    const to = doc === "README-isolated.md" ? "README.md" : doc;
    fs.copyFileSync(from, path.join(root, to));
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: PKG_NAME,
        version: VERSION,
        private: true,
        type: "module",
        description:
          "Persistent personal agent harness for the Pi coding agent: scope as an authority object, append-only hash-chained evidence, durable state, recovery, and bounded delegation.",
        pi: { extensions: ["./src/index.ts"] },
        scripts: {
          test: 'node --test "tests/*.test.ts"',
          smoke: "node tests/smoke/harness-smoke.mjs",
        },
        dependencies: { typebox: "^1.1.38" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.pi/\n", "utf8");

  // 5. One artifact.
  fs.mkdirSync(outDir, { recursive: true });
  const artifact = path.join(outDir, `pi-harness-isolated-${VERSION}.tar.gz`);
  const tarFile = path.join(staging, `${PKG_NAME}.tar`);
  execFileSync("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-cf",
    tarFile,
    "-C",
    staging,
    PKG_NAME,
  ], { stdio: "inherit" });
  const artifactFd = fs.openSync(artifact, "w", 0o600);
  try {
    const compressed = spawnSync("gzip", ["-n", "-c", tarFile], {
      stdio: ["ignore", artifactFd, "inherit"],
    });
    if (compressed.status !== 0) {
      throw new Error(`build-isolated: gzip failed with status ${compressed.status}`);
    }
  } finally {
    fs.closeSync(artifactFd);
  }

  const fileCount = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 0 && !line.endsWith("/")).length;
  process.stdout.write(`${artifact}\n${fileCount} files\nstaging: ${keep ? staging : "(removed)"}\n`);
  if (!keep) fs.rmSync(staging, { recursive: true, force: true });
}

main();
