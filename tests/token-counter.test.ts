import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countPayloadTokens,
  detectPayloadFormat,
  type JsonFetch,
  providerOrigin,
} from "../src/control-plane/token-counter.ts";

test("detectPayloadFormat", () => {
  assert.equal(
    detectPayloadFormat({ system: "s", messages: [{ role: "user", content: "hi" }] }),
    "anthropic",
  );
  assert.equal(
    detectPayloadFormat({ messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] }),
    "openai",
  );
  assert.equal(
    detectPayloadFormat({ system: "s", messages: [{ role: "system", content: "x" }] }),
    "openai",
    "a system-role message means OpenAI shape even when a system key exists",
  );
  assert.equal(detectPayloadFormat(null), "unknown");
  assert.equal(detectPayloadFormat({ prompt: "raw" }), "unknown");
});

test("providerOrigin strips the path", () => {
  assert.equal(providerOrigin("http://localhost:9292/v1"), "http://localhost:9292");
  assert.equal(providerOrigin("not a url"), null);
});

const fakeFetch = (routes: Record<string, unknown>): { calls: string[]; fetch: JsonFetch } => {
  const calls: string[] = [];
  const fetch: JsonFetch = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const body = routes[path];
    return { ok: body !== undefined, json: async () => body };
  };
  return { calls, fetch };
};

test("anthropic payloads go to /v1/messages/count_tokens", async () => {
  const { calls, fetch } = fakeFetch({ "/v1/messages/count_tokens": { input_tokens: 18 } });
  const result = await countPayloadTokens(
    "http://localhost:9292/v1",
    "devstral",
    { system: "s", messages: [{ role: "user", content: "hi" }] },
    fetch,
  );
  assert.equal(result?.tokens, 18);
  assert.equal(result?.source, "llama-swap-count-tokens");
  assert.equal(result?.exact, true);
  assert.deepEqual(calls, ["http://localhost:9292/v1/messages/count_tokens"]);
});

test("openai payloads go through apply-template then tokenize", async () => {
  const { calls, fetch } = fakeFetch({
    "/upstream/devstral/apply-template": { prompt: "[INST]hi[/INST]" },
    "/upstream/devstral/tokenize": { tokens: [1, 2, 3, 4, 5] },
  });
  const result = await countPayloadTokens(
    "http://localhost:9292/v1",
    "devstral",
    { messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] },
    fetch,
  );
  assert.equal(result?.tokens, 5);
  assert.equal(result?.source, "llama-server-tokenize");
  assert.equal(calls.length, 2);
});

test("failures return null, never throw", async () => {
  const { fetch } = fakeFetch({});
  const openai = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(await countPayloadTokens("http://localhost:9292/v1", "m", openai, fetch), null);
  assert.equal(await countPayloadTokens("bad url", "m", openai, fetch), null);
  assert.equal(await countPayloadTokens("http://localhost:9292/v1", "", openai, fetch), null);
  assert.equal(await countPayloadTokens("http://localhost:9292/v1", "m", { prompt: "x" }, fetch), null);
  const throwing: JsonFetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await countPayloadTokens("http://localhost:9292/v1", "m", openai, throwing), null);
});

test("bad response shapes return null", async () => {
  const badCount = fakeFetch({ "/v1/messages/count_tokens": { nope: 1 } });
  assert.equal(
    await countPayloadTokens("http://x:1/v1", "m", { system: "s", messages: [] }, badCount.fetch),
    null,
  );
  const badTokenize = fakeFetch({
    "/upstream/m/apply-template": { prompt: "p" },
    "/upstream/m/tokenize": { tokens: "not an array" },
  });
  assert.equal(
    await countPayloadTokens("http://x:1/v1", "m", { messages: [] }, badTokenize.fetch),
    null,
  );
});
