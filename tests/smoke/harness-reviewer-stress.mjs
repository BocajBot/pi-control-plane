// Bounded stress of the retrospective evidence contract against REAL Pi
// session files - not fixtures, and not the short synthetic session the
// first live acceptance used.
//
// The contract is not redesigned here. Each axis is measured separately, so
// "the review was rejected" is never reported as one undifferentiated fact:
//
//   complete source read | citation syntactic validity | citation source
//   membership | parser success | review acceptance | semantic relevance
//
// Semantic relevance stays a warning. Nothing here can show that a cited
// entry supports the claim attached to it, and a gate that pretended
// otherwise would be measuring citation shape while calling it support.
//
//   node tests/smoke/harness-reviewer-stress.mjs [session.jsonl ...]
//   HARNESS_STRESS_MODELS=a,b  to override the reviewer models
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { harnessPaths, reviewDirFor } = await import(`${REPO}/src/harness/config.ts`);
const { readPiSession } = await import(`${REPO}/src/harness/session-reader.ts`);
const io = { readFile: (f) => fs.readFileSync(f, "utf8"), exists: (f) => fs.existsSync(f) };

// Two different model families, both local. Family diversity is the point -
// citation discipline is an instruction-following property, so a second
// model from the same family would mostly re-measure the first one.
const MODELS = (process.env.HARNESS_STRESS_MODELS ??
  "llama-swap/qwopus-35b-a3b-coder,llama-swap/glm-4.7-flash-mxfp4").split(",");

/** Pick the most feature-rich real sessions on disk. */
function corpus() {
  const base = path.join(os.homedir(), ".pi/agent/sessions");
  const out = [];
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) if (f.endsWith(".jsonl")) out.push(path.join(p, f));
  }
  return out
    .map((f) => {
      const r = readPiSession(f, io);
      const raw = fs.readFileSync(f, "utf8");
      return {
        file: f,
        lines: r.linesTotal,
        entries: r.entries.length,
        toolCalls: (raw.match(/"toolCall"/g) ?? []).length,
        failedTools: (raw.match(/"isError":true/g) ?? []).length,
        modelChanges: r.entries.filter((e) => e.type === "model_change").length,
        compactions: r.entries.filter((e) => e.type === "compaction").length,
      };
    })
    .sort((a, b) => b.lines - a.lines);
}

const picked = process.argv.slice(2).length
  ? process.argv.slice(2).map((f) => ({ file: f, ...readPiSession(f, io) }))
  : corpus().slice(0, 1);

console.log("corpus");
const all = corpus();
console.log(`  real sessions on disk: ${all.length}`);
console.log(`  complete source read:  ${all.filter((s) => s.lines > 0).length}/${all.length}`);
console.log(`  with tool calls:       ${all.filter((s) => s.toolCalls > 0).length}`);
console.log(`  with failed tools:     ${all.filter((s) => s.failedTools > 0).length}`);
console.log(`  with a model switch:   ${all.filter((s) => s.modelChanges > 1).length}`);
console.log(`  with compaction:       ${all.filter((s) => s.compactions > 0).length}`);
if (all.every((s) => s.compactions === 0))
  console.log("  NOTE: no real session on disk contains a compaction, so that axis is unexercised.");

function startPi(project, harnessHome, model) {
  const c = spawn("pi", ["--mode", "rpc", "--model", model], {
    cwd: project, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_HARNESS_HOME: harnessHome },
  });
  c.stderr.on("data", () => {});
  const seen = []; let buf = "";
  c.stdout.on("data", (k) => {
    buf += k; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      try {
        const m = JSON.parse(l); seen.push(m);
        if (m.type === "extension_ui_request" && m.method === "confirm")
          c.stdin.write(JSON.stringify({ type: "extension_ui_response", id: m.id, confirmed: true }) + "\n");
      } catch { /* not json */ }
    }
  });
  return {
    seen,
    send: (o) => c.stdin.write(JSON.stringify(o) + "\n"),
    wait: (p, ms) => new Promise((r) => {
      const t = setTimeout(() => r(null), ms);
      const iv = setInterval(() => { if (seen.some(p)) { clearInterval(iv); clearTimeout(t); r(true); } }, 300);
    }),
    stop: () => c.kill("SIGTERM"),
  };
}

const rows = [];
for (const target of picked) {
  const stat = all.find((s) => s.file === target.file) ?? target;
  for (const model of MODELS) {
    const W = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stress-"));
    const project = path.join(W, "proj");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), "{}\n");
    const harnessHome = path.join(W, "hh");
    const paths = harnessPaths(os.homedir(), project, { PI_HARNESS_HOME: harnessHome });
    fs.mkdirSync(path.dirname(paths.reviewQueueFile), { recursive: true, mode: 0o700 });

    const sessionId = "ses_" + Math.abs(hash(target.file)).toString(16).padStart(32, "0").slice(-32);
    fs.writeFileSync(paths.reviewQueueFile, JSON.stringify([{
      schemaVersion: 2, id: "rev_" + "0".repeat(32), sessionId,
      sessionFile: target.file, project, status: "pending",
      createdAt: new Date(0).toISOString(), reviewerModel: null, error: null,
    }], null, 2) + "\n");

    const api = startPi(project, harnessHome, model);
    await api.wait((m) => m.type === "extension_ui_request", 60000);
    api.send({ id: "run", type: "prompt", message: "/harness-review run" });
    await api.wait((m) => JSON.stringify(m).includes("Harness review"), 600000);
    await new Promise((r) => setTimeout(r, 2000));
    api.stop();

    // reviewDirFor slugs the session id; joining the raw id finds nothing.
    const genDir = reviewDirFor(paths, sessionId);
    let gen = null;
    try {
      const files = fs.readdirSync(genDir).filter((f) => f.endsWith(".json")).sort();
      gen = JSON.parse(fs.readFileSync(path.join(genDir, files[files.length - 1]), "utf8"));
    } catch { gen = null; }
    rows.push({ model, stat, gen, out: api.seen.filter((m) => JSON.stringify(m).includes("Harness review")).map((m) => JSON.stringify(m)).join(" ") });
  }
}

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

console.log("\nresults\n");
for (const r of rows) {
  const g = r.gen, a = g?.acceptance ?? {};
  const p = g?.proposals ?? {};
  const items = ["findings", "patterns", "mistakes", "userPreferences", "modelSpecificGuidance", "projectLessons", "unresolvedIssues"]
    .reduce((n, k) => n + (p[k]?.length ?? 0), 0) + (p.memoryCandidates?.length ?? 0);
  console.log(`${r.model}  over ${r.stat.lines} lines / ${r.stat.entries} entries / ${r.stat.toolCalls} tool calls / ${r.stat.failedTools} failed / ${r.stat.modelChanges} model changes`);
  if (!g) { console.log("   NO REVIEW GENERATION WRITTEN"); console.log(`   ${r.out.slice(0, 300)}`); continue; }
  console.log(`   complete source read      : ${a.readComplete}  (${a.linesRead}/${a.linesExpected})`);
  console.log(`   parser success            : ${a.shapeValid}   (${items} item(s) parsed)`);
  console.log(`   citation source membership: ${a.citationsValid}  (${(a.rejectedItems ?? []).length} uncited)`);
  console.log(`   review acceptance         : ${a.accepted}`);
  console.log(`   semantic relevance warning: ${a.uniformCitation ? "RAISED (all items cite one entry)" : "not raised"}`);
  console.log(`   prompt echoed into reply  : ${String(g.rawReply ?? "").includes("You are a retrospective reviewer.")}`);
  if (!a.accepted) console.log(`   reason: ${a.reason}`);
  for (const x of (a.rejectedItems ?? []).slice(0, 3)) console.log(`   UNCITED: ${String(x).slice(0, 100)}`);
}
