import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSearxngUrl,
  DEFAULT_SEARXNG_BASE_URL,
  formatSearchResults,
  type GetFetch,
  MAX_RESULTS,
  searchSearxng,
  type SearxngResult,
} from "../src/control-plane/websearch.ts";

test("buildSearxngUrl: builds a JSON-format search URL, rejects empty query and malformed base", () => {
  const url = buildSearxngUrl(DEFAULT_SEARXNG_BASE_URL, "llama.cpp speculative decoding");
  assert.notEqual(url, null);
  assert.ok(url!.startsWith("http://127.0.0.1:8888/search?"));
  assert.ok(url!.includes("format=json"));
  assert.ok(url!.includes("q=llama.cpp"));
  assert.equal(buildSearxngUrl(DEFAULT_SEARXNG_BASE_URL, ""), null);
  assert.equal(buildSearxngUrl(DEFAULT_SEARXNG_BASE_URL, "   "), null);
  assert.equal(buildSearxngUrl("not a url", "x"), null);
});

function fakeFetch(response: { ok: boolean; status: number; body: unknown }): GetFetch {
  return async () => ({ ok: response.ok, status: response.status, json: async () => response.body });
}

test("searchSearxng: happy path parses title/url/content/engine, caps at MAX_RESULTS", async () => {
  const manyResults = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => ({
    title: `Result ${i}`,
    url: `https://example.com/${i}`,
    content: `snippet ${i}`,
    engine: "duckduckgo",
  }));
  const fetchGet = fakeFetch({ ok: true, status: 200, body: { query: "x", results: manyResults } });
  const outcome = await searchSearxng(DEFAULT_SEARXNG_BASE_URL, "x", fetchGet);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.results.length, MAX_RESULTS);
  assert.equal(outcome.results[0].title, "Result 0");
  assert.equal(outcome.results[0].engine, "duckduckgo");
});

test("searchSearxng: results missing a URL are dropped as not actionable", async () => {
  const fetchGet = fakeFetch({
    ok: true,
    status: 200,
    body: { results: [{ title: "no url here", content: "c", engine: "e" }, { title: "has url", url: "https://x.test", content: "c", engine: "e" }] },
  });
  const outcome = await searchSearxng(DEFAULT_SEARXNG_BASE_URL, "x", fetchGet);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].url, "https://x.test");
});

test("searchSearxng: empty query fails without attempting a fetch", async () => {
  let called = false;
  const fetchGet: GetFetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const outcome = await searchSearxng(DEFAULT_SEARXNG_BASE_URL, "  ", fetchGet);
  assert.equal(outcome.ok, false);
  assert.equal(called, false);
});

test("searchSearxng: non-2xx response reported, not thrown", async () => {
  const fetchGet = fakeFetch({ ok: false, status: 503, body: {} });
  const outcome = await searchSearxng(DEFAULT_SEARXNG_BASE_URL, "x", fetchGet);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /503/);
});

test("searchSearxng: network failure (fetch throws) is caught and reported, not thrown", async () => {
  const fetchGet: GetFetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const outcome = await searchSearxng(DEFAULT_SEARXNG_BASE_URL, "x", fetchGet);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /ECONNREFUSED/);
  assert.match(outcome.error, /searxng container running/i);
});

test("searchSearxng: malformed JSON body is caught and reported, not thrown", async () => {
  const fetchGet: GetFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  });
  const outcome = await searchSearxng(DEFAULT_SEARXNG_BASE_URL, "x", fetchGet);
  assert.equal(outcome.ok, false);
});

test("searchSearxng: response missing a results array yields zero results, not a crash", async () => {
  const fetchGet = fakeFetch({ ok: true, status: 200, body: { query: "x" } });
  const outcome = await searchSearxng(DEFAULT_SEARXNG_BASE_URL, "x", fetchGet);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.results.length, 0);
});

test("formatSearchResults: error outcome, empty results, and populated results all render distinctly", () => {
  assert.match(formatSearchResults({ ok: false, error: "boom" }), /Web search failed: boom/);
  assert.match(formatSearchResults({ ok: true, query: "q", results: [] }), /No results for "q"/);
  const results: SearxngResult[] = [{ title: "T", url: "https://x.test", content: "C", engine: "E" }];
  const rendered = formatSearchResults({ ok: true, query: "q", results });
  assert.ok(rendered.includes("T"));
  assert.ok(rendered.includes("https://x.test"));
  assert.ok(rendered.includes("C"));
  assert.ok(rendered.includes("[via E]"));
});
