// Standalone coordinator acceptance for the packaged (isolated) harness.
//
// harness-smoke.mjs is the coordinator smoke for the in-repo deployment, where
// the harness runs beside the control plane. Its first step waits for an
// unsolicited startup event (the control plane's extension_ui_request), and a
// standalone pi in rpc mode emits nothing until it is prompted - so that smoke
// cannot even begin against the isolated artifact. This probe exercises the
// same coordinator enforcement using the command-first interaction that the
// delegate and reviewer smokes already use against the packaged extension.
//
// It asserts only what the harness owns on its own; the control-plane-coupled
// checks (mode gating, an external extension's tool showing as unconfined) are
// out of scope for a package that ships no control plane and nothing external.
//
//   PI_CODING_AGENT_DIR=<agentdir with the packaged extension> \
//   HARNESS_SMOKE_MODEL=llama-swap/<model> \
//   node tests/smoke/harness-coordinator-standalone.mjs
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MODEL = process.env.HARNESS_SMOKE_MODEL ?? "llama-swap/qwen3-8-27b";
const results = [];
const pass = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
};

const WORKROOT = process.env.HARNESS_SMOKE_WORKROOT ?? os.tmpdir();
fs.mkdirSync(WORKROOT, { recursive: true });
const W = fs.mkdtempSync(path.join(WORKROOT, "pi-coord-std-"));
const project = path.join(W, "proj");
fs.mkdirSync(path.join(project, "src"), { recursive: true });
fs.writeFileSync(path.join(project, "package.json"), "{}\n");
// A realistic, self-contained project root. project.ts resolves the root by
// the nearest ancestor carrying a marker, and its highest-precedence marker is
// a .pi directory. Standalone (no control plane to supply the root), a bare
// working dir would otherwise resolve UP to the first .pi ancestor - which for
// any dir under $HOME is the user's own ~/.pi, scoping the session to $HOME and
// writing recovery state there. Giving this fixture its own .pi stops the walk
// here, which is exactly the shape a pi-initialised project has. (git init too,
// for the VCS-root marker.)
fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: project });
const harnessHome = path.join(W, "hh");

const c = spawn("pi", ["--mode", "rpc", "--model", MODEL], {
  cwd: project, stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_HARNESS_HOME: harnessHome },
});
let stderr = "";
c.stderr.on("data", (k) => { stderr += k.toString(); });
const seen = [];
let buf = "";
c.stdout.on("data", (k) => {
  buf += k.toString(); let i;
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
const send = (o) => c.stdin.write(JSON.stringify(o) + "\n");
const flat = (m) => JSON.stringify(m);
const waitFor = (pred, ms, label) => new Promise((resolve) => {
  for (const m of seen) if (pred(m)) return resolve(m);
  const t = setTimeout(() => resolve(null), ms);
  const iv = setInterval(() => { const m = seen.find(pred); if (m) { clearInterval(iv); clearTimeout(t); resolve(m); } }, 200);
});

try {
  // Readiness is a command answering, not an unsolicited banner: send a
  // harness command and wait for its reply. That the reply comes back at all
  // is the proof the packaged extension loaded and is running in this session.
  send({ id: "s1", type: "prompt", message: "/harness status" });
  const status = await waitFor((m) => flat(m).includes("Harness status"), 60000, "status");
  pass("packaged extension loads and answers a command in a real pi session", status !== null,
    status ? "" : stderr.slice(0, 200));
  pass("  no extension load error on stderr", !/pi-harness.*error|Failed to load.*pi-harness/i.test(stderr));
  const st = status ? flat(status) : "";
  pass("  /harness status reports the inferred project root", st.includes(project), project);
  pass("  reports guided autonomy and mutation approval by default", st.includes("guided") && st.includes("mutations"));

  // Constitutional rule visible.
  send({ id: "s2", type: "prompt", message: "/harness authority coordinator" });
  const auth = await waitFor((m) => flat(m).includes("Harness authority"), 45000, "authority");
  pass("/harness authority states the append-oriented audit rule", auth !== null && flat(auth).includes("append-oriented"));

  // Capability confinement, from the harness's own computed catalog.
  send({ id: "s3", type: "prompt", message: "/harness capability" });
  const cap = await waitFor((m) => flat(m).includes("Harness capabilities"), 45000, "capability");
  const capText = cap ? flat(cap).replace(/\\n/g, "\n") : "";
  pass("/harness capability reports the live catalog", cap !== null);
  pass("  harness tools are classified active", /pi_harness_bash\s+\[harness, active\]/.test(capText));

  // Confinement as the model actually experiences it: builtin bash is gone,
  // the sandboxed shell is in its place. Attribution holds for the isolated
  // package because it ships no profile that could have granted bash anyway.
  send({ id: "s4", type: "prompt", message: "Reply with ONLY a comma-separated list of the exact names of every tool you can call. No prose." });
  const toolReply = await waitFor((m) => m.type === "message_end" && flat(m).includes("read"), 180000, "tool list");
  const listed = toolReply ? (toolReply.message?.content?.[0]?.text ?? "") : "";
  pass("builtin bash is absent from the live tool list", listed.length > 0 && !/\bbash\b/.test(listed), listed.slice(0, 160));
  pass("  the sandboxed shell is reachable in its place", /pi_harness_bash/.test(listed));

  // Audit chain verifies live, read back through status.
  send({ id: "s5", type: "prompt", message: "/harness status" });
  const st2 = await waitFor((m) => flat(m).includes("Audit chain"), 45000, "audit chain");
  pass("the live audit log verifies as a hash chain",
    st2 !== null && /Audit chain: verified: \d+ chained event/.test(flat(st2)),
    st2 ? (flat(st2).match(/Audit chain: [^"\\]+/) ?? [""])[0] : "(no reply)");
} catch (e) {
  pass(`aborted: ${e.message}`, false);
} finally {
  c.kill("SIGTERM");
}

await new Promise((r) => setTimeout(r, 1500));

// Durable state landed on disk in the documented layout.
const projects = path.join(harnessHome, "projects");
const dirs = fs.existsSync(projects) ? fs.readdirSync(projects) : [];
pass("harness home created in the documented per-project layout", dirs.length === 1, projects);
const auditFile = dirs.length === 1 ? path.join(projects, dirs[0], "audit.jsonl") : null;
const auditText = auditFile && fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "";
pass("session start was audited to append-only audit.jsonl", auditText.includes('"eventType":"session_start"'));
const workstate = path.join(project, ".pi", "WORKSTATE.md");
pass("session close wrote .pi/WORKSTATE.md into the project", fs.existsSync(workstate));
if (fs.existsSync(workstate))
  pass("  WORKSTATE states it is not authoritative", fs.readFileSync(workstate, "utf8").includes("not the authoritative record"));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`artifacts: ${W}`);
process.exit(failed.length > 0 ? 1 : 0);
