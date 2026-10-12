/**
 * Image generation and editing against the local stable-diffusion.cpp
 * sd-server exposed by llama-swap as the `qwen-image` model (Qwen-Image-2.1
 * Q8_0 + Qwen3-VL-8B text encoder, XTX only, ~70 s per 1024x1024 image).
 *
 * Pure module apart from the injected POST: no Pi imports, no fs, no globals -
 * same shape as transcription.ts, so URL/size/response handling is
 * unit-testable without a server. The wiring layer (extension) reads the
 * reference images, builds FormData for edits, and writes the PNG to disk.
 *
 * Protocol (sd-server's OpenAI-compatible surface):
 *   POST {base}/images/generations  JSON  {model,prompt,size,n,seed?,response_format:"b64_json"}
 *   POST {base}/images/edits        multipart: image[] (reference PNG/JPEG), prompt, size, model, ...
 * Both answer {data:[{b64_json}]}.
 */

export const DEFAULT_IMAGEGEN_BASE_URL = "http://127.0.0.1:9292/v1";
export const DEFAULT_IMAGEGEN_MODEL = "qwen-image";
export const DEFAULT_IMAGE_SIZE = "1024x1024";
/** sd.cpp requires dimensions divisible by 32; Qwen-Image-2.1 is trained up
 * to 2048 on the long side. Anything larger is refused before upload so a
 * typo cannot pin the XTX for an hour. */
export const IMAGE_DIM_STEP = 32;
export const IMAGE_DIM_MIN = 256;
export const IMAGE_DIM_MAX = 2048;
export const MAX_REFERENCE_IMAGES = 10;

export interface ImageGenRequest {
  prompt: string;
  width: number;
  height: number;
  model: string;
  seed?: number;
  steps?: number;
  /** Reference images for editing; empty means text-to-image. */
  references: { filename: string; bytes: Uint8Array }[];
}

/** Injected transport. `json` carries the text-to-image body; `form` the
 * multipart fields for edits. Exactly one of the two is set. */
export type PostImageGen = (
  url: string,
  payload:
    | { kind: "json"; body: Record<string, unknown> }
    | { kind: "form"; fields: Record<string, string>; files: { field: string; filename: string; bytes: Uint8Array }[] },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type ImageGenOutcome =
  | { ok: true; pngBase64: string; width: number; height: number; seed?: number }
  | { ok: false; error: string };

/** "1024x1024" -> {width,height}; null on any malformed or out-of-range size. */
export function parseImageSize(size: string): { width: number; height: number } | null {
  const m = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(size);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  for (const d of [width, height]) {
    if (!Number.isInteger(d) || d < IMAGE_DIM_MIN || d > IMAGE_DIM_MAX || d % IMAGE_DIM_STEP !== 0) return null;
  }
  return { width, height };
}

export function buildImageGenUrl(baseUrl: string, edit: boolean): string | null {
  let origin: string;
  try {
    origin = new URL(baseUrl).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
  return `${origin}/images/${edit ? "edits" : "generations"}`;
}

function extractB64(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const list = (data as Record<string, unknown>).data;
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0];
  if (typeof first !== "object" || first === null) return null;
  const b64 = (first as Record<string, unknown>).b64_json;
  return typeof b64 === "string" && b64.length > 0 ? b64 : null;
}

export async function generateImage(
  baseUrl: string,
  request: ImageGenRequest,
  post: PostImageGen,
): Promise<ImageGenOutcome> {
  const edit = request.references.length > 0;
  const url = buildImageGenUrl(baseUrl, edit);
  if (url === null) return { ok: false, error: `Malformed image server base URL: ${baseUrl}` };
  if (request.prompt.trim().length === 0) return { ok: false, error: "Empty prompt - nothing to generate." };
  if (request.references.length > MAX_REFERENCE_IMAGES) {
    return { ok: false, error: `Too many reference images (${request.references.length}); the model accepts at most ${MAX_REFERENCE_IMAGES}.` };
  }
  for (const ref of request.references) {
    if (ref.bytes.length === 0) return { ok: false, error: `Reference image ${ref.filename} is empty.` };
  }
  const size = `${request.width}x${request.height}`;

  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    if (edit) {
      const fields: Record<string, string> = { model: request.model, prompt: request.prompt, size, n: "1", response_format: "b64_json" };
      if (request.seed !== undefined) fields.seed = String(request.seed);
      if (request.steps !== undefined) fields.steps = String(request.steps);
      res = await post(url, {
        kind: "form",
        fields,
        files: request.references.map((r) => ({ field: "image[]", filename: r.filename, bytes: r.bytes })),
      });
    } else {
      const body: Record<string, unknown> = { model: request.model, prompt: request.prompt, size, n: 1, response_format: "b64_json" };
      if (request.seed !== undefined) body.seed = request.seed;
      if (request.steps !== undefined) body.steps = request.steps;
      res = await post(url, { kind: "json", body });
    }
  } catch (error) {
    return {
      ok: false,
      error:
        `Could not reach the image server at ${baseUrl}: ${String(error)}. ` +
        `Is llama-swap running, and is the "${request.model}" model defined in its config?`,
    };
  }
  if (!res.ok) return { ok: false, error: `Image server returned HTTP ${res.status}.` };

  let data: unknown;
  try {
    data = await res.json();
  } catch (error) {
    return { ok: false, error: `Image server response was not valid JSON: ${String(error)}` };
  }
  const pngBase64 = extractB64(data);
  if (pngBase64 === null) return { ok: false, error: "Image server response had no `data[0].b64_json` field." };
  return { ok: true, pngBase64, width: request.width, height: request.height, seed: request.seed };
}

/** Tool output: where the image landed and what was asked, one line each.
 * The model needs the path to reference the file; nothing else. */
export function formatImageResult(outcome: ImageGenOutcome, savedPath: string | null, elapsedMs: number): string {
  if (!outcome.ok) return `Image generation failed: ${outcome.error}`;
  const secs = (elapsedMs / 1000).toFixed(1);
  const seed = outcome.seed !== undefined ? ` seed ${outcome.seed}` : "";
  return `Saved ${savedPath ?? "(unsaved)"} (${outcome.width}x${outcome.height},${seed} ${secs}s).`;
}
