/**
 * Delegate-transcript picker rendering (pure, testable without Pi).
 *
 * The extension lists transcript files and shows this picker in a TUI
 * overlay (alt+d, or /harness transcript with no argument); choosing an
 * entry replays that transcript into the chat. Claude Code's subagent
 * selector is the model: newest first, one line each, enough metadata to
 * tell runs apart.
 */

export interface TranscriptEntry {
  /** Contract id, which is also the file basename. */
  id: string;
  /** From the file header: kind + model. */
  kind: string;
  model: string;
  objective: string;
  startedAt: string;
  /** The child's own saved pi session file, when the run recorded one.
   * This is what lets the picker swap the TUI into the sub-session. */
  sessionFile: string | null;
}

/**
 * Parse the header the delegate run writes at the top of each transcript.
 * Unknown or truncated headers degrade to placeholders rather than dropping
 * the file - a transcript that exists must stay selectable.
 */
export function parseTranscriptHeader(id: string, content: string): TranscriptEntry {
  const entry: TranscriptEntry = { id, kind: "?", model: "?", objective: "(unknown objective)", startedAt: "", sessionFile: null };
  for (const line of content.split("\n", 8)) {
    const sessionMatch = /^# session: (.+)$/.exec(line);
    if (sessionMatch && sessionMatch[1].trim().length > 0) {
      entry.sessionFile = sessionMatch[1].trim();
      continue;
    }
    const kindMatch = /^# kind: (\S+)\s+model: (.+?)\s+started: (\S+)$/.exec(line);
    if (kindMatch) {
      entry.kind = kindMatch[1];
      entry.model = kindMatch[2];
      entry.startedAt = kindMatch[3];
      continue;
    }
    const objectiveMatch = /^# objective: (.*)$/.exec(line);
    if (objectiveMatch) entry.objective = objectiveMatch[1];
  }
  return entry;
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

/** Overlay body: one row per transcript, cursor on `selected`. */
export function renderTranscriptPicker(
  entries: readonly TranscriptEntry[],
  selected: number,
  width: number,
): string[] {
  if (entries.length === 0) {
    return ["Delegate transcripts", "", "  (none recorded yet)", "", "  esc close"];
  }
  const lines = [clip("Delegate transcripts — enter open sub-session, t transcript text, esc close", width), ""];
  entries.forEach((entry, index) => {
    const cursor = index === selected ? "→ " : "  ";
    const when = entry.startedAt.replace(/T/, " ").replace(/\.\d+Z$/, "");
    lines.push(clip(`${cursor}${when}  ${entry.kind}  ${entry.model}  ${entry.objective}`, width));
  });
  return lines;
}
