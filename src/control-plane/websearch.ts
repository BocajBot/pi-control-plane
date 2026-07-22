/**
 * Web search against the user's local searxng instance (port 8888 by
 * default) - explicitly NOT a paid API, per the deferred-milestone note in
 * docs/ARCHITECTURE.md. Pure module apart from the injected fetch: no Pi
 * imports, no globals, same shape as token-counter.ts.
 *
 * searxng is treated as a local, already-trusted service (same box, no
 * auth) - results are NOT redacted the way system-prompt/context output is
 * elsewhere in this codebase, because they are public web content the model
 * requested, not local secrets. If searxng ever proxies to a service which
 * could return a source's own credentials-looking text (unlikely for a
 * search engine, but noted for completeness), that is content the model
 * would see either way once fetched, not something this tool introduces.
 */

export interface SearxngResult {
  title: string;
  url: string;
  /** searxng's short snippet/summary; never the full page content. */
  content: string;
  engine: string;
}

export type SearchOutcome =
  | { ok: true; query: string; results: SearxngResult[] }
  | { ok: false; error: string };

export type GetFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const DEFAULT_SEARXNG_BASE_URL = "http://127.0.0.1:8888";
export const MAX_RESULTS = 10;

/** searxng's JSON API has no per-request result-count parameter; the count
 * cap is applied client-side in parseResults() after the response arrives. */
export function buildSearxngUrl(baseUrl: string, query: string): string | null {
  if (query.trim().length === 0) return null;
  let origin: string;
  try {
    origin = new URL(baseUrl).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
  const params = new URLSearchParams({ q: query, format: "json" });
  return `${origin}/search?${params.toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResults(data: unknown, cap: number): SearxngResult[] {
  if (!isRecord(data) || !Array.isArray(data.results)) return [];
  const out: SearxngResult[] = [];
  for (const raw of data.results) {
    if (!isRecord(raw)) continue;
    const title = typeof raw.title === "string" ? raw.title : "";
    const url = typeof raw.url === "string" ? raw.url : "";
    if (url.length === 0) continue; // a result with no URL is not actionable
    const content = typeof raw.content === "string" ? raw.content : "";
    const engine = typeof raw.engine === "string" ? raw.engine : "unknown";
    out.push({ title, url, content, engine });
    if (out.length >= cap) break;
  }
  return out;
}

export async function searchSearxng(
  baseUrl: string,
  query: string,
  fetchGet: GetFetch,
  numResults: number = MAX_RESULTS,
): Promise<SearchOutcome> {
  const cap = Math.max(1, Math.min(MAX_RESULTS, numResults));
  const url = buildSearxngUrl(baseUrl, query);
  if (url === null) {
    return { ok: false, error: "Empty query, or the configured searxng URL is malformed." };
  }
  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await fetchGet(url);
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach searxng at ${baseUrl}: ${String(error)}. Is the local searxng container running?`,
    };
  }
  if (!res.ok) {
    return { ok: false, error: `searxng returned HTTP ${res.status} for this query.` };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (error) {
    return { ok: false, error: `searxng response was not valid JSON: ${String(error)}` };
  }
  return { ok: true, query, results: parseResults(data, cap) };
}

/** Format results as the tool's text output (what the model sees). Pure,
 * testable without a live searxng instance. */
export function formatSearchResults(outcome: SearchOutcome): string {
  if (!outcome.ok) return `Web search failed: ${outcome.error}`;
  if (outcome.results.length === 0) {
    return `No results for "${outcome.query}".`;
  }
  const lines = [`Search results for "${outcome.query}" (${outcome.results.length}):`, ""];
  outcome.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title || "(untitled)"}`);
    lines.push(`   ${r.url}`);
    if (r.content.trim().length > 0) lines.push(`   ${r.content}`);
    lines.push(`   [via ${r.engine}]`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}
