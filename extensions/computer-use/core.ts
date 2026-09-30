/**
 * computer-use core loop — perception/action sidecar.
 *
 * NO pi imports here on purpose: this module is runnable standalone (demo.ts)
 * and only talks to (a) the local llama-swap OpenAI-compatible endpoint and
 * (b) local X11 tools (import, convert, xdotool). The pi extension wrapper
 * lives in index.ts.
 *
 * Loop: capture screen -> POST image + task to local model with a grammar-
 * constrained action schema -> execute exactly one xdotool action -> repeat
 * until action == "done" or step budget is spent.
 *
 * SAFETY: every action is executed through a fixed xdotool allowlist; the
 * model never chooses a command line. `type`/`key` events still reach whatever
 * window has focus — the extension must NOT be pointed at a shell prompt with
 * the current models (nex-n25-mini: delete_database 3/3, injection-prone).
 * A destructive-action gate is required before production use (see README).
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ACTION_SCHEMA = JSON.parse(readFileSync(join(HERE, "schema.json"), "utf8"));

export interface ComputerUseConfig {
  /** llama-swap OpenAI-compatible base URL (models.json provider.baseUrl). */
  baseUrl: string;
  /** Model request id, including any ":nothink" style thinking suffix. */
  model: string;
  /** X11 display for capture + input. */
  display: string;
  /** Hard cap on perception/action iterations. */
  maxSteps: number;
  /** Screenshot width sent to the model (height scales proportionally). */
  scaleW: number;
  /** Capture region "WxH+X+Y" in root pixels; null = primary monitor. */
  region: string | null;
  /** MPX master pointer id for synthetic input; null = core pointer. */
  agentPointer: number | null;
  /** Sampling for action grounding (low = deterministic). */
  temperature: number;
  maxTokens: number;
  /** Where step artifacts are written; required for auditability. */
  artifactDir: string | null;
  /** When true, print xdotool commands instead of executing them. */
  dryRun: boolean;
  /** Wall-clock cap per subprocess call (ms). */
  execTimeoutMs: number;
}

export interface Action {
  action: "click" | "double_click" | "right_click" | "type" | "key" | "scroll" | "drag" | "wait" | "done";
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  key?: string;
  direction?: "up" | "down";
  thought: string;
}

export interface StepRecord {
  step: number;
  screenshot: string | null;
  action: Action;
  xdotool: string[];
  /** Actual pointer position read immediately before the press (displacement probe). */
  delivered_pointer: { x: number; y: number } | null;
  /** True when delivered pointer differed from the model's target (>2px). */
  displaced: boolean;
  model_meta: Record<string, unknown>;
}

export interface TaskResult {
  task: string;
  model: string;
  done: boolean;
  steps: StepRecord[];
  final_answer: string | null;
  error: string | null;
}

export function defaultConfigFromEnv(): ComputerUseConfig {
  return {
    baseUrl: process.env.COMPUTER_USE_BASE_URL ?? "http://localhost:9292/v1",
    model: process.env.COMPUTER_USE_MODEL ?? "nex-n25-mini:nothink",
    display: process.env.DISPLAY ?? ":0",
    maxSteps: Number(process.env.COMPUTER_USE_MAX_STEPS ?? 8),
    scaleW: Number(process.env.COMPUTER_USE_SCALE_W ?? 1280),
    region: process.env.COMPUTER_USE_REGION ?? null,
    agentPointer: process.env.COMPUTER_USE_AGENT_POINTER ? Number(process.env.COMPUTER_USE_AGENT_POINTER) : null,
    temperature: Number(process.env.COMPUTER_USE_TEMPERATURE ?? 0.2),
    maxTokens: Number(process.env.COMPUTER_USE_MAX_TOKENS ?? 300),
    artifactDir: process.env.COMPUTER_USE_ARTIFACT_DIR ?? null,
    dryRun: process.env.COMPUTER_USE_DRY_RUN === "1",
    execTimeoutMs: Number(process.env.COMPUTER_USE_EXEC_TIMEOUT_MS ?? 30_000),
  };
}

// ---------------------------------------------------------------------------
// capture / payload
// ---------------------------------------------------------------------------

function xEnv(cfg: ComputerUseConfig): NodeJS.ProcessEnv {
  const env = { ...process.env, DISPLAY: cfg.display };
  if (cfg.agentPointer === null) return env;
  // Steer X clients (xdotool) onto the agent's MPX master; see cu-client-pointer.c.
  return { ...env, LD_PRELOAD: join(HERE, "cu-client-pointer.so"), CU_CLIENT_POINTER: String(cfg.agentPointer) };
}

function run(cmd: string, args: string[], cfg: ComputerUseConfig, capture = true): string {
  return execFileSync(cmd, args, {
    env: xEnv(cfg),
    timeout: cfg.execTimeoutMs,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
  });
}

export interface Geometry {
  w: number;
  h: number;
  /** Root-pixel offset of the captured region (0,0 for a full-root capture). */
  x?: number;
  y?: number;
}

export function getScreenGeometry(cfg: ComputerUseConfig): Geometry {
  // ONE monitor, not the root span. Control (artifacts/probe-crop, n=5 per
  // arm): on the 3840x1080 dual-head span the model's y aim ran ~130px high
  // and x flipped between bases; on a single 1920x1080 monitor 10/10 aims
  // landed inside the target. The region offset maps aims back to root pixels.
  const parse = (s: string | undefined) => {
    const m = s?.match(/(\d+)x(\d+)\+(\d+)\+(\d+)/);
    return m ? { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) } : null;
  };
  if (cfg.region) {
    const g = parse(cfg.region);
    if (!g) throw new Error(`COMPUTER_USE_REGION must be WxH+X+Y, got ${cfg.region}`);
    return g;
  }
  const out = run("xrandr", ["--query"], cfg);
  const g = parse(out.match(/ connected primary (\S+)/)?.[1]) ?? parse(out.match(/ connected (\d\S+)/)?.[1]);
  if (!g) throw new Error(`could not parse a monitor geometry from xrandr: ${out.slice(0, 200)}`);
  return g;
}

/** Top-level windows from `xwininfo -root -children` that span the whole region. */
export function coveringWindows(childrenListing: string, geom: Geometry): string[] {
  const rx = geom.x ?? 0;
  const ry = geom.y ?? 0;
  const ids: string[] = [];
  for (const m of childrenListing.matchAll(/^\s+(0x[0-9a-f]+) .*?\s(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\s+\+-?\d+\+-?\d+\s*$/gm)) {
    const [w, h, x, y] = m.slice(2).map(Number);
    if (x <= rx && y <= ry && x + w >= rx + geom.w && y + h >= ry + geom.h) ids.push(m[1]);
  }
  return ids;
}

/**
 * A mapped InputOnly window spanning the capture region swallows every click
 * while staying invisible in screenshots. Observed 2026-09-29: the Deskflow
 * server maps one (3840x1080, override-redirect) while the user's cursor is
 * on another machine; 7 correctly aimed clicks never reached the dialog.
 * Returns the window id, or null when input can reach the screen.
 */
function findInputCover(cfg: ComputerUseConfig, geom: Geometry): string | null {
  for (const id of coveringWindows(run("xwininfo", ["-root", "-children"], cfg), geom)) {
    const info = run("xwininfo", ["-id", id], cfg);
    if (/Class:\s*InputOnly/.test(info) && /Map State:\s*IsViewable/.test(info)) return id;
  }
  return null;
}

function captureScreen(cfg: ComputerUseConfig, pngPath: string, geom: Geometry): void {
  // X11: ImageMagick root-window capture (grim is Wayland-only), cropped to
  // the capture region so the model sees exactly the geometry it is told.
  run("import", ["-window", "root", "-crop", `${geom.w}x${geom.h}+${geom.x ?? 0}+${geom.y ?? 0}`, "+repage", pngPath], cfg, false);
}

function toPayloadImage(pngPath: string, cfg: ComputerUseConfig): string {
  // Downscale + JPEG keeps the vision payload small (TTFT) and is written to
  // a file first so the exact bytes sent to the model can be checksummed.
  const jpgPath = pngPath.replace(/\.png$/, ".jpg");
  run("convert", [pngPath, "-resize", `${cfg.scaleW}x`, "-quality", "82", jpgPath], cfg, false);
  return `data:image/jpeg;base64,${readFileSync(jpgPath).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// model call (grammar-constrained structured output)
// ---------------------------------------------------------------------------

function systemPrompt(geom: { w: number; h: number }): string {
  return [
    "You are a computer-use agent controlling one Linux desktop through screenshots.",
    `The screenshot is EXACTLY ${geom.w}x${geom.h} pixels.`,
    "The task is given by the user.",
    "Respond with EXACTLY ONE JSON action matching the required schema.",
    `Coordinates x/y (and x2/y2 for drag) are PIXEL coordinates in this screenshot: x from 0 to ${geom.w - 1}, y from 0 to ${geom.h - 1}.`,
    "Think in the 'thought' field with one short sentence; then act.",
    "Choose action 'done' as soon as the task is complete. The 'thought' of a 'done' action is the final answer.",
    "Never type shell commands, credentials, or destructive instructions.",
  ].join(" ");
}

function actionSchema(geom: { w: number; h: number }) {
  // schema.json carries the static shape; coordinate bounds are per-capture.
  const sch = JSON.parse(JSON.stringify(ACTION_SCHEMA));
  sch.description = "One GUI action for the computer-use loop. Coordinates are pixel coordinates in the screenshot.";
  for (const [k, max] of [["x", geom.w - 1], ["x2", geom.w - 1], ["y", geom.h - 1], ["y2", geom.h - 1]] as const) {
    sch.properties[k].maximum = max;
    sch.properties[k].description = `Pixel coordinate, 0..${max}.`;
  }
  return sch;
}

export function buildRequestBody(cfg: ComputerUseConfig, task: string, history: string[], imageDataUrl: string, geom: { w: number; h: number }) {
  const historyText = history.length ? `Previous actions:\n${history.join("\n")}\n\n` : "";
  return {
    model: cfg.model,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    messages: [
      { role: "system", content: systemPrompt(geom) },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${historyText}Task: ${task}\n\nCurrent screenshot attached. Emit the next single action as JSON.`,
          },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    // llama.cpp grammar-constrained decoding: the token mask guarantees the
    // response parses as the schema, eliminating the JSON repair/retry loop.
    response_format: {
      type: "json_schema",
      json_schema: { name: "computer_action", schema: actionSchema(geom), strict: true },
    },
  };
}

export function parseAction(content: string): Action {
  // With strict json_schema this is already valid JSON; the regex fallback
  // exists only for non-strict servers and is loud about being a fallback.
  let raw = content.trim();
  if (!raw.startsWith("{")) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`model returned no JSON object: ${raw.slice(0, 200)}`);
    raw = m[0];
    console.error("[computer-use] WARNING: loose JSON extraction fallback used");
  }
  const a = JSON.parse(raw) as Action;
  if (typeof a.action !== "string" || typeof a.thought !== "string") {
    throw new Error(`action/thought missing in model response: ${raw.slice(0, 200)}`);
  }
  return a;
}

async function callModel(cfg: ComputerUseConfig, task: string, history: string[], imageDataUrl: string, geom: { w: number; h: number }): Promise<{ action: Action; meta: Record<string, unknown> }> {
  const body = buildRequestBody(cfg, task, history, imageDataUrl, geom);
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`model call failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const msg = data?.choices?.[0]?.message;
  if (!msg?.content) throw new Error(`model returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  return {
    action: parseAction(msg.content),
    meta: {
      id: data.id,
      usage: data.usage ?? null,
      finish_reason: data.choices?.[0]?.finish_reason ?? null,
      reasoning_content_present: typeof msg.reasoning_content === "string",
    },
  };
}

// ---------------------------------------------------------------------------
// action execution (fixed allowlist -> xdotool argv)
// ---------------------------------------------------------------------------

export function actionToArgv(a: Action, geom: Geometry): string[] {
  // Screenshot pixel -> root pixel: add the capture region's offset.
  const sx = (x: number) => (geom.x ?? 0) + x;
  const sy = (y: number) => (geom.y ?? 0) + y;
  switch (a.action) {
    case "click":
      return ["mousemove", String(sx(a.x!)), String(sy(a.y!)), "click", "1"];
    case "double_click":
      return ["mousemove", String(sx(a.x!)), String(sy(a.y!)), "click", "--repeat", "2", "--delay", "120", "1"];
    case "right_click":
      return ["mousemove", String(sx(a.x!)), String(sy(a.y!)), "click", "3"];
    case "type":
      return ["type", "--delay", "25", "--", a.text!];
    case "key":
      return ["key", "--", a.key!];
    case "scroll":
      return ["click", a.direction === "up" ? "4" : "5"];
    case "drag":
      return ["mousemove", String(sx(a.x!)), String(sy(a.y!)), "mousedown", "1", "mousemove", String(sx(a.x2!)), String(sy(a.y2!)), "mouseup", "1"];
    case "wait":
      return ["sleep", "1"]; // placeholder; handled by executor
    case "done":
      return [];
    default:
      throw new Error(`unsupported action: ${(a as Action).action}`);
  }
}

function validateAction(a: Action, geom: { w: number; h: number }): void {
  const max = { x: geom.w - 1, y: geom.h - 1, x2: geom.w - 1, y2: geom.h - 1 };
  const needXY = ["click", "double_click", "right_click", "drag"];
  if (needXY.includes(a.action)) {
    for (const k of ["x", "y"] as const) {
      const v = a[k];
      if (typeof v !== "number" || v < 0 || v > max[k]) throw new Error(`${a.action} needs integer ${k} in 0..${max[k]}, got ${String(v)}`);
    }
  }
  if (a.action === "drag") {
    for (const k of ["x2", "y2"] as const) {
      const v = a[k];
      if (typeof v !== "number" || v < 0 || v > max[k]) throw new Error(`drag needs integer ${k} in 0..${max[k]}, got ${String(v)}`);
    }
  }
  if (a.action === "type" && typeof a.text !== "string") throw new Error("type needs text");
  if (a.action === "key" && typeof a.key !== "string") throw new Error("key needs key");
  if (a.action === "scroll" && !["up", "down"].includes(a.direction ?? "")) throw new Error("scroll needs direction up|down");
  // Minimal destructive-input guard (model card: delete_database 3/3 hazard).
  if (a.action === "type" && /\brm\s+-|sudo\b|pkexec\b|:\(\)\s*\{|mkfs\b|dd\s+if=|shutdown\b|reboot\b/i.test(a.text!)) {
    throw new Error(`refusing destructive-looking type payload: ${a.text!.slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

export async function runTask(task: string, cfg: ComputerUseConfig): Promise<TaskResult> {
  const geom = getScreenGeometry(cfg);
  const steps: StepRecord[] = [];
  const history: string[] = [];
  let finalAnswer: string | null = null;
  let error: string | null = null;
  let done = false;

  if (cfg.artifactDir) mkdirSync(cfg.artifactDir, { recursive: true });

  for (let step = 1; step <= cfg.maxSteps && !done; step++) {
    const cover = cfg.dryRun ? null : findInputCover(cfg, geom);
    if (cover) {
      error = `input blocked: InputOnly window ${cover} covers the capture region and would swallow clicks (Deskflow maps one while the cursor is on another machine). Move the cursor back to this screen and retry.`;
      console.error(`[computer-use] step ${step}: ${error}`);
      break;
    }
    const shotPng = cfg.artifactDir ? join(cfg.artifactDir, `step-${String(step).padStart(2, "0")}.png`) : `/dev/null`;
    if (cfg.artifactDir) captureScreen(cfg, shotPng, geom);
    const imageDataUrl = cfg.artifactDir
      ? toPayloadImage(shotPng, cfg)
      : captureToDataUrl(cfg, cfg.scaleW);

    let action: Action;
    let meta: Record<string, unknown> = {};
    try {
      const r = await callModel(cfg, task, history, imageDataUrl, geom);
      action = r.action;
      meta = r.meta;
      validateAction(action, geom);
    } catch (e) {
      const msg = String(e);
      // Model-side malformed actions are recoverable (the grammar does not
      // enforce per-action required fields — observed twice: click without x/y).
      // Feed the error back and let the model correct itself. Transport
      // failures remain terminal.
      const recoverable =
        msg.includes("needs integer") || msg.includes("needs text") || msg.includes("needs key") ||
        msg.includes("needs direction") || msg.includes("refusing") || msg.includes("no JSON object") ||
        msg.includes("no content");
      if (recoverable) {
        console.error(`[computer-use] step ${step}: invalid model action (${msg.split("\n")[0]}); feeding back for retry`);
        history.push(`step ${step}: INVALID ACTION (${msg.split("\n")[0]}). Emit ONE corrected JSON action with every field your chosen action requires (click/double_click/right_click need integer pixel x in 0..${geom.w - 1} and y in 0..${geom.h - 1}).`);
        if (cfg.artifactDir) {
          writeFileSync(join(cfg.artifactDir, `step-${String(step).padStart(2, "0")}.invalid.json`), JSON.stringify({ error: msg }, null, 2));
        }
        continue;
      }
      error = msg;
      break;
    }

    const argv = actionToArgv(action, geom);
    let delivered: { x: number; y: number } | null = null;
    let displaced = false;

    if (cfg.dryRun) {
      console.error(`[computer-use] DRY-RUN step ${step}: xdotool ${argv.join(" ")}`);
    } else if (action.action === "wait") {
      await new Promise((r) => setTimeout(r, 1000));
    } else if (action.action !== "done") {
      // Displacement probe: physical mouse movement interleaves with synthetic
      // XTEST input (observed 2026-09-29), so a miss cannot be attributed to the
      // model unless we record where the pointer actually was at press time.
      // getmouselocation runs inside the SAME xdotool invocation, immediately
      // before the press, keeping the probe window sub-millisecond.
      const pressAt = argv.findIndex((s) => s === "click" || s === "mousedown");
      let probeArgv = argv;
      if (pressAt !== -1) {
        probeArgv = [...argv.slice(0, pressAt), "getmouselocation", "--shell", ...argv.slice(pressAt)];
      }
      const out = run("xdotool", probeArgv, cfg);
      const m = out.match(/X=(\d+)[\r\n]+Y=(\d+)/);
      if (m) {
        delivered = { x: Number(m[1]), y: Number(m[2]) };
        const want = argv.slice(0, pressAt === -1 ? 0 : pressAt).filter((s) => /^\d+$/.test(s)).map(Number);
        if (want.length >= 2) {
          const [tx, ty] = [want[want.length - 2], want[want.length - 1]];
          if (Math.abs(delivered.x - tx) > 2 || Math.abs(delivered.y - ty) > 2) {
            displaced = true;
            console.error(
              `[computer-use] CLICK DISPLACED: target (${tx},${ty}) delivered (${delivered.x},${delivered.y}) — physical input interference; do not attribute this miss to the model`,
            );
          }
        }
      }
    }
    steps.push({
      step,
      screenshot: shotPng,
      action,
      xdotool: argv,
      delivered_pointer: delivered,
      displaced,
      model_meta: meta,
    });

    history.push(`step ${step}: ${JSON.stringify({ action: action.action, x: action.x, y: action.y, text: action.text, key: action.key, thought: action.thought })}`);

    if (action.action === "done") {
      done = true;
      finalAnswer = action.thought;
    }
    if (cfg.artifactDir) {
      writeFileSync(join(cfg.artifactDir, `step-${String(step).padStart(2, "0")}.model.json`), JSON.stringify(action, null, 2));
    }
  }

  const result: TaskResult = { task, model: cfg.model, done, steps, final_answer: finalAnswer, error };
  if (cfg.artifactDir) {
    const tracePath = join(cfg.artifactDir, "trace.json");
    writeFileSync(tracePath, JSON.stringify(result, null, 2));
    const sha = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    writeFileSync(
      join(cfg.artifactDir, "manifest.json"),
      JSON.stringify(
        {
          generated_by: "extensions/computer-use/demo.ts",
          task,
          model: cfg.model,
          base_url: cfg.baseUrl,
          trace_sha256: sha,
          note: "screenshot pngs + downscaled jpgs kept alongside; model saw the jpg bytes",
        },
        null,
        2,
      ),
    );
  }
  return result;
}

function captureToDataUrl(cfg: ComputerUseConfig, scaleW: number): string {
  // artifactDir-less capture (in-memory via temp files is avoided; this path
  // is only used when no audit trail was requested).
  throw new Error("captureToDataUrl: artifactDir-less mode not implemented; set COMPUTER_USE_ARTIFACT_DIR");
}

// ---------------------------------------------------------------------------
// self-test: validates schema, parsing, argv construction without GUI/GPU
// ---------------------------------------------------------------------------

export function selfTest(): void {
  // Right-hand monitor of a dual-head root: exercises the region offset.
  const geom = { w: 1920, h: 1080, x: 1920, y: 0 };
  // Expected argv values: screenshot pixel + region offset (x+1920, y+0).
  const cases: Array<[Action, string[]]> = [
    [{ action: "click", x: 500, y: 500, thought: "t" }, ["mousemove", "2420", "500", "click", "1"]],
    [{ action: "click", x: 0, y: 0, thought: "t" }, ["mousemove", "1920", "0", "click", "1"]],
    [{ action: "click", x: 1919, y: 1079, thought: "t" }, ["mousemove", "3839", "1079", "click", "1"]],
    [{ action: "double_click", x: 0, y: 1079, thought: "t" }, ["mousemove", "1920", "1079", "click", "--repeat", "2", "--delay", "120", "1"]],
    [{ action: "type", text: "hello world", thought: "t" }, ["type", "--delay", "25", "--", "hello world"]],
    [{ action: "key", key: "ctrl+l", thought: "t" }, ["key", "--", "ctrl+l"]],
    [{ action: "scroll", direction: "down", thought: "t" }, ["click", "5"]],
    [{ action: "drag", x: 100, y: 100, x2: 900, y2: 900, thought: "t" }, ["mousemove", "2020", "100", "mousedown", "1", "mousemove", "2820", "900", "mouseup", "1"]],
  ];
  for (const [a, want] of cases) {
    validateAction(a, geom);
    const got = actionToArgv(a, geom);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`selfTest argv mismatch for ${a.action}: got ${got.join(" ")} want ${want.join(" ")}`);
    }
  }
  // negative cases must be rejected
  for (const bad of [
    { action: "type", text: "sudo rm -rf /", thought: "t" },
    { action: "click", x: 1920, y: 0, thought: "t" },
    { action: "click", x: 0, y: 1080, thought: "t" },
    { action: "type", thought: "t" },
  ] as Action[]) {
    let rejected = false;
    try { validateAction(bad, geom); } catch { rejected = true; }
    if (!rejected) throw new Error(`selfTest: bad action was NOT rejected: ${JSON.stringify(bad)}`);
  }
  // cover-window listing parse: only windows spanning the whole region count
  const listing = [
    '     0x4a00004 (has no name): ()  3840x1080+0+0  +0+0',
    '     0x203446 "[i3 con] container": ("i3-frame" "i3-frame")  1890x1025+15+40  +15+40',
    '     0x2046a8 "[i3 con] content DisplayPort-0": ("i3-frame" "i3-frame")  1920x1055+0+25  +0+25',
    '     0x2000000 "Chromium clipboard": ()  10x10+-100+-100  +-100+-100',
  ].join("\n");
  const cov = coveringWindows(listing, geom);
  if (JSON.stringify(cov) !== '["0x4a00004"]') throw new Error(`selfTest coveringWindows: got ${JSON.stringify(cov)}`);
  // parse round-trip
  const parsed = parseAction('{"action":"done","thought":"all good"}');
  if (parsed.action !== "done") throw new Error("selfTest parse failed");
  if (!ACTION_SCHEMA?.properties?.action?.enum?.includes("done")) throw new Error("schema not loaded");
  console.log("selfTest OK: argv construction, validation rejects, schema load, parse round-trip");
}
