import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addNote,
  clearScratchpad,
  emptyScratchpad,
  generateNoteId,
  MAX_NOTE_LENGTH,
  MAX_NOTES,
  removeNote,
  renderScratchpadBlock,
  renderScratchpadList,
  restoreScratchpadFromEntries,
  validateNote,
  validateScratchpad,
} from "../src/control-plane/scratchpad.ts";
import { SCRATCHPAD_ENTRY_TYPE, SCRATCHPAD_SCHEMA_VERSION } from "../src/control-plane/types.ts";

test("emptyScratchpad: no notes, correct schema version", () => {
  const sp = emptyScratchpad("2026-01-01T00:00:00.000Z");
  assert.equal(sp.schemaVersion, SCRATCHPAD_SCHEMA_VERSION);
  assert.deepEqual(sp.notes, []);
});

test("addNote: trims text, assigns id/createdAt, appends without mutating input", () => {
  const sp = emptyScratchpad();
  const result = addNote(sp, "  remember X  ", "abc12", "2026-01-01T00:00:00.000Z");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.note.text, "remember X");
  assert.equal(result.note.id, "abc12");
  assert.equal(result.scratchpad.notes.length, 1);
  assert.equal(sp.notes.length, 0, "original scratchpad must not be mutated");
});

test("addNote: empty/whitespace-only text is rejected", () => {
  const sp = emptyScratchpad();
  assert.equal(addNote(sp, "", "id1").ok, false);
  assert.equal(addNote(sp, "   ", "id1").ok, false);
});

test("addNote: text beyond MAX_NOTE_LENGTH is truncated, never silently dropped", () => {
  const sp = emptyScratchpad();
  const long = "x".repeat(MAX_NOTE_LENGTH + 500);
  const result = addNote(sp, long, "id1");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.note.text.endsWith("[TRUNCATED]"));
  assert.ok(result.note.text.length <= MAX_NOTE_LENGTH + " [TRUNCATED]".length);
});

test("addNote: refuses past MAX_NOTES", () => {
  let sp = emptyScratchpad();
  for (let i = 0; i < MAX_NOTES; i++) {
    const result = addNote(sp, `note ${i}`, `id${i}`);
    assert.equal(result.ok, true);
    if (result.ok) sp = result.scratchpad;
  }
  const overflow = addNote(sp, "one too many", "idX");
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.match(overflow.error, /full/i);
});

test("removeNote: removes by id, unknown id errors without changing state", () => {
  const sp = emptyScratchpad();
  const added = addNote(sp, "keep me", "keepme");
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const missing = removeNote(added.scratchpad, "nope");
  assert.equal(missing.ok, false);
  const removed = removeNote(added.scratchpad, "keepme");
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.scratchpad.notes.length, 0);
});

test("clearScratchpad: returns an empty scratchpad regardless of input", () => {
  const cleared = clearScratchpad("2026-01-01T00:00:00.000Z");
  assert.deepEqual(cleared.notes, []);
});

test("generateNoteId: avoids collisions with the existing id set", () => {
  const existing = new Set(["aaaaa"]);
  const id = generateNoteId(existing);
  assert.notEqual(id, "aaaaa");
  assert.ok(id.length > 0);
});

test("validateNote / validateScratchpad: strict shape, malformed rejected", () => {
  assert.equal(validateNote({ id: "a", text: "t", createdAt: "now" }) !== null, true);
  assert.equal(validateNote({ id: "", text: "t", createdAt: "now" }), null);
  assert.equal(validateNote({ id: "a", text: 5, createdAt: "now" }), null);
  assert.equal(validateNote(null), null);

  const good = { schemaVersion: SCRATCHPAD_SCHEMA_VERSION, notes: [], updatedAt: "now" };
  assert.notEqual(validateScratchpad(good), null);
  assert.equal(validateScratchpad({ ...good, schemaVersion: 999 }), null);
  assert.equal(validateScratchpad({ ...good, notes: "not-an-array" }), null);
  assert.equal(
    validateScratchpad({ ...good, notes: [{ id: "", text: "t", createdAt: "now" }] }),
    null,
    "one malformed note invalidates the whole entry, same as validateState's all-or-nothing rule",
  );
});

test("restoreScratchpadFromEntries: walks backward, takes newest valid, ignores malformed, falls back to empty", () => {
  const valid = { schemaVersion: SCRATCHPAD_SCHEMA_VERSION, notes: [{ id: "x", text: "keep", createdAt: "t1" }], updatedAt: "t1" };
  const entries = [
    { type: "custom", customType: SCRATCHPAD_ENTRY_TYPE, data: valid },
    { type: "custom", customType: SCRATCHPAD_ENTRY_TYPE, data: { garbage: true } },
    { type: "message", data: {} },
  ];
  const result = restoreScratchpadFromEntries(entries, SCRATCHPAD_ENTRY_TYPE);
  assert.equal(result.restored, true);
  assert.equal(result.ignoredMalformed, 1);
  assert.equal(result.scratchpad.notes.length, 1);
  assert.equal(result.scratchpad.notes[0].text, "keep");
});

test("restoreScratchpadFromEntries: no matching entries -> empty scratchpad, not restored", () => {
  const result = restoreScratchpadFromEntries([{ type: "message", data: {} }], SCRATCHPAD_ENTRY_TYPE);
  assert.equal(result.restored, false);
  assert.equal(result.scratchpad.notes.length, 0);
});

test("renderScratchpadBlock: empty scratchpad renders nothing (no per-turn noise)", () => {
  assert.equal(renderScratchpadBlock(emptyScratchpad(), 6000), null);
});

test("renderScratchpadBlock: notes render with their ids, truncated at the total-char cap", () => {
  const added = addNote(emptyScratchpad(), "buy milk", "note1");
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const block = renderScratchpadBlock(added.scratchpad, 6000);
  assert.notEqual(block, null);
  assert.ok(block!.includes("note1"));
  assert.ok(block!.includes("buy milk"));

  const capped = renderScratchpadBlock(added.scratchpad, 10);
  assert.ok(capped!.endsWith("[TRUNCATED]"));
});

test("renderScratchpadList: empty vs populated", () => {
  assert.deepEqual(renderScratchpadList(emptyScratchpad()), [
    "Scratchpad is empty.",
    "Add a note with /scratchpad add <text>.",
  ]);
  const added = addNote(emptyScratchpad(), "note text", "id1", "2026-01-01T00:00:00.000Z");
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const lines = renderScratchpadList(added.scratchpad);
  assert.ok(lines.some((l) => l.includes("id1")));
  assert.ok(lines.some((l) => l.includes("note text")));
});
