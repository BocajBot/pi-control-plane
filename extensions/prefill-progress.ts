/**
 * prefill-progress: show "Working NN%" in pi's working indicator while a
 * llama-swap model prefills a long prompt.
 *
 * On turn_start (one LLM call; for a llama-swap model) it tails the turn's
 * model's upstream log stream (GET /logs/stream/<model>?no-history) and parses llama.cpp's
 * "prompt processing ... progress = X.XX" lines — one per ~3s, only while the
 * prefill exceeds 3s. The latest value is rendered as a percentage appended to
 * the working message ("Working 42%"), so a long prefill is visible instead of
 * a static "Working". When generation starts (first content block) or the turn
 * ends, the default message is restored. Per turn, not per agent run: a model
 * switch mid-run (/model) or an unload/reload that closes the stream would
 * otherwise leave the rest of the run on a dead or wrong-model stream.
 *
 * Pure parsing lives in ../src/control-plane/prefill-progress.ts.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createPrefillProgressParser,
  formatWorkingMessage,
} from "../src/control-plane/prefill-progress.ts";

const SWAP_BASE = process.env.LLAMA_SWAP_URL ?? "http://127.0.0.1:9292";

export default function (pi: ExtensionAPI) {
  let abort: AbortController | null = null;
  // True while the working message carries a prefill % for the current LLM
  // call; cleared when generation starts or the turn ends.
  let percentShown = false;

  const stopStream = () => {
    abort?.abort();
    abort = null;
  };

  const restoreWorkingMessage = (ctx: ExtensionContext) => {
    if (!percentShown) return;
    percentShown = false;
    ctx.ui.setWorkingMessage();
  };

  pi.on("turn_start", (_event, ctx) => {
    stopStream();
    percentShown = false;

    const model = ctx.model;
    // Only llama-swap models have an upstream log stream to tail; skip the
    // rest (and headless modes, where there is no working indicator).
    if (!model || model.provider !== "llama-swap" || !ctx.hasUI) return;

    const ac = new AbortController();
    abort = ac;
    const parser = createPrefillProgressParser();

    void (async () => {
      try {
        const res = await fetch(
          `${SWAP_BASE}/logs/stream/${encodeURIComponent(model.id)}?no-history`,
          { signal: ac.signal },
        );
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const progress = parser.feed(decoder.decode(value, { stream: true }));
          if (progress !== null) {
            ctx.ui.setWorkingMessage(formatWorkingMessage(progress));
            percentShown = true;
          }
        }
      } catch {
        // Aborted (turn ended / new turn) or llama-swap unreachable — nothing
        // to do; the working indicator keeps its default message.
      } finally {
        if (abort === ac) abort = null;
      }
    })();
  });

  // First content block (thinking, text, or tool call) means prefill is done:
  // drop the stale percentage for the rest of the generation.
  pi.on("message_update", (event, ctx) => {
    if (!percentShown) return;
    const msg = event.message;
    if (msg.role === "assistant" && msg.content.length > 0) {
      restoreWorkingMessage(ctx);
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    stopStream();
    restoreWorkingMessage(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    stopStream();
    restoreWorkingMessage(ctx);
  });
}
