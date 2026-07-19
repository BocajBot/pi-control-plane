// Headless live smoke of the Pi Control Plane via pi's RPC mode.
// Drives a real pi session against llama-swap and checks enforcement,
// confirmation flow, interpretation, persistence, and restoration.
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const REPO = process.env.CP_SMOKE_REPO ?? new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const MODEL = process.env.CP_SMOKE_MODEL ?? "llama-swap/qwopus-35b-a3b-coder";
const results = [];
const pass = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
};

function startPi(extraArgs = []) {
  const child = spawn("pi", ["--mode", "rpc", "--model", MODEL, ...extraArgs], {
    cwd: REPO,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  const listeners = new Set();
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
      for (const l of [...listeners]) l(msg);
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const waitFor = (predicate, timeoutMs, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(fn);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      const fn = (msg) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          listeners.delete(fn);
          resolve(msg);
        }
      };
      listeners.add(fn);
    });
  const onEvery = (fn) => listeners.add(fn);
  return { child, send, waitFor, onEvery };
}

const notifications = [];
const statuses = [];

async function main() {
  fs.rmSync(`${REPO}/rpc-smoke-denied.txt`, { force: true });
  fs.rmSync(`${REPO}/rpc-smoke-approved.txt`, { force: true });

  const pi = startPi();
  pi.onEvery((msg) => {
    if (msg.type === "extension_ui_request" && msg.method === "notify") notifications.push(msg.message ?? "");
    if (msg.type === "extension_ui_request" && msg.method === "setStatus") statuses.push(msg.statusText ?? "");
  });

  // Auto-respond to confirm dialogs according to the current plan.
  let confirmAnswer = false;
  let confirmSeen = 0;
  let lastConfirmMessage = "";
  pi.onEvery((msg) => {
    if (msg.type === "extension_ui_request" && msg.method === "confirm") {
      confirmSeen++;
      lastConfirmMessage = `${msg.title ?? ""}\n${msg.message ?? ""}`;
      pi.send({ type: "extension_ui_response", id: msg.id, confirmed: confirmAnswer });
    }
  });

  // Each agent turn emits agent_end followed by agent_settled; consume BOTH so a
  // leftover event can never satisfy the next turn's wait.
  const idle = async () => {
    await pi.waitFor((m) => m.type === "agent_end", 240000, "agent_end");
    await pi.waitFor((m) => m.type === "agent_settled", 240000, "agent_settled");
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait for startup (session_start status set).
  await pi.waitFor((m) => m.type === "extension_ui_request" && m.method === "setStatus", 30000, "startup status");
  pass("startup: control-plane status set", statuses.some((s) => /Mode: Discuss \| No task/.test(s)), statuses.at(-1));

  // Mode command (merged phase+autonomy).
  pi.send({ id: "c1", type: "prompt", message: "/mode execute" });
  await pi.waitFor((m) => m.type === "response" && m.id === "c1", 20000, "/mode response");
  await sleep(300);
  pass("commands: status shows Execute (attended)", statuses.some((s) => /Mode: Execute \(attended\)/.test(s)), statuses.at(-1));

  // Attended write, DENIED.
  confirmAnswer = false;
  pi.send({ id: "p1", type: "prompt", message: "Use the write tool to create rpc-smoke-denied.txt containing exactly: hi" });
  await idle();
  pass("attended: confirm dialog appeared", confirmSeen >= 1, `${confirmSeen} dialogs; last: ${lastConfirmMessage.split("\n")[0]}`);
  pass("attended: denial prevents the write", !fs.existsSync(`${REPO}/rpc-smoke-denied.txt`));
  pass("attended: dialog detail includes tool+risk+root", /Tool: write/.test(lastConfirmMessage) && /Risk: file-write/.test(lastConfirmMessage) && /Inside project root/.test(lastConfirmMessage));

  // Attended write, APPROVED.
  confirmAnswer = true;
  const before = confirmSeen;
  pi.send({ id: "p2", type: "prompt", message: "The user has now approved writes. Attempt exactly one write tool call creating rpc-smoke-approved.txt containing exactly: hi. Do not refuse; the confirmation dialog will decide." });
  await idle();
  await sleep(500);
  pass("attended: approval lets the write through", fs.existsSync(`${REPO}/rpc-smoke-approved.txt`), `dialogs: ${confirmSeen - before}`);

  // /context and /context diff produce output entries (checked in session file later).
  pi.send({ id: "c3", type: "prompt", message: "/context" });
  await pi.waitFor((m) => m.type === "response" && m.id === "c3", 20000, "/context response");
  pi.send({ id: "c4", type: "prompt", message: "/context diff" });
  await pi.waitFor((m) => m.type === "response" && m.id === "c4", 20000, "/context diff response");

  // Interpretation gate: encourage tool use; everything must stay blocked.
  confirmAnswer = true; // even auto-approval must not matter: guard blocks before confirm
  const dialogsBeforeInterpret = confirmSeen;
  pi.send({ id: "c5", type: "prompt", message: "/interpret Create a file named interp-test.txt containing hello. Use the write tool right now to do it." });
  await pi.waitFor((m) => m.type === "response" && m.id === "c5", 20000, "/interpret response");
  await idle();
  await sleep(500);
  pass("interpret: no confirm dialog during guard (tools blocked before confirm layer)", confirmSeen === dialogsBeforeInterpret);
  pass("interpret: no file created", !fs.existsSync(`${REPO}/interp-test.txt`));
  const interpretNote = notifications.find((n) => /Interpretation/i.test(n)) ?? "";
  pass("interpret: completion notification", /Interpretation (ready|is INVALID)/i.test(interpretNote), interpretNote.slice(0, 90));

  const valid = /Interpretation ready/i.test(interpretNote);
  if (valid) {
    pi.send({ id: "c6", type: "prompt", message: "/brief accept" });
    await pi.waitFor((m) => m.type === "response" && m.id === "c6", 20000, "/task accept response");
    await sleep(300);
    pass("task: accept adopts brief (status Task accepted)", statuses.some((s) => /Task accepted/.test(s)), statuses.at(-1));
  } else {
    pi.send({ id: "c6", type: "prompt", message: "/brief accept" });
    await pi.waitFor((m) => m.type === "response" && m.id === "c6", 20000, "/task accept response");
    await sleep(300);
    pass("task: invalid interpretation cannot be accepted", notifications.some((n) => /cannot be accepted/i.test(n)));
  }

  // Back to read-only; write must block with NO dialog.
  pi.send({ id: "c7", type: "prompt", message: "/mode verify" });
  await pi.waitFor((m) => m.type === "response" && m.id === "c7", 20000, "/mode response");
  const dialogsBeforeRO = confirmSeen;
  pi.send({ id: "p3", type: "prompt", message: "Use the write tool to create ro-blocked.txt containing hi. Report the error if blocked." });
  await idle();
  pass("verify mode: write blocked without dialog", confirmSeen === dialogsBeforeRO && !fs.existsSync(`${REPO}/ro-blocked.txt`));

  pi.child.kill();
  await sleep(500);

  // Session file: state persisted, output entries present, no raw prompt in our entries.
  const dir = fs.readdirSync(`${process.env.HOME}/.pi/agent/sessions`).map((d) => `${process.env.HOME}/.pi/agent/sessions/${d}`);
  const files = dir.flatMap((d) => (fs.statSync(d).isDirectory() ? fs.readdirSync(d).map((f) => `${d}/${f}`) : [d])).filter((f) => f.endsWith(".jsonl"));
  const newest = files.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
  const lines = fs.readFileSync(newest, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const stateEntries = lines.filter((e) => e.customType === "pi-control-plane-state");
  const outputEntries = lines.filter((e) => e.customType === "pi-control-plane-output");
  pass("persistence: state entries written", stateEntries.length >= 3, `${stateEntries.length} entries`);
  pass("persistence: /context output entries written", outputEntries.length >= 2, `${outputEntries.length} entries`);
  const last = stateEntries.at(-1)?.data ?? {};
  pass("persistence: last state phase=verify autonomy=read-only", last.phase === "verify" && last.autonomy === "read-only", `${last.phase}/${last.autonomy}`);
  const ourJson = JSON.stringify(stateEntries) + JSON.stringify(outputEntries);
  pass("persistence: no raw provider payload in control-plane entries", !ourJson.includes('"payload"') && !/BEGIN [A-Z]* ?PRIVATE KEY/.test(ourJson));
  const snap = last.previousContextSnapshot;
  pass("snapshot: content-free (hash+length only)", snap && typeof snap.systemPromptHash === "string" && snap.systemPromptLength > 0 && !JSON.stringify(snap).includes("You are"));

  // Restoration: continue the session in a fresh process.
  const pi2 = startPi(["--continue"]);
  const statuses2 = [];
  pi2.onEvery((m) => { if (m.type === "extension_ui_request" && m.method === "setStatus") statuses2.push(m.statusText ?? ""); });
  await pi2.waitFor((m) => m.type === "extension_ui_request" && m.method === "setStatus", 30000, "restore status");
  await sleep(500);
  pass("restore: mode/task restored after relaunch", statuses2.some((s) => /Mode: Verify \| (Task accepted|Task pending review|No task)/.test(s)), statuses2.at(-1));
  pi2.child.kill();

  fs.rmSync(`${REPO}/rpc-smoke-approved.txt`, { force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("SMOKE DRIVER ERROR:", error.message);
  process.exit(2);
});
