#!/usr/bin/env node
/**
 * Voicemail transcription CLI.
 *
 * Prints the transcript to stdout and nothing else, so it can be wired
 * straight into Hermes as an `stt.providers.<name>: type: command`
 * provider (that runner takes stdout as the transcript when the command
 * writes no output file).
 *
 * All transcription logic - including the phone-number pass - lives in
 * ../src/control-plane/transcription.ts, shared with the Pi tool. This file
 * is argument parsing, file IO and process exit codes only.
 *
 *   transcribe-voicemail <audio-file> [--language en] [--model NAME]
 *                        [--base-url URL] [--output FILE] [--timeout SEC]
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_TRANSCRIPTION_BASE_URL,
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  DEFAULT_TRANSCRIPTION_MODEL,
  KNOWN_AUDIO_EXTENSIONS,
  type PostAudio,
  type TranscriptionRequest,
  transcribeAudio,
} from "../src/control-plane/transcription.ts";

/** Whisper measures 0.03-0.04x realtime on real 8kHz voicemails on the GPU,
 * so this default is a very generous ceiling: it covers a llama-swap cold
 * start that may first evict a 23 GiB chat model, not the typical case. */
const DEFAULT_TIMEOUT_SECONDS = 900;

const USAGE = `usage: transcribe-voicemail <audio-file> [options]

  --language CODE   spoken-language hint, or "auto" (default: ${DEFAULT_TRANSCRIPTION_LANGUAGE})
  --model NAME      llama-swap model id (default: ${DEFAULT_TRANSCRIPTION_MODEL})
  --base-url URL    OpenAI-compatible base (default: ${DEFAULT_TRANSCRIPTION_BASE_URL})
  --output FILE     also write the transcript to FILE
  --timeout SEC     request ceiling in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const options = {
    file: "",
    language: process.env.PI_TRANSCRIBE_LANGUAGE || DEFAULT_TRANSCRIPTION_LANGUAGE,
    model: process.env.PI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIPTION_MODEL,
    baseUrl: process.env.PI_TRANSCRIBE_BASE_URL || DEFAULT_TRANSCRIPTION_BASE_URL,
    output: "",
    timeoutSeconds: Number(process.env.PI_TRANSCRIBE_TIMEOUT || DEFAULT_TIMEOUT_SECONDS),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      if (options.file.length > 0) fail(`Unexpected extra argument: ${arg}\n\n${USAGE}`);
      options.file = arg;
      continue;
    }
    // Hermes renders {model}/{language} as empty strings when unset; treat an
    // empty value as "not supplied" rather than overriding the default.
    const value = argv[i + 1] ?? "";
    i += 1;
    switch (arg) {
      case "--language":
        if (value) options.language = value;
        break;
      case "--model":
        if (value) options.model = value;
        break;
      case "--base-url":
        if (value) options.baseUrl = value;
        break;
      case "--output":
        options.output = value;
        break;
      case "--timeout":
        if (value) options.timeoutSeconds = Number(value);
        break;
      default:
        fail(`Unknown option: ${arg}\n\n${USAGE}`);
    }
  }

  if (options.file.length === 0) fail(USAGE);
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    fail(`--timeout must be a positive number of seconds.`);
  }
  return options;
}

/** Real transport. FormData/Blob live here rather than in the shared module
 * so that module stays testable without them. */
let requestTimeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000;

const postAudio: PostAudio = async (url, request) => {
  const form = new FormData();
  form.append("file", new Blob([request.bytes]), request.filename);
  form.append("model", request.model);
  form.append("response_format", "json");
  // Greedy is whisper.cpp's default; temperature 0 keeps repeated runs of the
  // same voicemail identical, which matters when a transcript is re-checked.
  form.append("temperature", "0");
  // Always sent, including the literal "auto": whisper-server is launched
  // with `-l en`, so omitting the field would silently mean English rather
  // than detection.
  form.append("language", request.language);
  const res = await fetch(url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const resolved = path.resolve(options.file);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail(`Audio file not found: ${resolved}`);
  }
  if (!stat.isFile()) fail(`Not a file: ${resolved}`);

  const extension = path.extname(resolved).slice(1).toLowerCase();
  if (extension.length > 0 && !KNOWN_AUDIO_EXTENSIONS.includes(extension)) {
    // Advisory: whisper-server decodes through ffmpeg, which may well handle
    // this container anyway. Warn on stderr and try it.
    process.stderr.write(
      `warning: .${extension} is not a container this tool has been checked against; attempting it anyway\n`,
    );
  }

  const request: TranscriptionRequest = {
    filename: path.basename(resolved),
    bytes: fs.readFileSync(resolved),
    language: options.language,
    model: options.model,
  };

  requestTimeoutMs = Math.round(options.timeoutSeconds * 1000);
  const outcome = await transcribeAudio(options.baseUrl, request, postAudio);
  if (!outcome.ok) fail(`Transcription failed: ${outcome.error}`);

  if (options.output.length > 0) {
    fs.writeFileSync(options.output, `${outcome.text}\n`, "utf8");
  }
  process.stdout.write(`${outcome.text}\n`);
}

main().catch((error: unknown) => {
  fail(`Transcription failed: ${String(error)}`);
});
