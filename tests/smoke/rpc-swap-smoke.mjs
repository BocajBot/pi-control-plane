// Headless live verification of /swap over pi RPC mode (temporary model swap).
// Checks: set (immediate switch + notification), status, prompts-count
// countdown across a real turn, cancel revert, and persistence entries.
// Local llama-swap models only; no cloud calls.
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const REPO = process.env.CP_SMOKE_REPO ?? new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const MODEL_A = process.env.CP_SMOKE_MODEL ?? "llama-swap/qwopus-35b-a3b-coder";
const MODEL_B = process.env.CP_SMOKE_SWAP_B ?? "llama-swap/ministral-3-14b-reasoning";
const results = [];
const pass = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
};

function startPi(extraArgs = []) {
  const child = spawn("pi", ["--mode", "rpc", "--model", MODEL_A, ...extraArgs], {
    cwd: REPO, stdio: ["pipe", "pipe", "pipe"],
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
      try { msg = JSON.parse(line); } catch { continue; }
      for (const l of [...listeners]) l(msg);
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const waitFor = (predicate, timeoutMs, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(fn); reject(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
      const fn = (msg) => { if (predicate(msg)) { clearTimeout(timer); listeners.delete(fn); resolve(msg); } };
      listeners.add(fn);
    });
  const onEvery = (fn) => listeners.add(fn);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return { child, send, waitFor, onEvery, sleep };
}

async function main() {
  const pi = startPi();
  const notifications = [];
  const statuses = [];
  pi.onEvery((msg) => {
    if (msg.type === "extension_ui_request" && msg.method === "notify") notifications.push(String(msg.message ?? ""));
    if (msg.type === "extension_ui_request" && msg.method === "setStatus") statuses.push(String(msg.statusText ?? ""));
  });
  const idle = async () => {
    await pi.waitFor((m) => m.type === "agent_end", 240_000, "agent_end");
    await pi.waitFor((m) => m.type === "agent_settled", 240_000, "agent_settled");
  };
  const lastSwapStatus = () => notifications.filter((n) => /Swap active/.test(n)).at(-1) ?? "";

  pi.send({ id: "g0", type: "get_state" });
  const stateMsg = await pi.waitFor((m) => m.type === "response" && m.id === "g0", 30_000, "get_state");
  const sessionFile = stateMsg.data?.sessionFile;
  await pi.waitFor((m) => m.type === "extension_ui_request" && m.method === "setStatus", 30_000, "startup");
  pass("startup: session started", typeof sessionFile === "string", sessionFile ?? "no file");

  // 1. Set a swap to model B for 2 prompts.
  pi.send({ id: "s1", type: "prompt", message: `/swap ${MODEL_B} for 2 prompts` });
  await pi.waitFor((m) => m.type === "response" && m.id === "s1", 20_000, "/swap response");
  await pi.sleep(500);
  pass("swap set: notification", notifications.some((n) => n.includes("Swapped to")), notifications.filter((n) => /wap/i.test(n)).at(-1) ?? "none");

  // 2. Status shows the swap.
  pi.send({ id: "s2", type: "prompt", message: "/swap status" });
  await pi.waitFor((m) => m.type === "response" && m.id === "s2", 20_000, "/swap status response");
  await pi.sleep(300);
  pass("swap status: active with countdown", /Swap active/.test(lastSwapStatus()) && /2 more prompts/.test(lastSwapStatus()), lastSwapStatus());

  // 3. Status line carries the swap segment.
  pass("status line: ⇄ segment", statuses.some((s) => s.includes("⇄")), statuses.filter((s) => s.includes("⇄")).at(-1) ?? "none");

  // 4. One prompt on model B decrements the countdown to 1 (no revert yet).
  const statusCountBefore = notifications.length;
  pi.send({ id: "p1", type: "prompt", message: "Reply with exactly: ok" });
  await idle();
  pi.send({ id: "s3", type: "prompt", message: "/swap status" });
  await pi.waitFor((m) => m.type === "response" && m.id === "s3", 20_000, "/swap status 2");
  // The command's notify races the response event; wait for a FRESH Swap
  // active notification (one produced after s3 was sent) rather than sleeping.
  try {
    await pi.waitFor(() => notifications.slice(statusCountBefore).some((n) => /Swap active/.test(n)), 30_000, "fresh swap status");
  } catch { /* fall through to the assertion, which will show what arrived */ }
  pass("prompt counted down: 1 remaining", /\b1 more prompt\b/.test(notifications.slice(statusCountBefore).filter((n) => /Swap active/.test(n)).at(-1) ?? lastSwapStatus()), lastSwapStatus());

  // 5. Cancel: reverts to model A.
  pi.send({ id: "s4", type: "prompt", message: "/swap cancel" });
  await pi.waitFor((m) => m.type === "response" && m.id === "s4", 20_000, "/swap cancel response");
  await pi.sleep(800);
  pass("cancel: revert notification", notifications.some((n) => /Model swap ended \(you cancelled it\)/.test(n)), notifications.filter((n) => /swap ended|cancelled/i.test(n)).at(-1) ?? "none");

  // 6. Persistence: the session file holds swap entries; final one inactive.
  const lines = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const swapEntries = lines.filter((e) => e.type === "custom" && e.customType === "pi-control-plane-model-swap");
  pass("persistence: swap entries written", swapEntries.length >= 2, `${swapEntries.length} entries`);
  pass("persistence: final entry inactive (reverted)", swapEntries.length > 0 && swapEntries.at(-1)?.data?.applied === false, JSON.stringify(swapEntries.at(-1)?.data?.applied));

  pi.child.kill("SIGTERM");
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} swap RPC checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
