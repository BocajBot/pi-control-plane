/**
 * probe-crop — single-variable control for click grounding (no input delivered).
 *
 * Sends the SAME request body the loop sends (buildRequestBody) for one saved
 * screenshot, varying only the image region: full root span vs one monitor.
 * Prints the model's aim mapped back to root pixels.
 *
 * Usage: jiti probe-crop.ts <png> <WxH+X+Y> <scaleW> <n> <task>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRequestBody, defaultConfigFromEnv, parseAction } from "./core";

const HERE = dirname(fileURLToPath(import.meta.url));
const [png, region, scaleW, n, task] = process.argv.slice(2);
const m = region.match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
if (!png || !m || !task) throw new Error("usage: probe-crop.ts <png> <WxH+X+Y> <scaleW> <n> <task>");
const [w, h, ox, oy] = m.slice(1).map(Number);
const cfg = defaultConfigFromEnv();
const out = join(HERE, "artifacts", "probe-crop");
const tag = `${process.env.PROBE_PROMPT ?? "core"}-${region.replace(/\+/g, "_")}-s${scaleW}-${cfg.model.replace(/[^\w.-]/g, "_")}`;
const jpg = join(out, `${tag}.jpg`);
execFileSync("convert", [png, "-crop", region, "+repage", "-resize", `${scaleW}x`, "-quality", "82", jpg]);
const url = `data:image/jpeg;base64,${readFileSync(jpg).toString("base64")}`;
const rows: unknown[] = [];
for (let i = 0; i < Number(n); i++) {
  const body = buildRequestBody(cfg, task, [], url, { w, h }) as any;
  // PROBE_PROMPT: "norm" = pre-dimension prompt (0-999 contract, no pixel facts);
  // "pixel" = explicit pixel contract with schema bounds w-1/h-1; unset = core.ts as is.
  const variant = process.env.PROBE_PROMPT ?? "core";
  if (variant === "norm") {
    body.messages[0].content = "You are a computer-use agent controlling one Linux desktop through screenshots. You see one screenshot of the entire screen. The task is given by the user. Respond with EXACTLY ONE JSON action matching the required schema. Coordinates x/y (and x2/y2 for drag) are normalized integers 0-999 mapped to the full screen width/height. Think in the 'thought' field with one short sentence; then act. Choose action 'done' as soon as the task is complete. The 'thought' of a 'done' action is the final answer. Never type shell commands, credentials, or destructive instructions.";
  } else if (variant === "pixel") {
    body.messages[0].content = `You are a computer-use agent controlling one Linux desktop through screenshots. The screenshot is EXACTLY ${w}x${h} pixels. The task is given by the user. Respond with EXACTLY ONE JSON action matching the required schema. Coordinates x/y (and x2/y2 for drag) are PIXEL coordinates in this screenshot: x from 0 to ${w - 1}, y from 0 to ${h - 1}. Think in the 'thought' field with one short sentence; then act. Choose action 'done' as soon as the task is complete. The 'thought' of a 'done' action is the final answer. Never type shell commands, credentials, or destructive instructions.`;
    const sch = JSON.parse(JSON.stringify(body.response_format.json_schema.schema));
    sch.description = "One GUI action. Coordinates are pixel coordinates in the screenshot.";
    for (const [k, max] of [["x", w - 1], ["x2", w - 1], ["y", h - 1], ["y2", h - 1]] as const) {
      sch.properties[k].maximum = max;
      sch.properties[k].description = `Pixel coordinate, 0..${max}.`;
    }
    body.response_format.json_schema.schema = sch;
  }
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const data = (await res.json()) as any;
  const content = data?.choices?.[0]?.message?.content ?? "";
  let row: Record<string, unknown>;
  try {
    const a = parseAction(content);
    const rx = a.x == null ? null : ox + Math.round((a.x / 999) * (w - 1));
    const ry = a.y == null ? null : oy + Math.round((a.y / 999) * (h - 1));
    row = { i, variant, action: a.action, raw: [a.x, a.y], root_if_norm: [rx, ry], root_if_pixel: [a.x == null ? null : ox + a.x, a.y == null ? null : oy + a.y], prompt_tokens: data?.usage?.prompt_tokens };
  } catch (e) {
    row = { i, error: String(e).slice(0, 120), finish: data?.choices?.[0]?.finish_reason };
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(join(out, `${tag}.json`), JSON.stringify({ png, region, scaleW, model: cfg.model, task, rows }, null, 2));
