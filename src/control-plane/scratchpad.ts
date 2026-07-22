/**
 * Programming scratchpad: structured working notes that survive /compact.
 *
 * Persisted the same way ControlPlaneState is (state.ts): appended as a
 * custom session entry on every mutation, restored by walking the branch
 * backward for the newest valid entry. Custom entries are excluded from LLM
 * context and untouched by compaction (which only summarizes messages), so
 * notes outlive a /compact the same way the control-plane state does.
 *
 * Deliberately dumb: the control plane never writes, edits, or summarizes a
 * note's text on the model's behalf. It only stores what it is told to store
 * and hands back what is there - fabricating or condensing content here would
 * be exactly the kind of invented state the rest of this codebase refuses to
 * produce (see ui.ts's "Unavailable, never guessed" rule).
 */

import { SCRATCHPAD_SCHEMA_VERSION, type ScratchpadNote, type ScratchpadState } from "./types.ts";

export const MAX_NOTES = 50;
export const MAX_NOTE_LENGTH = 4000;
/** Total injected block is capped separately in ui.ts alongside the task
 * brief's own injectionTotal limit; this bounds an individual note only. */

export function emptyScratchpad(now: string = new Date().toISOString()): ScratchpadState {
  return { schemaVersion: SCRATCHPAD_SCHEMA_VERSION, notes: [], updatedAt: now };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateNote(value: unknown): ScratchpadNote | null {
  if (!isRecord(value)) return null;
  if (!isString(value.id) || value.id.trim().length === 0) return null;
  if (!isString(value.text)) return null;
  if (!isString(value.createdAt)) return null;
  return { id: value.id, text: value.text, createdAt: value.createdAt };
}

/** Strict validation, same posture as validateState: anything unexpected ->
 * null -> caller falls back to an empty scratchpad, never a repaired guess. */
export function validateScratchpad(value: unknown): ScratchpadState | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SCRATCHPAD_SCHEMA_VERSION) return null;
  if (!isString(value.updatedAt)) return null;
  if (!Array.isArray(value.notes)) return null;
  const notes: ScratchpadNote[] = [];
  for (const raw of value.notes) {
    const note = validateNote(raw);
    if (note === null) return null;
    notes.push(note);
  }
  return { schemaVersion: SCRATCHPAD_SCHEMA_VERSION, notes, updatedAt: value.updatedAt };
}

export interface ScratchpadEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Same walk-backward-take-first-valid restoration pattern as
 * state.ts:restoreFromEntries, applied to the scratchpad's own entry type. */
export function restoreScratchpadFromEntries(
  entries: ScratchpadEntryLike[],
  entryType: string,
  now: string = new Date().toISOString(),
): { scratchpad: ScratchpadState; restored: boolean; ignoredMalformed: number } {
  let ignoredMalformed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== entryType) continue;
    const validated = validateScratchpad(entry.data);
    if (validated !== null) {
      return { scratchpad: validated, restored: true, ignoredMalformed };
    }
    ignoredMalformed++;
  }
  return { scratchpad: emptyScratchpad(now), restored: false, ignoredMalformed };
}

export type AddNoteResult =
  | { ok: true; scratchpad: ScratchpadState; note: ScratchpadNote }
  | { ok: false; error: string };

export function addNote(
  current: ScratchpadState,
  text: string,
  id: string,
  now: string = new Date().toISOString(),
): AddNoteResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, error: "Note text cannot be empty." };
  if (current.notes.length >= MAX_NOTES) {
    return {
      ok: false,
      error: `Scratchpad is full (${MAX_NOTES} notes). Remove one with /scratchpad remove <id> first.`,
    };
  }
  const note: ScratchpadNote = {
    id,
    text: trimmed.length > MAX_NOTE_LENGTH ? trimmed.slice(0, MAX_NOTE_LENGTH) + " [TRUNCATED]" : trimmed,
    createdAt: now,
  };
  return {
    ok: true,
    scratchpad: { schemaVersion: SCRATCHPAD_SCHEMA_VERSION, notes: [...current.notes, note], updatedAt: now },
    note,
  };
}

export type RemoveNoteResult =
  | { ok: true; scratchpad: ScratchpadState }
  | { ok: false; error: string };

export function removeNote(
  current: ScratchpadState,
  id: string,
  now: string = new Date().toISOString(),
): RemoveNoteResult {
  const exists = current.notes.some((n) => n.id === id);
  if (!exists) return { ok: false, error: `No note with id "${id}". Run /scratchpad to list notes.` };
  return {
    ok: true,
    scratchpad: {
      schemaVersion: SCRATCHPAD_SCHEMA_VERSION,
      notes: current.notes.filter((n) => n.id !== id),
      updatedAt: now,
    },
  };
}

export function clearScratchpad(now: string = new Date().toISOString()): ScratchpadState {
  return emptyScratchpad(now);
}

/** Short id: enough entropy to avoid collision within one session's note
 * count (MAX_NOTES = 50), short enough to type in /scratchpad remove <id>. */
export function generateNoteId(existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = Math.random().toString(36).slice(2, 7);
    if (!existing.has(id)) return id;
  }
  // Astronomically unlikely with MAX_NOTES = 50, but never loop forever.
  return `${Date.now().toString(36)}`;
}

/** Render the block injected into the system prompt each turn. Empty
 * scratchpad renders as nothing (no empty-section noise every turn). */
export function renderScratchpadBlock(scratchpad: ScratchpadState, maxTotalChars: number): string | null {
  if (scratchpad.notes.length === 0) return null;
  const lines = ["[SCRATCHPAD]", "", "Structured working notes carried across compaction:"];
  for (const note of scratchpad.notes) {
    lines.push(`- (${note.id}) ${note.text}`);
  }
  let block = lines.join("\n");
  if (block.length > maxTotalChars) {
    block = block.slice(0, maxTotalChars) + "\n[TRUNCATED]";
  }
  return block;
}

export function renderScratchpadList(scratchpad: ScratchpadState): string[] {
  if (scratchpad.notes.length === 0) {
    return ["Scratchpad is empty.", "Add a note with /scratchpad add <text>."];
  }
  const lines = [`Scratchpad (${scratchpad.notes.length}/${MAX_NOTES} notes):`, ""];
  for (const note of scratchpad.notes) {
    lines.push(`  (${note.id}) [${note.createdAt}]`);
    lines.push(`    ${note.text}`);
  }
  return lines;
}
