/**
 * Voicemail transcription against the local whisper.cpp server exposed by
 * llama-swap as the `whisper-voicemail` model. Pure module apart from the
 * injected POST: no Pi imports, no fs, no globals - same shape as
 * websearch.ts, so the phone-number pass is unit-testable without a server.
 *
 * Three layers defend the "phone numbers must be digits, not words"
 * requirement, weakest to strongest:
 *   1. whisper-server runs with an initial --prompt whose example callback
 *      numbers are digit-formatted (biases the decoder's output style).
 *   2. large-v3-turbo already emits digits unprompted for clean speech
 *      (measured: 3/3 identical runs on the phone-band fixture).
 *   3. normalizeSpokenDigits() below - deterministic, and the only layer
 *      that is a guarantee rather than a tendency. It is the single owner
 *      of this contract: both the Pi tool and the Hermes command provider
 *      reach it through this module, so there is no second implementation
 *      to drift.
 *
 * Audio decoding is NOT done here. whisper-server is started with
 * `--convert`, so it hands any container ffmpeg understands (wav, mp3,
 * mp4, m4a, ogg...) off to ffmpeg itself. Callers upload the original
 * bytes untouched.
 */

export const DEFAULT_TRANSCRIPTION_BASE_URL = "http://127.0.0.1:9292/v1";
export const DEFAULT_TRANSCRIPTION_MODEL = "whisper-voicemail";
export const DEFAULT_TRANSCRIPTION_LANGUAGE = "en";

/** Containers whisper-server can reach through its ffmpeg `--convert` path.
 * Advisory only - used for a clearer error before uploading, never to
 * reject a file the server might actually handle. */
export const KNOWN_AUDIO_EXTENSIONS = [
  "wav", "mp3", "mp4", "m4a", "aac", "flac", "ogg", "oga", "opus",
  "webm", "mkv", "mov", "amr", "wma", "aiff", "aif", "3gp", "caf",
];

export interface TranscriptionRequest {
  filename: string;
  bytes: Uint8Array;
  /** BCP-47-ish hint passed to whisper ("en"); "auto" lets it detect. */
  language: string;
  model: string;
}

/** Injected transport. Building FormData/Blob is left to the wiring layer
 * (extension or CLI) so this module needs no DOM globals to be tested. */
export type PostAudio = (
  url: string,
  request: TranscriptionRequest,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type TranscribeOutcome =
  | { ok: true; filename: string; text: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Phone-number normalisation
// ---------------------------------------------------------------------------

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", nought: "0", naught: "0",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
};

/** "double five" -> 55, "triple seven" -> 777. Common when a caller reads a
 * number back slowly, which is exactly when whisper is most likely to spell
 * it out as words. */
const REPEAT_WORDS: Record<string, number> = { double: 2, triple: 3, treble: 3 };

/** Only these total lengths are collapsed. Deliberately narrow: a run of
 * spoken digit words that is NOT a US phone shape is far more likely to be
 * prose ("one, two, three - let's go") than a callback number, and a false
 * rewrite corrupts the transcript in a way the reader cannot detect. Runs
 * that miss these shapes are left exactly as whisper produced them.
 * Known limitation: international numbers outside these lengths are not
 * reformatted (they are still whatever whisper emitted, usually digits). */
function formatPhoneDigits(digits: string): string | null {
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return null;
}

/** Whitespace and the punctuation a reader uses *inside* a dictated number.
 * A period is excluded on purpose - "...nine. Two hours later" would
 * otherwise weld two sentences into one run. */
const RUN_SEPARATOR = /^[\s,\-–—()]+$/;

type Token = { text: string; kind: "word" | "number" | "other" };

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const pattern = /[A-Za-z']+|\d+|[^A-Za-z'\d]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    const kind = /^[A-Za-z']/.test(raw) ? "word" : /^\d/.test(raw) ? "number" : "other";
    out.push({ text: raw, kind });
  }
  return out;
}

/**
 * Collapse contiguous runs of *spoken* digit words into digits, but only
 * when the run lands on a US phone-number shape (7, 10, or 1+10).
 *
 * Rules that keep this from eating prose:
 *   - a run must START with a spelled-out digit word, never with a numeral,
 *     so "in 2024 we..." cannot seed one;
 *   - an already-numeric token joins a run only once a spelled-out digit has
 *     opened it, and only if it is at most 4 digits long - that is what lets
 *     "eight one two, 555, 0199" become one 10-digit number;
 *   - "hundred" after an open run contributes "00" (for "one eight hundred");
 *   - runs that do not reach a phone shape are emitted verbatim.
 */
export function normalizeSpokenDigits(text: string): string {
  const tokens = tokenize(text);
  const out: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const lower = token.kind === "word" ? token.text.toLowerCase() : "";
    // "triple five..." must open a run too, or a read-back number that starts
    // with a repeat word is never seen.
    const opensRun = token.kind === "word" && (lower in DIGIT_WORDS || lower in REPEAT_WORDS);
    if (!opensRun) {
      out.push(token.text);
      i += 1;
      continue;
    }

    // A run is open. Walk forward collecting digits until something that is
    // neither a digit source nor an in-number separator turns up.
    let digits = "";
    let end = i; // exclusive index of the last token that contributed digits
    let cursor = i;
    let pendingRepeat = 1;

    while (cursor < tokens.length) {
      const current = tokens[cursor];
      if (current.kind === "other") {
        if (!RUN_SEPARATOR.test(current.text)) break;
        cursor += 1;
        continue;
      }
      if (current.kind === "number") {
        if (digits.length === 0 || current.text.length > 4) break;
        digits += current.text;
        cursor += 1;
        end = cursor;
        continue;
      }
      const word = current.text.toLowerCase();
      if (word in REPEAT_WORDS) {
        pendingRepeat = REPEAT_WORDS[word];
        cursor += 1;
        continue;
      }
      if (word in DIGIT_WORDS) {
        digits += DIGIT_WORDS[word].repeat(pendingRepeat);
        pendingRepeat = 1;
        cursor += 1;
        end = cursor;
        continue;
      }
      if (word === "hundred" && digits.length > 0) {
        digits += "00";
        cursor += 1;
        end = cursor;
        continue;
      }
      break;
    }

    const formatted = formatPhoneDigits(digits);
    const runEnd = Math.max(end, i + 1);
    if (formatted === null) {
      // Not a phone shape - emit the whole run verbatim and resume *after*
      // it. Resuming one token in instead would let an 8-digit run be
      // re-scanned from its second word and match the 7-digit shape, which
      // is a false rewrite of text that was never a phone number.
      for (let k = i; k < runEnd; k += 1) out.push(tokens[k].text);
      i = runEnd;
      continue;
    }
    out.push(formatted);
    i = runEnd;
  }

  return out.join("");
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function buildTranscriptionUrl(baseUrl: string): string | null {
  let origin: string;
  try {
    origin = new URL(baseUrl).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
  return `${origin}/audio/transcriptions`;
}

function extractText(data: unknown): string | null {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const value = (data as Record<string, unknown>).text;
    if (typeof value === "string") return value;
  }
  return null;
}

/** Collapse whisper's per-segment line breaks into paragraph text. Segment
 * boundaries fall mid-sentence (they are 30s decode windows, not clause
 * boundaries), so keeping them would break a callback number across lines. */
export function tidyTranscript(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let out = "";
  for (const line of lines) {
    if (out.length === 0) {
      out = line;
      continue;
    }
    // A window boundary can land mid-number: whisper has been observed
    // emitting "555-123-" then "4567" on the next line. Joining those with a
    // space would break the very thing this module exists to protect, so a
    // trailing hyphen splices with no separator.
    if (out.endsWith("-")) {
      out += line;
      continue;
    }
    // Likewise a window can start with the punctuation that closed the
    // previous sentence; " ." would be wrong.
    if (/^[.,;:!?)\]]/.test(line)) {
      out += line;
      continue;
    }
    out += ` ${line}`;
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

export async function transcribeAudio(
  baseUrl: string,
  request: TranscriptionRequest,
  postAudio: PostAudio,
): Promise<TranscribeOutcome> {
  const url = buildTranscriptionUrl(baseUrl);
  if (url === null) {
    return { ok: false, error: `Malformed transcription base URL: ${baseUrl}` };
  }
  if (request.bytes.length === 0) {
    return { ok: false, error: `${request.filename} is empty - nothing to transcribe.` };
  }

  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await postAudio(url, request);
  } catch (error) {
    return {
      ok: false,
      error:
        `Could not reach the transcription server at ${baseUrl}: ${String(error)}. ` +
        `Is llama-swap running, and is the "${request.model}" model defined in its config?`,
    };
  }
  if (!res.ok) {
    return { ok: false, error: `Transcription server returned HTTP ${res.status}.` };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (error) {
    return { ok: false, error: `Transcription response was not valid JSON: ${String(error)}` };
  }

  const raw = extractText(data);
  if (raw === null) {
    return { ok: false, error: "Transcription response had no `text` field." };
  }

  const text = normalizeSpokenDigits(tidyTranscript(raw));
  if (text.length === 0) {
    return {
      ok: false,
      error: `No speech was detected in ${request.filename}.`,
    };
  }
  return { ok: true, filename: request.filename, text };
}

/** Tool output: the transcript as plain text, nothing else. The caller asked
 * for a transcription, not a report about one. */
export function formatTranscript(outcome: TranscribeOutcome): string {
  if (!outcome.ok) return `Transcription failed: ${outcome.error}`;
  return outcome.text;
}
