/**
 * Exact token counting through llama-swap's model-aware endpoints:
 *
 * - Anthropic-shaped payloads -> POST <origin>/v1/messages/count_tokens
 *   (llama-server counts with the loaded model's tokenizer).
 * - OpenAI chat-completions payloads -> POST <origin>/upstream/<model>/apply-template
 *   to render the chat template, then <origin>/upstream/<model>/tokenize.
 *
 * Pure module apart from the injected fetch: no Pi imports, no globals. Any
 * failure (network, non-2xx, unexpected shape) returns null — callers fall
 * back to estimates and must label them as such.
 */

export interface TokenCountResult {
  tokens: number;
  model: string;
  source: "llama-swap-count-tokens" | "llama-server-tokenize";
  /** Counts from these endpoints use the model's own tokenizer. */
  exact: true;
  countedAt: string;
}

export type JsonFetch = (
  url: string,
  body: unknown,
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function detectPayloadFormat(payload: unknown): "anthropic" | "openai" | "unknown" {
  if (payload === null || typeof payload !== "object") return "unknown";
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.messages)) return "unknown";
  const hasSystemRole = body.messages.some(
    (m) => typeof m === "object" && m !== null && (m as Record<string, unknown>).role === "system",
  );
  if ("system" in body && !hasSystemRole) return "anthropic";
  return "openai";
}

/** Origin of a provider baseUrl like "http://localhost:9292/v1". Null if unparseable. */
export function providerOrigin(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Serialize one agent message for prospective counting: text blocks verbatim,
 * non-text blocks (tool calls, tool results, images) as their JSON — an
 * approximation of the provider wire format, close enough that the model's
 * tokenizer count lands within a few tokens of the real request.
 */
export function serializeForCounting(message: { role?: string; content?: unknown }): {
  role: string;
  content: string;
} {
  const role = message.role === "toolResult" ? "user" : (message.role ?? "user");
  let content: string;
  if (typeof message.content === "string") {
    content = message.content;
  } else if (Array.isArray(message.content)) {
    content = (message.content as Array<{ type?: string; text?: string }>)
      .map((block) =>
        block?.type === "text" && typeof block.text === "string" ? block.text : JSON.stringify(block),
      )
      .join("\n");
  } else {
    content = "";
  }
  return { role, content };
}

export async function countPayloadTokens(
  baseUrl: string,
  model: string,
  payload: unknown,
  fetchJson: JsonFetch,
): Promise<TokenCountResult | null> {
  const origin = providerOrigin(baseUrl);
  if (origin === null || model.length === 0) return null;
  const format = detectPayloadFormat(payload);
  const countedAt = new Date().toISOString();
  try {
    if (format === "anthropic") {
      const body = { ...(payload as Record<string, unknown>), model };
      const res = await fetchJson(`${origin}/v1/messages/count_tokens`, body);
      if (!res.ok) return null;
      const data = (await res.json()) as { input_tokens?: unknown };
      if (typeof data.input_tokens !== "number") return null;
      return { tokens: data.input_tokens, model, source: "llama-swap-count-tokens", exact: true, countedAt };
    }
    if (format === "openai") {
      const { messages, tools } = payload as { messages: unknown[]; tools?: unknown };
      const templateBody: Record<string, unknown> = { messages };
      // llama.cpp renders tool definitions into the chat template, so passing
      // them through makes the count include their real token cost.
      if (Array.isArray(tools)) templateBody.tools = tools;
      const templated = await fetchJson(
        `${origin}/upstream/${encodeURIComponent(model)}/apply-template`,
        templateBody,
      );
      if (!templated.ok) return null;
      const { prompt } = (await templated.json()) as { prompt?: unknown };
      if (typeof prompt !== "string") return null;
      const tokenized = await fetchJson(`${origin}/upstream/${encodeURIComponent(model)}/tokenize`, {
        content: prompt,
        add_special: false,
        parse_special: true,
      });
      if (!tokenized.ok) return null;
      const { tokens } = (await tokenized.json()) as { tokens?: unknown };
      if (!Array.isArray(tokens)) return null;
      return { tokens: tokens.length, model, source: "llama-server-tokenize", exact: true, countedAt };
    }
    return null;
  } catch {
    return null;
  }
}
