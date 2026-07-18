import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEdits,
  extractText,
  mergeOverlay,
  type MessageLike,
  parseEditedContext,
  serializeContext,
  SYSTEM_MARKER,
} from "../src/control-plane/context-editor.ts";

const sampleMessages: MessageLike[] = [
  { role: "user", content: "hello there" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "I will read the file." },
      { type: "toolCall", name: "read", id: "tc1" },
    ],
  },
  { role: "toolResult", content: [{ type: "text", text: "file contents" }] },
];

test("serialize -> parse round-trip with no edits yields no changes", () => {
  const doc = serializeContext("SYSTEM", sampleMessages);
  const parsed = parseEditedContext(doc, sampleMessages.length);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.edit.systemPrompt, "SYSTEM");
  const applied = applyEdits(sampleMessages, parsed.edit);
  assert.equal(applied.editedCount, 0);
  assert.equal(applied.droppedCount, 0);
  assert.deepEqual(applied.messages, sampleMessages);
});

test("text edits are applied; non-text blocks preserved verbatim", () => {
  const doc = serializeContext("SYSTEM", sampleMessages).replace("I will read the file.", "EDITED TEXT");
  const parsed = parseEditedContext(doc, sampleMessages.length);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const applied = applyEdits(sampleMessages, parsed.edit);
  assert.equal(applied.editedCount, 1);
  const content = applied.messages[1].content as { type?: string; text?: string; id?: string }[];
  assert.deepEqual(
    content.map((b) => b.type),
    ["thinking", "text", "toolCall"],
  );
  assert.equal(content[1].text, "EDITED TEXT");
  assert.equal(content[2].id, "tc1");
});

test("deleting a message section removes the message", () => {
  const doc = serializeContext("SYSTEM", sampleMessages);
  const withoutFirst = doc.replace(/#### PI-CTX MESSAGE 0 user ####\nhello there\n/, "");
  const parsed = parseEditedContext(withoutFirst, sampleMessages.length);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const applied = applyEdits(sampleMessages, parsed.edit);
  assert.equal(applied.droppedCount, 1);
  assert.equal(applied.messages.length, 2);
  assert.equal(applied.messages[0].role, "assistant");
});

test("placeholder lines are ignored on save; system prompt edits detected", () => {
  const doc = serializeContext("SYSTEM", sampleMessages);
  assert.ok(doc.includes("[non-text: thinking]"));
  assert.ok(doc.includes("[non-text: toolCall read]"));
  const edited = doc.replace(`${SYSTEM_MARKER}\nSYSTEM`, `${SYSTEM_MARKER}\nNEW SYSTEM PROMPT`);
  const parsed = parseEditedContext(edited, sampleMessages.length);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.edit.systemPrompt, "NEW SYSTEM PROMPT");
});

test("malformed edits are rejected: missing system prompt, bad index, duplicates, unknown marker", () => {
  const noSystem = "#### PI-CTX MESSAGE 0 user ####\nhi";
  assert.equal(parseEditedContext(noSystem, 1).ok, false);

  const badIndex = `${SYSTEM_MARKER}\nS\n#### PI-CTX MESSAGE 9 user ####\nhi`;
  assert.equal(parseEditedContext(badIndex, 1).ok, false);

  const dupe = `${SYSTEM_MARKER}\nS\n${SYSTEM_MARKER}\nS2`;
  assert.equal(parseEditedContext(dupe, 0).ok, false);

  const unknownMarker = `${SYSTEM_MARKER}\nS\n#### PI-CTX GARBAGE ####`;
  assert.equal(parseEditedContext(unknownMarker, 0).ok, false);
});

test("extractText handles string, blocks, and empty content", () => {
  assert.equal(extractText({ content: "plain" }), "plain");
  assert.equal(extractText(sampleMessages[1]), "I will read the file.");
  assert.equal(extractText({ content: [{ type: "toolCall" }] }), "");
  assert.equal(extractText({}), "");
});

test("draft section round-trips; preview-prefixed lines are ignored on parse", () => {
  const doc = serializeContext("SYSTEM", sampleMessages, {
    draft: "my unsent message",
    previewLines: ["[PI CONTROL PLANE]", "Phase: Discuss"],
  });
  assert.ok(doc.includes("#> [PI CONTROL PLANE]"));
  const parsed = parseEditedContext(doc, sampleMessages.length);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.edit.draft, "my unsent message");
  // Preview lines must not leak into the parsed system prompt.
  assert.equal(parsed.edit.systemPrompt, "SYSTEM");

  const editedDraft = doc.replace("my unsent message", "rewritten draft");
  const reparsed = parseEditedContext(editedDraft, sampleMessages.length);
  assert.ok(reparsed.ok);
  if (!reparsed.ok) return;
  assert.equal(reparsed.edit.draft, "rewritten draft");
});

test("document without a DRAFT section parses with draft null; duplicate DRAFT rejected", () => {
  const doc = serializeContext("SYSTEM", sampleMessages);
  const parsed = parseEditedContext(doc, sampleMessages.length);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.edit.draft, null);

  const dupe = serializeContext("S", [], { draft: "a" }) + "\n#### PI-CTX DRAFT ####\nb";
  assert.equal(parseEditedContext(dupe, 0).ok, false);
});

test("overlay merge: edited prefix + live tail; shrunk conversation invalidates", () => {
  const overlay = {
    messages: [{ role: "user", content: "EDITED" }],
    baseCount: 2,
    systemPrompt: null,
    createdAt: "t",
  };
  const incoming: MessageLike[] = [
    { role: "user", content: "original 1" },
    { role: "assistant", content: "original 2" },
    { role: "user", content: "new message" },
  ];
  const merged = mergeOverlay(overlay, incoming);
  assert.ok(merged.ok);
  if (!merged.ok) return;
  assert.deepEqual(
    merged.messages.map((m) => extractText(m)),
    ["EDITED", "new message"],
  );

  const shrunk = mergeOverlay(overlay, [{ role: "user", content: "only one" }]);
  assert.equal(shrunk.ok, false);
});
