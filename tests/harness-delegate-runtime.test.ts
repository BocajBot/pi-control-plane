/**
 * The delegated child's authority boundary.
 *
 * These cover the enforcement layer that replaced Phase 2.1's blanket
 * refusal. The refusal was correct at the time and rested on a finding that
 * was itself half wrong: a nested Pi session does load the harness
 * extension, it simply never initializes it, so the gate inside the child
 * was inert. The fix is not to get an extension running in there - that was
 * always asking Pi to run our code for us - it is to make the child's only
 * tools be ones written here.
 *
 * The filesystem tests use real inodes on purpose. A scope check that is
 * only tested against strings is a scope check that has never met a symlink.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

import {
  attestCalls,
  attestChild,
  buildDelegateTools,
  canonicalRoots,
  openInScope,
  type DelegateRuntimeContract,
  type DelegateRuntimeLog,
} from "../src/harness/delegate-runtime.ts";

const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SECRET = "OUTSIDE-SECRET-42";

function fixture() {
  const root = fs.realpathSync(tmp("dr-scope-"));
  const outside = fs.realpathSync(tmp("dr-outside-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), SECRET + "\n");
  return { root, outside, roots: canonicalRoots([root]) };
}

const read = (target: string, roots: string[]): string => {
  const { fd, decision } = openInScope(target, roots, "file");
  if (fd === null) return `DENIED: ${decision.reason}`;
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
};

test("scope: an ordinary in-scope file is readable", () => {
  const { root, roots } = fixture();
  assert.equal(read(path.join(root, "src", "a.ts"), roots), "export const x = 1;\n");
});

test("scope: .. traversal out of the scope is refused", () => {
  const { root, outside, roots } = fixture();
  const escape = path.join(root, "src", "..", "..", path.basename(outside), "secret.txt");
  const got = read(escape, roots);
  assert.match(got, /^DENIED/);
  assert.ok(!got.includes(SECRET));
});

test("scope: a symlink pointing out of the scope is refused", () => {
  const { root, outside, roots } = fixture();
  const link = path.join(root, "src", "leak.txt");
  fs.symlinkSync(path.join(outside, "secret.txt"), link);

  const got = read(link, roots);
  assert.match(got, /final path component is a symlink/);
  assert.ok(!got.includes(SECRET));
});

test("scope: a symlinked intermediate directory is refused", () => {
  // O_NOFOLLOW only covers the last component. The canonical path of the
  // opened descriptor is what catches this one.
  const { root, outside, roots } = fixture();
  fs.symlinkSync(outside, path.join(root, "elsewhere"));

  const got = read(path.join(root, "elsewhere", "secret.txt"), roots);
  assert.match(got, /outside the delegated read scope/);
  assert.ok(!got.includes(SECRET));
});

test("scope: a hardlink alias is refused even though its path is inside", () => {
  // Every path-based check says this file is in scope, because it is. It is
  // also a second name for an inode something outside the scope holds and
  // can rewrite after the fact.
  const { root, outside, roots } = fixture();
  const alias = path.join(root, "src", "alias.txt");
  fs.linkSync(path.join(outside, "secret.txt"), alias);

  const got = read(alias, roots);
  assert.match(got, /refers to the same object/);
  assert.ok(!got.includes(SECRET));
});

test("scope: directory listing obeys the same boundary", () => {
  const { root, outside, roots } = fixture();
  const inside = openInScope(path.join(root, "src"), roots, "dir");
  assert.equal(inside.decision.allowed, true);
  if (inside.fd !== null) fs.closeSync(inside.fd);

  const out = openInScope(outside, roots, "dir");
  assert.equal(out.decision.allowed, false);
  assert.equal(out.fd, null);

  fs.symlinkSync(outside, path.join(root, "linkdir"));
  const viaLink = openInScope(path.join(root, "linkdir"), roots, "dir");
  assert.equal(viaLink.decision.allowed, false);
  assert.equal(viaLink.fd, null);
});

test("scope: a file is not a directory and a directory is not a file", () => {
  const { root, roots } = fixture();
  assert.match(read(path.join(root, "src"), roots), /not a regular file/);
  const asDir = openInScope(path.join(root, "src", "a.ts"), roots, "dir");
  assert.equal(asDir.decision.allowed, false);
});

test("scope: authorization survives a symlink swapped under it (race)", async () => {
  // The actual TOCTOU test, and it needs real concurrency: a single-threaded
  // flip-then-read loop leaves the filesystem stable across each read, so
  // the window never opens and the test proves nothing.
  //
  // A worker thread flips a name between an in-scope regular file and a
  // symlink to the secret, as fast as it can, while this thread reads it two
  // ways. The naive check-then-open reader is the discriminating control: if
  // it never leaks, the race did not land and the run is inconclusive rather
  // than passing.
  const { root, outside, roots } = fixture();
  const victim = path.join(root, "src", "victim.txt");
  const target = path.join(outside, "secret.txt");
  fs.writeFileSync(victim, "in-scope contents\n");

  const naive = (t: string): string => {
    // check(pathname) ... then open(pathname). The window is between them.
    try {
      const resolved = fs.realpathSync(t);
      if (!(resolved === root || resolved.startsWith(root + path.sep))) return "DENIED";
    } catch {
      return "DENIED";
    }
    try {
      return fs.readFileSync(t, "utf8");
    } catch {
      return "DENIED";
    }
  };

  const worker = new Worker(
    `const fs = require("node:fs");
     const { workerData, parentPort } = require("node:worker_threads");
     const { victim, target } = workerData;
     let stop = false;
     parentPort.on("message", () => { stop = true; });
     let flips = 0;
     while (!stop && flips < 4_000_000) {
       try { fs.rmSync(victim, { force: true }); fs.symlinkSync(target, victim); } catch {}
       try { fs.rmSync(victim, { force: true }); fs.writeFileSync(victim, "in-scope contents\\n"); } catch {}
       flips++;
     }
     parentPort.postMessage(flips);`,
    { eval: true, workerData: { victim, target } },
  );

  let naiveLeaks = 0;
  let safeLeaks = 0;
  let attempts = 0;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    attempts++;
    if (naive(victim).includes(SECRET)) naiveLeaks++;
    if (read(victim, roots).includes(SECRET)) safeLeaks++;
  }
  const flips: number = await new Promise((resolve) => {
    worker.once("message", resolve);
    worker.postMessage("stop");
  });
  await worker.terminate();

  assert.ok(attempts > 100, `too few read attempts to be meaningful: ${attempts}`);
  assert.ok(flips > 100, `the worker barely ran: ${flips} flips`);
  // Without a leaking control this test cannot distinguish "we are safe"
  // from "the race never happened".
  assert.ok(
    naiveLeaks > 0,
    `INCONCLUSIVE: the naive check-then-open reader never leaked across ${attempts} reads and ${flips} flips, so the check/open window was never exercised`,
  );
  assert.equal(
    safeLeaks,
    0,
    `openInScope leaked ${safeLeaks} time(s) out of ${attempts} while the naive reader leaked ${naiveLeaks}`,
  );
  console.log(`      race: ${attempts} reads, ${flips} flips, naive leaked ${naiveLeaks}, pinned-fd leaked ${safeLeaks}`);
});

/* ------------------------------------------------------------------ *
 * The child's tool surface
 * ------------------------------------------------------------------ */

function contractFor(root: string): DelegateRuntimeContract {
  return {
    contractId: "dlg_test",
    readRoots: [root],
    allowedTools: ["scoped_read", "scoped_list", "request_read_scope"],
    maxBytes: 64_000,
  };
}

const emptyLog = (): DelegateRuntimeLog => ({ calls: [], pendingRequests: [] });

function toolMap(root: string, log: DelegateRuntimeLog) {
  const tools = buildDelegateTools(contractFor(root), log) as Array<{
    name: string;
    execute: (id: unknown, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
  }>;
  return new Map(tools.map((t) => [t.name, t]));
}

test("child tools: exactly three, all read-only", async () => {
  const { root } = fixture();
  const tools = toolMap(root, emptyLog());
  assert.deepEqual([...tools.keys()].sort(), ["request_read_scope", "scoped_list", "scoped_read"]);
});

test("child tools: scoped_read enforces the boundary and logs every call", async () => {
  const { root, outside } = fixture();
  const log = emptyLog();
  const tools = toolMap(root, log);

  const ok = await tools.get("scoped_read")!.execute(null, { file_path: path.join(root, "src", "a.ts") });
  assert.equal(ok.content[0].text, "export const x = 1;\n");

  const bad = await tools.get("scoped_read")!.execute(null, { file_path: path.join(outside, "secret.txt") });
  assert.match(bad.content[0].text, /outside the delegated read scope/);
  assert.ok(!bad.content[0].text.includes(SECRET));

  assert.equal(log.calls.length, 2);
  assert.equal(log.calls[0].allowed, true);
  assert.equal(log.calls[1].allowed, false);
  // Every call is attributable to the object actually opened, not the string
  // the model supplied.
  assert.equal(log.calls[0].resolved, fs.realpathSync(path.join(root, "src", "a.ts")));
});

test("child tools: request_read_scope records a request and grants nothing", async () => {
  const { root, outside } = fixture();
  const log = emptyLog();
  const tools = toolMap(root, log);

  const res = await tools.get("request_read_scope")!.execute(null, {
    path: outside,
    reason: "the task needs it",
  });
  assert.match(res.content[0].text, /This is a request, not a grant/);
  assert.equal(log.pendingRequests.length, 1);

  // And the scope really did not move.
  const still = await tools.get("scoped_read")!.execute(null, { file_path: path.join(outside, "secret.txt") });
  assert.ok(!still.content[0].text.includes(SECRET));
});

test("child tools: a read is capped so one call cannot drain the scope", async () => {
  const { root } = fixture();
  const big = path.join(root, "big.txt");
  fs.writeFileSync(big, "x".repeat(200_000));
  const log = emptyLog();
  const tools = buildDelegateTools({ ...contractFor(root), maxBytes: 1000 }, log) as Array<{
    name: string; execute: (i: unknown, p: unknown) => Promise<{ content: Array<{ text: string }> }>;
  }>;
  const res = await tools.find((t) => t.name === "scoped_read")!.execute(null, { file_path: big });
  assert.match(res.content[0].text, /\[truncated at 1000 bytes\]/);
  assert.ok(res.content[0].text.length < 1200);
});

test("child tools: runtime is attested before and after every invocation", async () => {
  const { root } = fixture();
  const log = emptyLog();
  const phases: string[] = [];
  const tools = buildDelegateTools(contractFor(root), log, () => "t", {
    attest: (phase, tool) => phases.push(`${phase}:${tool}`),
  }) as Array<{
    name: string; execute: (i: unknown, p: unknown) => Promise<unknown>;
  }>;
  await tools.find((t) => t.name === "scoped_read")!.execute(null, {
    file_path: path.join(root, "src", "a.ts"),
  });
  assert.deepEqual(phases, ["before:scoped_read", "after:scoped_read"]);
  assert.equal(log.attestationChecks, 2);
});

test("child tools: a pre-call runtime drift aborts before filesystem access", async () => {
  const { root } = fixture();
  const target = path.join(root, "src", "a.ts");
  const log = emptyLog();
  const tools = buildDelegateTools(contractFor(root), log, () => "t", {
    attest: (phase) => {
      if (phase === "before") throw new Error("unexpected active tool: bash");
    },
  }) as Array<{
    name: string; execute: (i: unknown, p: unknown) => Promise<unknown>;
  }>;
  await assert.rejects(
    tools.find((t) => t.name === "scoped_read")!.execute(null, { file_path: target }),
    /unexpected active tool: bash/,
  );
  assert.equal(log.calls.length, 0, "the guarded filesystem implementation must not run");
  assert.match(log.runtimeViolations?.[0] ?? "", /before scoped_read/);
});

test("ablation: removing the per-call attestor lets the same filesystem call execute", async () => {
  // Discriminating control for the test above. The simulated runtime is
  // already drifted; without the guard hook, the tool has no way to notice
  // and reaches the file. This proves the rejection test measures the added
  // boundary rather than an unrelated read failure.
  const { root } = fixture();
  const log = emptyLog();
  const tools = buildDelegateTools(contractFor(root), log) as Array<{
    name: string;
    execute: (i: unknown, p: unknown) => Promise<{ content: Array<{ text: string }> }>;
  }>;
  const result = await tools.find((t) => t.name === "scoped_read")!.execute(null, {
    file_path: path.join(root, "src", "a.ts"),
  });
  assert.equal(result.content[0].text, "export const x = 1;\n");
  assert.equal(log.attestationChecks, undefined, "the ablated path made no runtime check");
});

test("child tools: post-call runtime drift invalidates the invocation", async () => {
  const { root } = fixture();
  const log = emptyLog();
  const tools = buildDelegateTools(contractFor(root), log, () => "t", {
    attest: (phase) => {
      if (phase === "after") throw new Error("ambient extension appeared");
    },
  }) as Array<{
    name: string; execute: (i: unknown, p: unknown) => Promise<unknown>;
  }>;
  await assert.rejects(
    tools.find((t) => t.name === "scoped_read")!.execute(null, {
      file_path: path.join(root, "src", "a.ts"),
    }),
    /ambient extension appeared/,
  );
  assert.equal(log.calls.length, 1, "the call remains attributable even though its result is rejected");
  assert.match(log.runtimeViolations?.[0] ?? "", /after scoped_read/);
});

/* ------------------------------------------------------------------ *
 * Attestation
 * ------------------------------------------------------------------ */

const cleanSession = (tools: string[]) => ({
  getActiveToolNames: () => tools,
  getAllTools: () => tools.map((name) => ({ name })),
  systemPrompt: "you are a bounded subagent",
  resourceLoader: {
    getExtensions: () => ({ extensions: [] }),
    getSkills: () => ({ skills: [] }),
    getPrompts: () => ({ prompts: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
  },
});

test("attestation: a clean child passes", () => {
  const c = contractFor("/x");
  const a = attestChild(cleanSession(c.allowedTools), c);
  assert.equal(a.ok, true, a.violations.join("; "));
  assert.deepEqual(a.violations, []);
});

test("attestation: one unexpected builtin fails the child", () => {
  const c = contractFor("/x");
  const a = attestChild(cleanSession([...c.allowedTools, "bash"]), c);
  assert.equal(a.ok, false);
  assert.ok(a.violations.some((v) => v.includes("unexpected active tool(s): bash")));
});

test("attestation: a registered-but-inactive tool still fails the child", () => {
  // Pi exposes setActiveToolsByName on the session, so a tool that is merely
  // registered is one call away from active - and that call is reachable
  // from inside the child's own process.
  const c = contractFor("/x");
  const s = {
    ...cleanSession(c.allowedTools),
    getAllTools: () => [...c.allowedTools, "harness_delegate"].map((name) => ({ name })),
  };
  const a = attestChild(s, c);
  assert.equal(a.ok, false);
  assert.ok(a.violations.some((v) => v.includes("registered but not contracted: harness_delegate")));
});

test("attestation: a missing contracted tool is also a mismatch", () => {
  // Not pedantry. A delegate that quietly lost the tool it needed does not
  // fail, it fabricates - which is exactly what the first live subagent did.
  const c = contractFor("/x");
  const a = attestChild(cleanSession(["scoped_read"]), c);
  assert.equal(a.ok, false);
  assert.ok(a.violations.some((v) => v.includes("missing: request_read_scope, scoped_list")));
});

test("attestation: ambient resources fail the child", () => {
  const c = contractFor("/x");
  for (const [label, loader] of [
    ["extension", { getExtensions: () => ({ extensions: [{}] }) }],
    ["skill", { getSkills: () => ({ skills: [{}] }) }],
    ["prompt", { getPrompts: () => ({ prompts: [{}] }) }],
    ["context file", { getAgentsFiles: () => ({ agentsFiles: [{ path: "/p/AGENTS.md" }] }) }],
  ] as const) {
    const base = cleanSession(c.allowedTools);
    const a = attestChild({ ...base, resourceLoader: { ...base.resourceLoader, ...loader } }, c);
    assert.equal(a.ok, false, `${label} was not caught`);
  }
});

test("attestation: an uninspectable runtime fails rather than passes", () => {
  // The default has to be refusal. A session whose tool list throws is a
  // session nobody measured, and "we could not check" must never read as
  // "the check passed".
  const c = contractFor("/x");
  const a = attestChild(
    {
      getActiveToolNames: () => { throw new Error("no"); },
      getAllTools: () => { throw new Error("no"); },
      resourceLoader: undefined,
    },
    c,
  );
  assert.equal(a.ok, false);
  assert.ok(a.violations.some((v) => v.includes("could not be inspected")));
});

test("attestation: invoked tools outside the contract are drift", () => {
  const c = contractFor("/x");
  const log = emptyLog();
  log.calls.push({ tool: "scoped_read", argument: "/x/a", allowed: true, resolved: "/x/a", reason: "ok", at: "t" });
  assert.deepEqual(attestCalls(log, c), []);
  log.calls.push({ tool: "bash", argument: "rm -rf /", allowed: true, resolved: null, reason: "ok", at: "t" });
  assert.deepEqual(attestCalls(log, c), ["invoked a tool outside the contract: bash"]);
});
