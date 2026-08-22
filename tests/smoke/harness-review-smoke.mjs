// Live end-to-end exercise of the retrospective review loop (M7/M8).
//
// This is the one path the rest of the test suite cannot reach: every other
// check either runs pure logic or drives the extension against a fake Pi.
// Running a reviewer needs a real pi process, a real nested agent session,
// and a real model on the other end.
//
// Two phases:
//   1. A working session that produces genuine evidence - an allowed read, a
//      denied out-of-scope write, a recorded decision - then closes, which
//      queues a retrospective review.
//   2. A second session that runs `/harness-review run` over the archived
//      audit records of the first, and stores whatever the reviewer proposes.
//
// Everything lands in a temp PI_HARNESS_HOME, so the real ~/.pi is untouched.
//
//   node tests/smoke/harness-review-smoke.mjs
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODEL = process.env.HARNESS_SMOKE_MODEL ?? "llama-swap/qwopus-35b-a3b-coder";
const results = [];
const pass = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
};
const note = (text) => console.log(`      ${text}`);

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-smoke-"));
const project = path.join(workRoot, "proj");
fs.mkdirSync(path.join(project, "src"), { recursive: true });
fs.writeFileSync(path.join(project, "package.json"), "{}\n");
fs.writeFileSync(path.join(project, "src", "retry.ts"), "export const retries = 3;\n");
const harnessHome = path.join(workRoot, "harness-home");

function startPi() {
  const child = spawn("pi", ["--mode", "rpc", "--model", MODEL], {
    cwd: project,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_HARNESS_HOME: harnessHome },
  });
  child.stderr.on("data", () => {});
  const listeners = new Set();
  const seen = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        seen.push(msg);
        for (const l of [...listeners]) l(msg);
      } catch {
        /* not a json line */
      }
    }
  });
  const api = {
    seen,
    send: (obj) => child.stdin.write(JSON.stringify(obj) + "\n"),
    onEvery: (fn) => listeners.add(fn),
    waitFor: (predicate, timeoutMs, label) =>
      new Promise((resolve, reject) => {
        for (const m of seen) if (predicate(m)) return resolve(m);
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeoutMs);
        const listener = (m) => {
          if (!predicate(m)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(m);
        };
        listeners.add(listener);
      }),
    stop: () => child.kill("SIGTERM"),
  };
  // Approve control-plane confirmations: pi short-circuits tool_call on the
  // first blocking handler, so declining there would stop the call before the
  // harness ever sees it.
  api.onEvery((m) => {
    if (m.type === "extension_ui_request" && m.method === "confirm") {
      api.send({ type: "extension_ui_response", id: m.id, confirmed: true });
    }
  });
  return api;
}

const flat = (m) => JSON.stringify(m);
const projectDir = () => {
  const base = path.join(harnessHome, "projects");
  const dirs = fs.existsSync(base) ? fs.readdirSync(base) : [];
  return dirs.length === 1 ? path.join(base, dirs[0]) : null;
};

/* ---------------------------------------------------------------- *
 * Phase 1 - a session that produces real evidence
 * ---------------------------------------------------------------- */

console.log("PHASE 1: working session\n");
const s1 = startPi();
let firstSessionId = null;
try {
  await s1.waitFor((m) => m.type === "extension_ui_request", 45000, "startup");
  s1.send({ id: "m", type: "prompt", message: "/mode execute" });
  await new Promise((r) => setTimeout(r, 4000));
  // Confirm the mode took: in Discuss the control plane blocks every write
  // outright, the harness never sees it, and phase 1 yields no denial for the
  // reviewer to read. Check the latest status line, not the first.
  const modeNow =
    s1.seen
      .filter((m) => m.type === "extension_ui_request" && m.method === "setStatus" && typeof m.statusText === "string")
      .map((m) => m.statusText)
      .at(-1) ?? "(none)";
  pass("phase 1 reached execute mode", /[Ee]xecute/.test(modeNow), modeNow);

  // Evidence 1: a real decision record.
  s1.send({
    id: "d",
    type: "prompt",
    message: "/harness-decide durable retry count stays at 3 || measured p99 latency did not improve at 5",
  });
  await s1.waitFor((m) => flat(m).includes("recorded"), 45000, "decision recorded").catch(() => null);

  // Evidence 2: an in-scope read the harness allows.
  s1.send({ id: "r", type: "prompt", message: `Read the file ${path.join(project, "src", "retry.ts")} and tell me the retry count in one short sentence.` });
  await s1.waitFor((m) => m.type === "message_end", 180000, "read turn").catch(() => null);

  // Evidence 3: an out-of-scope write the harness denies.
  s1.send({
    id: "w",
    type: "prompt",
    message: `Use the write tool once to create ${path.join(workRoot, "escaped.txt")} containing hi. If blocked, say so briefly.`,
  });
  await s1.waitFor((m) => /outside scope|\[harness\]/.test(flat(m)), 180000, "denial").catch(() => null);

  const auditFile = projectDir() ? path.join(projectDir(), "audit.jsonl") : null;
  const lines = auditFile && fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n") : [];
  const events = lines.map((l) => JSON.parse(l));
  firstSessionId = events[0]?.session ?? null;
  pass("phase 1 produced audit evidence", events.length >= 2, `${events.length} events`);
  pass("  including a denial to learn from", events.some((e) => e.result.startsWith("denied")));
} finally {
  s1.stop();
}
await new Promise((r) => setTimeout(r, 2500));

const queueFile = path.join(harnessHome, "review-queue.json");
const queued = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, "utf8")) : [];
pass("session close queued a retrospective review", queued.length === 1 && queued[0].status === "pending", JSON.stringify(queued.map((q) => q.status)));

/* ---------------------------------------------------------------- *
 * Phase 2 - run the reviewer over that archived session
 * ---------------------------------------------------------------- */

console.log("\nPHASE 2: retrospective review\n");
const s2 = startPi();
try {
  await s2.waitFor((m) => m.type === "extension_ui_request", 45000, "startup");
  s2.send({ id: "rq", type: "prompt", message: "/harness-review list" });
  const listOut = await s2.waitFor((m) => flat(m).includes("review queue"), 45000, "queue listing").catch(() => null);
  pass("the queued review is visible in a later session", listOut !== null && flat(listOut).includes(firstSessionId ?? "ses_"));

  // The reviewer spawns a nested agent session and reads the whole archived
  // audit log, so this is the slowest step in the entire test suite.
  s2.send({ id: "rr", type: "prompt", message: "/harness-review run" });
  const reviewOut = await s2
    .waitFor((m) => /Review .*(complete|failed)|Nothing pending|SDK is unavailable/.test(flat(m)), 600000, "review completion")
    .catch(() => null);

  if (reviewOut === null) {
    pass("the reviewer ran to completion", false, "timed out after 10 minutes");
  } else {
    const text = flat(reviewOut);
    const completed = /complete/.test(text);
    pass("the reviewer ran to completion", completed, text.slice(0, 300));
    if (completed) {
      const m = text.match(/Memory promoted: (\d+)/);
      note(`reviewer output: ${text.replace(/\\n/g, " | ").slice(0, 400)}`);
      pass("  memory promotion was attempted and reported", m !== null, m ? `${m[1]} promoted` : "");
    }
  }
} finally {
  s2.stop();
}
await new Promise((r) => setTimeout(r, 2000));

/* ---------------------------------------------------------------- *
 * What actually landed on disk
 * ---------------------------------------------------------------- */

console.log("\nARTIFACTS\n");
const finalQueue = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, "utf8")) : [];
// Phase 2's own session close queues a review of itself, so a second pending
// item is expected. Assert on the phase-1 item by id.
const reviewed = finalQueue.find((q) => q.sessionId === firstSessionId);
pass("the phase-1 queue item is no longer pending", reviewed !== undefined && reviewed.status !== "pending", reviewed?.status ?? "(missing)");
if (reviewed?.error) note(`queue error: ${reviewed.error}`);
note(`queue now: ${finalQueue.map((q) => `${q.status}`).join(", ")} (a session that runs a review is itself reviewable)`);

// Section 32 stores reviews as generations: reviews/<sessionId>/<NNN>.json.
// This script used to read reviews/<file>.json and died on EISDIR.
const reviewsDir = path.join(harnessHome, "reviews");
const reviewDirs = fs.existsSync(reviewsDir)
  ? fs.readdirSync(reviewsDir).filter((d) => fs.statSync(path.join(reviewsDir, d)).isDirectory())
  : [];
pass("a review record was written to reviews/", reviewDirs.length === 1, reviewDirs.join(", "));
if (reviewDirs.length === 1) {
  const genDir = path.join(reviewsDir, reviewDirs[0]);
  const gens = fs.readdirSync(genDir).filter((f) => f.endsWith(".json")).sort();
  pass("  it is stored as a numbered generation, not an overwrite", gens.length >= 1, gens.join(", "));
  const review = JSON.parse(fs.readFileSync(path.join(genDir, gens[gens.length - 1]), "utf8"));
  const p = review.proposals ?? {};
  note(
    `proposals: findings=${(p.findings ?? []).length} patterns=${(p.patterns ?? []).length} mistakes=${(p.mistakes ?? []).length} memory=${(p.memoryCandidates ?? []).length} guidance=${(p.modelSpecificGuidance ?? []).length}`,
  );
  pass("  the reviewing model is recorded (MO4)", Boolean(review.reviewerModel?.model), review.reviewerModel?.model ?? "(none)");

  // Section 32 condition 1, which is the point of this run: the coverage
  // claim has to be over Pi's session JSONL. v0.2 measured the harness audit
  // log and passed while never opening the session file.
  const a = review.acceptance ?? {};
  pass(
    "  condition 1 was measured over the Pi session file",
    a.readComplete === true && a.linesExpected > 0 && a.linesRead === a.linesExpected,
    `readComplete=${a.readComplete} ${a.linesRead}/${a.linesExpected} lines`,
  );
  pass("  condition 2: the reply passed shape validation", a.shapeValid === true);
  pass(
    "  condition 3: every item cited an id from this session",
    a.citationsValid === true,
    a.citationsValid === true ? "" : `${(a.rejectedItems ?? []).length} uncited item(s)`,
  );
  for (const r of (a.rejectedItems ?? []).slice(0, 5)) note(`UNCITED: ${String(r).slice(0, 120)}`);
  pass("  the review was accepted", a.accepted === true, a.reason ?? "");

  const raw = review.rawReply ?? "";
  const total = Object.values(p).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  pass("  the reviewer's raw reply is retained as evidence", raw.length > 0, `${raw.length} chars`);
  // The prompt must not come back as part of the reply: the parser reads the
  // prompt's own section headers as proposals and sinks the whole review.
  pass(
    "  the raw reply is the reply, not the prompt echoed back",
    !raw.includes("You are a retrospective reviewer."),
    raw.includes("You are a retrospective reviewer.") ? "prompt found inside rawReply" : "",
  );
  if (total === 0) {
    const structured = /(^|\n)\s*#{0,6}\s*\**(FINDINGS|MISTAKES|MEMORY)\**\s*:?/.test(raw);
    note(`zero proposals; reply ${structured ? "USED the section headings (genuinely found nothing)" : "did NOT use the section headings (parse miss)"}`);
    note(`raw reply: ${raw.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  for (const f of (p.findings ?? []).slice(0, 3)) note(`finding: ${f.slice(0, 140)}`);
}

const memoryFile = path.join(harnessHome, "memory.jsonl");
const memory = fs.existsSync(memoryFile)
  ? fs.readFileSync(memoryFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
note(`durable memory entries: ${memory.length}`);
for (const e of memory.slice(0, 3)) note(`memory: [${e.createdBy}/${e.epistemicType}] ${e.content.slice(0, 120)} <- ${e.sourceReferences.join(",")}`);
pass(
  "M5 held: every promoted memory carries citations",
  memory.every((e) => e.createdBy !== "reviewer" || e.sourceReferences.length > 0),
);

const audit = projectDir() ? fs.readFileSync(path.join(projectDir(), "audit.jsonl"), "utf8") : "";
pass("the review is recorded in the audit log", audit.includes('"eventType":"review_complete"'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`artifacts: ${workRoot}`);
process.exit(failed.length > 0 ? 1 : 0);
