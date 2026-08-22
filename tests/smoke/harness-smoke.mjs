// Headless live smoke of the Pi Harness inside a real pi process.
//
// The unit tests prove the harness's logic and the extension-harness tests
// prove its wiring against a fake Pi. Neither proves the thing that matters
// most here: that pi actually loads this extension, that its enforcement
// runs inside a real session, and that the durable state lands on disk.
// That is what this script checks.
//
// It runs in a throwaway project directory with PI_HARNESS_HOME pointed at a
// temp directory, so it never touches the real ~/.pi harness state.
//
//   node tests/smoke/harness-smoke.mjs
//
// Env: HARNESS_SMOKE_MODEL overrides the model (default llama-swap default).
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

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-smoke-"));
const project = path.join(workRoot, "proj");
fs.mkdirSync(path.join(project, "src"), { recursive: true });
fs.writeFileSync(path.join(project, "package.json"), "{}\n");
fs.writeFileSync(path.join(project, "src", "hello.txt"), "hello\n");
const harnessHome = path.join(workRoot, "harness-home");

function startPi(extraArgs = []) {
  const child = spawn("pi", ["--mode", "rpc", "--model", MODEL, ...extraArgs], {
    cwd: project,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_HARNESS_HOME: harnessHome },
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString();
  });
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
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      seen.push(msg);
      for (const l of [...listeners]) l(msg);
    }
  });
  return {
    child,
    seen,
    stderrText: () => stderr,
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
}

/** Every bit of text in a message, for substring matching without having to
 * know pi's exact entry envelope for a custom entry type. */
const flat = (msg) => JSON.stringify(msg);

const pi = startPi();
let exitCode = 0;
try {
  // 1. The extension loads at all, inside a real pi process.
  await pi.waitFor((m) => m.type === "ready" || m.type === "session_start" || m.type === "extension_ui_request", 45000, "pi startup");
  pass("pi starts with the harness extension loaded (no load error)", !/pi-harness.*error|Failed to load.*pi-harness/i.test(pi.stderrText()), pi.stderrText().slice(0, 200));

  // 2. A harness command runs inside pi and reports real state.
  pi.send({ id: "h1", type: "prompt", message: "/harness status" });
  const status = await pi.waitFor((m) => flat(m).includes("Harness status"), 45000, "/harness status output");
  const statusText = flat(status);
  pass("/harness status responds inside pi", statusText.includes("Harness status"));
  pass("  reports the inferred project root", statusText.includes(project), project);
  pass("  reports guided autonomy and mutation approval by default", statusText.includes("guided") && statusText.includes("mutations"));

  // 3. Constitutional rules are visible to the user.
  pi.send({ id: "h2", type: "prompt", message: "/harness authority coordinator" });
  const authority = await pi.waitFor((m) => flat(m).includes("Harness authority"), 45000, "/harness authority output");
  pass("/harness authority lists the append-only audit rule", flat(authority).includes("append-oriented"));

  // 4. The durable state actually landed on disk, in the section 28 layout.
  const projects = path.join(harnessHome, "projects");
  const projectDirs = fs.existsSync(projects) ? fs.readdirSync(projects) : [];
  pass("harness home is created in the documented layout", projectDirs.length === 1, projects);
  const auditFile = projectDirs.length === 1 ? path.join(projects, projectDirs[0], "audit.jsonl") : null;
  const auditText = auditFile && fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "";
  pass("session start was audited to audit.jsonl", auditText.includes('"eventType":"session_start"'), auditFile ?? "(none)");

  // 5. Section 9, measured the way it actually manifests.
  //
  //    The first version of this check asked the model to call bash and
  //    waited for a denial. It never fired - because the model has no bash
  //    tool to call, which is the mechanism working, not failing. Waiting
  //    for a denial measures the backstop; what the user actually gets is
  //    the tool being gone. So ask the model what it can call.
  //
  //    This is only decisive because policy/profiles.json's "minimal"
  //    profile *grants* bash: if the live tool list lacks it anyway, the
  //    harness is the only thing that removed it.
  pi.send({
    id: "p1",
    type: "prompt",
    message:
      "Reply with ONLY a comma-separated list of the exact names of every tool you can call. No prose, no explanation.",
  });
  const toolReply = await pi
    .waitFor((m) => m.type === "message_end" && flat(m).includes("read"), 180000, "tool list reply")
    .catch(() => null);
  const listed = toolReply ? (toolReply.message?.content?.[0]?.text ?? "") : "";
  // Attribution control. In this repository the control plane ships a profile
  // that *grants* bash, so bash being absent below can only be the harness.
  // The isolated package has no control plane and no profile file at all, in
  // which case nothing else could have removed it either - so attribution
  // holds for a different reason, and the check says which one applies rather
  // than silently passing.
  const profilesUrl = new URL("../../policy/profiles.json", import.meta.url);
  const hasProfiles = fs.existsSync(profilesUrl);
  const profileGrantsBash = hasProfiles
    ? JSON.parse(fs.readFileSync(profilesUrl, "utf8")).profiles.minimal.tools.includes("bash")
    : false;
  pass(
    "bash removal is attributable to the harness",
    hasProfiles ? profileGrantsBash : true,
    hasProfiles ? "the shipped profile grants bash" : "no tool profile is present; nothing else could remove it",
  );
  pass("builtin bash is absent from the live tool list", listed.length > 0 && !/\bbash\b/.test(listed), listed);
  pass("the sandboxed shell is reachable in its place", /pi_harness_bash/.test(listed), listed);

  // 6. Enforcement at the tool_call seam, exercised with a tool the model
  //    can actually reach: a write outside the project scope.
  //
  //    The control plane defaults to Discuss, which blocks every write on
  //    its own - so without this the write is refused before the harness is
  //    consulted, and a passing check would be measuring the wrong
  //    extension. Put the session in execute mode so the harness gate is
  //    the one under test.
  pi.send({ id: "m1", type: "prompt", message: "/mode execute" });
  await pi.waitFor((m) => flat(m).includes("Execute") || flat(m).includes("execute"), 45000, "mode switch").catch(() => null);
  // Confirm the mode actually changed: if it did not, the control plane
  // blocks the write on its own and this section measures nothing.
  // Read the *latest* status line, not the first match. waitFor scans
  // messages already seen, so matching on "Mode:" finds the startup status
  // ("Mode: Discuss") and reports a stale value as the current one.
  pi.send({ id: "m2", type: "prompt", message: "/mode" });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const statusLines = pi.seen
    .filter((m) => m.type === "extension_ui_request" && m.method === "setStatus" && typeof m.statusText === "string")
    .map((m) => m.statusText);
  const currentMode = statusLines.at(-1) ?? "(no status seen)";
  pass("the control plane is in execute mode (so the harness gate is what is under test)", /[Ee]xecute/.test(currentMode), currentMode);

  // Answer confirmation prompts with "yes".
  //
  // pi short-circuits tool_call on the first blocking handler
  // (dist/core/extensions/runner.js: `if (result.block) return result`), and
  // the control plane is registered first. Declining its prompt would end the
  // call there and the harness would never see it - the run would prove
  // nothing about the harness. Approving means the control plane allows, and
  // the harness then has to catch the out-of-scope write on its own.
  let confirmAsked = null;
  pi.onEvery((m) => {
    if (m.type === "extension_ui_request" && m.method === "confirm") {
      confirmAsked = flat(m);
      pi.send({ type: "extension_ui_response", id: m.id, confirmed: true });
    }
  });
  const assistantTexts = [];
  pi.onEvery((m) => {
    if (m.type === "message_end" && m.message?.content?.[0]?.text) assistantTexts.push(m.message.content[0].text);
  });

  pi.send({
    id: "p2",
    type: "prompt",
    message: `Use the write tool exactly once to create the file ${path.join(workRoot, "escaped.txt")} containing the text hi. If it is blocked, quote the exact error.`,
  });
  const denial = await pi
    .waitFor((m) => /outside scope|\[harness\]/.test(flat(m)), 180000, "out-of-scope denial")
    .catch(() => null);
  pass("a write outside the scope root is blocked live", denial !== null, denial ? "" : `model said: ${(assistantTexts.at(-1) ?? "(nothing)").slice(0, 300)}`);
  pass("  and the file was not created", !fs.existsSync(path.join(workRoot, "escaped.txt")));
  if (confirmAsked) console.log(`      (a confirmation prompt was raised: ${confirmAsked.slice(0, 200)})`);

  const auditAfter = auditFile && fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "";
  pass("the decision is recorded in the append-only audit log", auditAfter.includes('"eventType":"authorization"'));
  pass("audit is append-only across the session (earlier lines intact)", auditAfter.startsWith(auditText));

  // 7. v0.2 capability authority (section 32), measured from the harness's
  //    own computed catalog rather than from the model's self-report.
  //
  //    The tool-list check above asks the model what it can call. That is
  //    decisive for bash being *absent* - a model does not omit a tool it
  //    has - but it is not a reliable enumeration, so it cannot show what
  //    was withheld. `/harness capability` reads the real getAllTools()
  //    catalog through the classifier, which is the thing under test.
  pi.send({ id: "c1", type: "prompt", message: "/harness capability" });
  const capability = await pi
    .waitFor((m) => flat(m).includes("Harness capabilities"), 45000, "/harness capability output")
    .catch(() => null);
  const capText = capability ? flat(capability) : "";
  pass("/harness capability reports the catalog live", capText.includes("Harness capabilities"));
  pass(
    "  harness tools are classified and active",
    /pi_harness_bash\s+\[harness, active\]/.test(capText.replace(/\\n/g, "\n")),
  );
  pass(
    "  an external extension's tool is catalogued as unconfined and withheld",
    /\[unconfined, catalog only\]/.test(capText.replace(/\\n/g, "\n")),
    "if this fails, either nothing external is loaded or the gate is not running",
  );

  // 8. v0.2 audit chaining (section 32), read back through /harness status.
  pi.send({ id: "s2", type: "prompt", message: "/harness status" });
  const status2 = await pi
    .waitFor((m) => flat(m).includes("Audit chain"), 45000, "/harness status audit chain")
    .catch(() => null);
  pass(
    "the live audit log verifies as a hash chain",
    status2 !== null && /Audit chain: verified: \d+ chained event/.test(flat(status2)),
    status2 ? (flat(status2).match(/Audit chain: [^"\\]+/) ?? [""])[0] : "(no reply)",
  );
} catch (error) {
  pass(`smoke aborted: ${error.message}`, false);
} finally {
  pi.stop();
}

// 6. Session close writes the recovery snapshot into the project.
await new Promise((resolve) => setTimeout(resolve, 1500));
const workstate = path.join(project, ".pi", "WORKSTATE.md");
pass("session close wrote .pi/WORKSTATE.md into the project", fs.existsSync(workstate), workstate);
if (fs.existsSync(workstate)) {
  pass("  WORKSTATE states it is not authoritative", fs.readFileSync(workstate, "utf8").includes("not the authoritative record"));
}

// 9. v0.2 recovery representation (section 32) on disk.
const projectsAfter = fs.existsSync(path.join(harnessHome, "projects"))
  ? fs.readdirSync(path.join(harnessHome, "projects"))
  : [];
const projDirAfter = projectsAfter.length === 1 ? path.join(harnessHome, "projects", projectsAfter[0]) : null;
const sessionsDir = projDirAfter ? path.join(projDirAfter, "sessions") : null;
const sessionFiles = sessionsDir && fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
pass("structured state is written per session, not as one project snapshot", sessionFiles.length >= 1, sessionsDir ?? "(none)");

const indexFile = path.join(harnessHome, "sessions.json");
const indexRows = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : [];
pass(
  "the global session index maps this session to its project root",
  Array.isArray(indexRows) && indexRows.some((row) => row.projectRoot === project),
  indexFile,
);

const workstatesDir = path.join(project, ".pi", "workstates");
const perSession = fs.existsSync(workstatesDir) ? fs.readdirSync(workstatesDir) : [];
pass("a per-session recovery copy is written alongside WORKSTATE.md", perSession.length >= 1, workstatesDir);
if (sessionFiles.length >= 1 && perSession.length >= 1) {
  const id = JSON.parse(fs.readFileSync(path.join(sessionsDir, sessionFiles[0]), "utf8")).id;
  pass("  and it is named for the session it describes", perSession.some((f) => f.startsWith(id)), `${id} -> ${perSession.join(",")}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`artifacts: ${workRoot}`);
if (failed.length > 0) exitCode = 1;
process.exit(exitCode);
