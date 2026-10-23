/**
 * Prefill progress: parse llama.cpp's prompt-processing progress lines from a
 * llama-swap upstream log stream and render them into pi's working message.
 *
 * While a long prompt is being prefilled, llama-server logs one line per ~3s
 * (only once the prefill exceeds 3s):
 *
 *   ... I slot print_timing: id  0 | task 267 | prompt processing, n_tokens =   2048, progress = 0.02, t =   4.55 s / 450.26 tokens per second
 *
 * The `progress` value is a decimal in [0, 1]. Pure: no Pi imports, no
 * network — the wiring (log stream tailing, setWorkingMessage) lives in
 * extensions/prefill-progress.ts.
 */

// Anchor on "prompt processing" so unrelated "progress = ..." lines (e.g. from
// other tools' logs) are ignored. The value is a decimal like 0.02 / 1.00.
const PROGRESS_RE = /prompt processing[^\n]*?progress = (\d+(?:\.\d+)?)/;

export interface PrefillProgressParser {
  /**
   * Feed one chunk of log text. Returns the latest progress (0..1) seen in
   * this chunk, or null when the chunk contained no progress line. Handles
   * lines split across chunk boundaries.
   */
  feed(chunk: string): number | null;
  /** Drop buffered state (e.g. when a new stream is opened). */
  reset(): void;
}

export function createPrefillProgressParser(): PrefillProgressParser {
  let tail = "";
  return {
    feed(chunk: string): number | null {
      const text = tail + chunk;
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) {
        // No complete line yet — buffer everything.
        tail = text;
        return null;
      }
      tail = text.slice(lastNl + 1);

      let latest: number | null = null;
      for (const line of text.slice(0, lastNl).split("\n")) {
        const m = PROGRESS_RE.exec(line);
        if (!m) continue;
        const v = Number.parseFloat(m[1]!);
        if (Number.isFinite(v)) latest = Math.min(1, Math.max(0, v));
      }
      return latest;
    },
    reset(): void {
      tail = "";
    },
  };
}

/** "Working 42%" — the working indicator text with prefill progress appended. */
export function formatWorkingMessage(progress: number): string {
  return `Working ${Math.round(progress * 100)}%`;
}
