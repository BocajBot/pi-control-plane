import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildImageGenUrl,
  DEFAULT_IMAGEGEN_BASE_URL,
  formatImageResult,
  generateImage,
  type ImageGenRequest,
  MAX_REFERENCE_IMAGES,
  parseImageSize,
  type PostImageGen,
} from "../src/control-plane/imagegen.ts";

function request(overrides: Partial<ImageGenRequest> = {}): ImageGenRequest {
  return { prompt: "a red bicycle", width: 1024, height: 1024, model: "qwen-image", references: [], ...overrides };
}

const okPost = (b64 = "aGVsbG8="): PostImageGen => async () => ({ ok: true, status: 200, json: async () => ({ data: [{ b64_json: b64 }] }) });

test("parseImageSize: accepts multiples of 32 within range, rejects the rest", () => {
  assert.deepEqual(parseImageSize("1024x1024"), { width: 1024, height: 1024 });
  assert.deepEqual(parseImageSize(" 2048 X 1536 "), { width: 2048, height: 1536 });
  assert.equal(parseImageSize("1000x1000"), null, "not a multiple of 32");
  assert.equal(parseImageSize("128x128"), null, "below the minimum");
  assert.equal(parseImageSize("4096x1024"), null, "above the maximum");
  assert.equal(parseImageSize("1024"), null);
  assert.equal(parseImageSize("axb"), null);
});

test("buildImageGenUrl: generations vs edits, trailing slash tolerated, malformed base rejected", () => {
  assert.equal(buildImageGenUrl(DEFAULT_IMAGEGEN_BASE_URL, false), "http://127.0.0.1:9292/v1/images/generations");
  assert.equal(buildImageGenUrl("http://127.0.0.1:9292/v1/", true), "http://127.0.0.1:9292/v1/images/edits");
  assert.equal(buildImageGenUrl("not a url", false), null);
});

test("generateImage: text-to-image posts JSON with size, n=1 and b64_json", async () => {
  const seen: unknown[] = [];
  const post: PostImageGen = async (url, payload) => {
    seen.push(url, payload);
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "AAAA" }] }) };
  };
  const outcome = await generateImage(DEFAULT_IMAGEGEN_BASE_URL, request({ seed: 42 }), post);
  assert.deepEqual(outcome, { ok: true, pngBase64: "AAAA", width: 1024, height: 1024, seed: 42 });
  assert.equal(seen[0], "http://127.0.0.1:9292/v1/images/generations");
  assert.deepEqual(seen[1], {
    kind: "json",
    body: { model: "qwen-image", prompt: "a red bicycle", size: "1024x1024", n: 1, response_format: "b64_json", seed: 42 },
  });
});

test("generateImage: reference images switch to the multipart edits endpoint", async () => {
  const seen: unknown[] = [];
  const post: PostImageGen = async (url, payload) => {
    seen.push(url, payload);
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "BBBB" }] }) };
  };
  const ref = { filename: "ref.png", bytes: new Uint8Array([1, 2, 3]) };
  const outcome = await generateImage(DEFAULT_IMAGEGEN_BASE_URL, request({ references: [ref] }), post);
  assert.equal(outcome.ok, true);
  assert.equal(seen[0], "http://127.0.0.1:9292/v1/images/edits");
  const payload = seen[1] as { kind: string; fields: Record<string, string>; files: { field: string; filename: string }[] };
  assert.equal(payload.kind, "form");
  assert.equal(payload.fields.prompt, "a red bicycle");
  assert.equal(payload.fields.size, "1024x1024");
  assert.deepEqual(payload.files.map((f) => [f.field, f.filename]), [["image[]", "ref.png"]]);
});

test("generateImage: refuses empty prompt, empty reference, too many references without posting", async () => {
  let posted = 0;
  const post: PostImageGen = async () => {
    posted += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  assert.match(String((await generateImage(DEFAULT_IMAGEGEN_BASE_URL, request({ prompt: "  " }), post) as { error: string }).error), /Empty prompt/);
  const empty = { filename: "e.png", bytes: new Uint8Array() };
  assert.match(String((await generateImage(DEFAULT_IMAGEGEN_BASE_URL, request({ references: [empty] }), post) as { error: string }).error), /is empty/);
  const many = Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, i) => ({ filename: `r${i}.png`, bytes: new Uint8Array([1]) }));
  assert.match(String((await generateImage(DEFAULT_IMAGEGEN_BASE_URL, request({ references: many }), post) as { error: string }).error), /Too many reference images/);
  assert.equal(posted, 0);
});

test("generateImage: transport failure names llama-swap; non-2xx and bad bodies are reported", async () => {
  const down: PostImageGen = async () => {
    throw new Error("ECONNREFUSED");
  };
  const t = await generateImage(DEFAULT_IMAGEGEN_BASE_URL, request(), down);
  assert.equal(t.ok, false);
  assert.match((t as { error: string }).error, /Is llama-swap running.*"qwen-image"/);

  const s = await generateImage(DEFAULT_IMAGEGEN_BASE_URL, request(), async () => ({ ok: false, status: 503, json: async () => ({}) }));
  assert.match((s as { error: string }).error, /HTTP 503/);

  const j = await generateImage(DEFAULT_IMAGEGEN_BASE_URL, request(), async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } }));
  assert.match((j as { error: string }).error, /not valid JSON/);

  const n = await generateImage(DEFAULT_IMAGEGEN_BASE_URL, request(), async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
  assert.match((n as { error: string }).error, /b64_json/);

  const m = await generateImage("nope", request(), okPost());
  assert.match((m as { error: string }).error, /Malformed image server base URL/);
});

test("formatImageResult: path, size, seed and elapsed on success; failure prefix otherwise", () => {
  assert.equal(
    formatImageResult({ ok: true, pngBase64: "x", width: 1024, height: 768, seed: 7 }, "/tmp/a.png", 71_300),
    "Saved /tmp/a.png (1024x768, seed 7 71.3s).",
  );
  assert.equal(formatImageResult({ ok: false, error: "boom" }, null, 0), "Image generation failed: boom");
});
