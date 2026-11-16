/**
 * Integration tests for the prefill-progress extension wiring: turn_start
 * opens the log stream of the turn's model (llama-swap models only), progress
 * lines update the working message, generation start and turn/agent end restore
 * it, and a model switch between turns follows the new model.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import prefillProgressExtension from "../extensions/prefill-progress.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
  handlers = new Map<string, Handler[]>();
  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  async emit(event: string, payload: unknown, ctx: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
}

/** A ReadableStream whose byte chunks are pushed from the test (a real fetch
 * body yields Uint8Array, not strings). */
function makeLogStream() {
  const encoder = new TextEncoder();
  const pending: Uint8Array[] = [];
  let waitResolve: (() => void) | null = null;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (pending.length > 0) {
          controller.enqueue(pending.shift()!);
          return;
        }
        if (closed) {
          controller.close();
          return;
        }
        await new Promise<void>((resolve) => {
          waitResolve = resolve;
        });
      }
    },
  });
  return {
    body,
    push: (s: string) => {
      pending.push(encoder.encode(s));
      waitResolve?.();
      waitResolve = null;
    },
    close: () => {
      closed = true;
      waitResolve?.();
      waitResolve = null;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("turn_start tails the llama-swap log stream and sets Working NN%", async () => {
  const pi = new FakePi() as unknown as Parameters<typeof prefillProgressExtension>[0];
  prefillProgressExtension(pi);

  const stream = makeLogStream();
  let fetchUrl = "";
  let signal: AbortSignal | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { signal?: AbortSignal }) => {
    fetchUrl = url;
    signal = init?.signal;
    return { ok: true, body: stream.body };
  }) as typeof fetch;

  const workingMessages: (string | undefined)[] = [];
  const ctx = {
    model: { provider: "llama-swap", id: "qwen3-8-27b-pi-q6" },
    hasUI: true,
    ui: { setWorkingMessage: (m?: string) => workingMessages.push(m) },
  };

  try {
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
    await tick(); // let the reader start pulling
    assert.match(fetchUrl, /\/logs\/stream\/qwen3-8-27b-pi-q6\?no-history$/);

    stream.push(
      "2.03.052.495 I slot print_timing: id  0 | task 267 | prompt processing, n_tokens =   2048, progress = 0.42, t =   4.55 s / 450.26 tokens per second\n",
    );
    await tick();
    assert.deepEqual(workingMessages, ["Working 42%"]);

    // First content block: percentage restored to default.
    await pi.emit(
      "message_update",
      { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
      ctx,
    );
    assert.deepEqual(workingMessages, ["Working 42%", undefined]);

    // agent_end aborts the stream.
    await pi.emit("agent_end", { type: "agent_end" }, ctx);
    assert.equal(signal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    stream.close();
  }
});

test("turn_start ignores non-llama-swap models and headless modes", async () => {
  const pi = new FakePi() as unknown as Parameters<typeof prefillProgressExtension>[0];
  prefillProgressExtension(pi);

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return { ok: true, body: null };
  }) as typeof fetch;

  try {
    await pi.emit("turn_start", {}, {
      model: { provider: "openrouter", id: "some-model" },
      hasUI: true,
      ui: { setWorkingMessage: () => {} },
    });
    await pi.emit("turn_start", {}, {
      model: { provider: "llama-swap", id: "qwen3-8-27b-pi-q6" },
      hasUI: false,
      ui: { setWorkingMessage: () => {} },
    });
    await pi.emit("turn_start", {}, { model: undefined, hasUI: true, ui: {} });
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("each turn tails the current model, so a mid-run model switch or reload is followed", async () => {
  const pi = new FakePi() as unknown as Parameters<typeof prefillProgressExtension>[0];
  prefillProgressExtension(pi);

  const urls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const streams: ReturnType<typeof makeLogStream>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { signal?: AbortSignal }) => {
    urls.push(url);
    signals.push(init?.signal);
    const s = makeLogStream();
    streams.push(s);
    return { ok: true, body: s.body };
  }) as typeof fetch;

  const workingMessages: (string | undefined)[] = [];
  const ctx = {
    model: { provider: "llama-swap", id: "nanbeige4.3-33b-q4" },
    hasUI: true,
    ui: { setWorkingMessage: (m?: string) => workingMessages.push(m) },
  };

  try {
    await pi.emit("agent_start", { type: "agent_start" }, ctx);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
    await tick();
    await pi.emit("turn_end", { type: "turn_end" }, ctx);
    assert.equal(signals[0]?.aborted, true);

    ctx.model = { provider: "llama-swap", id: "nemotron-3-5-bolt-q4-p1" };
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 }, ctx);
    await tick();
    assert.equal(urls.length, 2);
    assert.match(urls[1]!, /\/logs\/stream\/nemotron-3-5-bolt-q4-p1\?no-history$/);

    streams[1]!.push(
      "2.24.810.505 I slot print_timing: id  0 | task 0 | prompt processing, n_tokens =  36278, progress = 0.88, t =  77.53 s / 467.95 tokens per second\n",
    );
    await tick();
    assert.deepEqual(workingMessages, ["Working 88%"]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const s of streams) s.close();
  }
});
