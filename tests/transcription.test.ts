import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTranscriptionUrl,
  DEFAULT_TRANSCRIPTION_BASE_URL,
  DEFAULT_TRANSCRIPTION_MODEL,
  formatTranscript,
  normalizeSpokenDigits,
  type PostAudio,
  tidyTranscript,
  transcribeAudio,
  type TranscriptionRequest,
} from "../src/control-plane/transcription.ts";

// ---------------------------------------------------------------------------
// normalizeSpokenDigits - the phone-number guarantee
// ---------------------------------------------------------------------------

test("normalizeSpokenDigits: collapses a spelled-out 7-digit local number", () => {
  assert.equal(
    normalizeSpokenDigits("Call me at five five five, one two three four."),
    "Call me at 555-1234.",
  );
});

test("normalizeSpokenDigits: collapses a spelled-out 10-digit number", () => {
  assert.equal(
    normalizeSpokenDigits("reach me at eight one two five five five zero one nine nine"),
    "reach me at 812-555-0199",
  );
});

test("normalizeSpokenDigits: collapses 1+10 with a leading country digit", () => {
  assert.equal(
    normalizeSpokenDigits("dial one eight zero zero five five five zero one one zero"),
    "dial 1-800-555-0110",
  );
});

test("normalizeSpokenDigits: 'oh' and 'o' are zeros", () => {
  assert.equal(
    normalizeSpokenDigits("five five five oh one four two"),
    "555-0142",
  );
});

test("normalizeSpokenDigits: expands double/triple repeats", () => {
  assert.equal(
    normalizeSpokenDigits("eight one two, double five, five zero one nine nine"),
    "812-555-0199",
  );
  assert.equal(
    normalizeSpokenDigits("triple five one two three four"),
    "555-1234",
  );
});

test("normalizeSpokenDigits: 'hundred' contributes two zeros inside an open run", () => {
  assert.equal(
    normalizeSpokenDigits("one eight hundred five five five zero one one zero"),
    "1-800-555-0110",
  );
});

test("normalizeSpokenDigits: mixes numerals into a run once a word has opened it", () => {
  assert.equal(
    normalizeSpokenDigits("eight one two, 555, 0199"),
    "812-555-0199",
  );
});

test("normalizeSpokenDigits: leaves prose containing digit words alone", () => {
  const cases = [
    "one of the tenants called about the unit",
    "I have two dogs and three cats",
    "give me one second, I'll find it",
    "he said four or five people showed up",
  ];
  for (const input of cases) {
    assert.equal(normalizeSpokenDigits(input), input, `should not rewrite: ${input}`);
  }
});

test("normalizeSpokenDigits: a run that is not a phone shape is left verbatim", () => {
  // 5 digits, 8 digits and 9 digits are all non-shapes; none may be rewritten.
  assert.equal(normalizeSpokenDigits("code one two three four five"), "code one two three four five");
  assert.equal(
    normalizeSpokenDigits("account one two three four five six seven eight"),
    "account one two three four five six seven eight",
  );
});

test("normalizeSpokenDigits: a numeral cannot seed a run", () => {
  // "2024" must not merge with the digit words that follow it.
  assert.equal(
    normalizeSpokenDigits("back in 2024 one two three"),
    "back in 2024 one two three",
  );
});

test("normalizeSpokenDigits: a sentence boundary breaks a run", () => {
  // The period is not an in-number separator, so these two are separate runs
  // and neither reaches a phone shape.
  assert.equal(
    normalizeSpokenDigits("that is nine. Two hours later he called"),
    "that is nine. Two hours later he called",
  );
});

test("normalizeSpokenDigits: finds a number after a non-shape run earlier in the line", () => {
  assert.equal(
    normalizeSpokenDigits("press one two, then call five five five one two three four"),
    "press one two, then call 555-1234",
  );
});

test("normalizeSpokenDigits: handles two numbers in one utterance", () => {
  assert.equal(
    normalizeSpokenDigits(
      "call back at five five five one two three four or eight one two five five five zero one nine nine",
    ),
    "call back at 555-1234 or 812-555-0199",
  );
});

test("normalizeSpokenDigits: preserves already-digit output untouched", () => {
  const input = "Please give me a call back at 555-123-4567, extension 4471.";
  assert.equal(normalizeSpokenDigits(input), input);
});

test("normalizeSpokenDigits: empty and whitespace input are safe", () => {
  assert.equal(normalizeSpokenDigits(""), "");
  assert.equal(normalizeSpokenDigits("   "), "   ");
});

// ---------------------------------------------------------------------------
// tidyTranscript
// ---------------------------------------------------------------------------

test("tidyTranscript: joins whisper's per-segment lines into one paragraph", () => {
  const raw = " Hi, this is Karen calling about your\n appointment.\n Please call back at\n 555-1234.\n";
  assert.equal(
    tidyTranscript(raw),
    "Hi, this is Karen calling about your appointment. Please call back at 555-1234.",
  );
});

test("tidyTranscript: a hyphen-split number is spliced without a space", () => {
  // Observed from the live server: a 30s decode window ended mid-number.
  const raw = " Please give me a call back at 555-123-4567, that's 555-123-\n4567.\n Thanks, bye.";
  assert.equal(
    tidyTranscript(raw),
    "Please give me a call back at 555-123-4567, that's 555-123-4567. Thanks, bye.",
  );
});

test("tidyTranscript: a window starting with closing punctuation does not gain a space", () => {
  const raw = " reach the office at 812-555-0199, extension 4471\n.\n Thanks, bye.";
  assert.equal(
    tidyTranscript(raw),
    "reach the office at 812-555-0199, extension 4471. Thanks, bye.",
  );
});

test("tidyTranscript: a number split across segments survives the join", () => {
  // The join is what lets normalizeSpokenDigits see a run that whisper broke
  // across two 30-second decode windows.
  const raw = " call me at five five five\n one two three four\n";
  assert.equal(normalizeSpokenDigits(tidyTranscript(raw)), "call me at 555-1234");
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

test("buildTranscriptionUrl: appends the OpenAI audio path, rejects a malformed base", () => {
  assert.equal(
    buildTranscriptionUrl(DEFAULT_TRANSCRIPTION_BASE_URL),
    "http://127.0.0.1:9292/v1/audio/transcriptions",
  );
  assert.equal(
    buildTranscriptionUrl("http://127.0.0.1:9292/v1/"),
    "http://127.0.0.1:9292/v1/audio/transcriptions",
  );
  assert.equal(buildTranscriptionUrl("not a url"), null);
});

function request(overrides: Partial<TranscriptionRequest> = {}): TranscriptionRequest {
  return {
    filename: "voicemail.wav",
    bytes: new Uint8Array([1, 2, 3]),
    language: "en",
    model: DEFAULT_TRANSCRIPTION_MODEL,
    ...overrides,
  };
}

function fakePost(response: { ok: boolean; status: number; body: unknown }): PostAudio {
  return async () => ({ ok: response.ok, status: response.status, json: async () => response.body });
}

test("transcribeAudio: happy path tidies and normalises the server's text", async () => {
  const post = fakePost({
    ok: true,
    status: 200,
    body: { text: " Call the office at eight one two five five five zero one nine nine.\n Thanks.\n" },
  });
  const outcome = await transcribeAudio(DEFAULT_TRANSCRIPTION_BASE_URL, request(), post);
  assert.equal(outcome.ok, true);
  assert.equal(
    outcome.ok && outcome.text,
    "Call the office at 812-555-0199. Thanks.",
  );
});

test("transcribeAudio: reports an empty upload without calling the server", async () => {
  let called = false;
  const post: PostAudio = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ text: "x" }) };
  };
  const outcome = await transcribeAudio(
    DEFAULT_TRANSCRIPTION_BASE_URL,
    request({ bytes: new Uint8Array() }),
    post,
  );
  assert.equal(outcome.ok, false);
  assert.equal(called, false);
  assert.match(outcome.ok ? "" : outcome.error, /empty/);
});

test("transcribeAudio: surfaces a transport failure with a llama-swap hint", async () => {
  const post: PostAudio = async () => {
    throw new Error("ECONNREFUSED");
  };
  const outcome = await transcribeAudio(DEFAULT_TRANSCRIPTION_BASE_URL, request(), post);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /llama-swap/);
  assert.match(outcome.ok ? "" : outcome.error, /whisper-voicemail/);
});

test("transcribeAudio: surfaces a non-2xx status", async () => {
  const outcome = await transcribeAudio(
    DEFAULT_TRANSCRIPTION_BASE_URL,
    request(),
    fakePost({ ok: false, status: 503, body: {} }),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /HTTP 503/);
});

test("transcribeAudio: rejects a response with no text field", async () => {
  const outcome = await transcribeAudio(
    DEFAULT_TRANSCRIPTION_BASE_URL,
    request(),
    fakePost({ ok: true, status: 200, body: { error: "nope" } }),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /no `text` field/);
});

test("transcribeAudio: silence is an explicit failure, not an empty success", async () => {
  const outcome = await transcribeAudio(
    DEFAULT_TRANSCRIPTION_BASE_URL,
    request(),
    fakePost({ ok: true, status: 200, body: { text: "  \n \n" } }),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /No speech/);
});

test("transcribeAudio: malformed base URL fails before upload", async () => {
  const outcome = await transcribeAudio(
    "not a url",
    request(),
    fakePost({ ok: true, status: 200, body: { text: "x" } }),
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /Malformed/);
});

test("formatTranscript: returns bare text on success, a prefixed reason on failure", () => {
  assert.equal(
    formatTranscript({ ok: true, filename: "vm.wav", text: "call 555-1234" }),
    "call 555-1234",
  );
  assert.equal(
    formatTranscript({ ok: false, error: "boom" }),
    "Transcription failed: boom",
  );
});
