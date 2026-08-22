/**
 * Pi Harness - the fixed session reader (spec sections 6.3, 10.1, 32).
 *
 * Section 6.3 says a retrospective reviewer "rereads an entire prior
 * session". Section 32 condition 1 says the review is accepted only if
 * "every raw session JSONL line was actually retrieved through the fixed
 * session reader". Both sentences are about Pi's session file.
 *
 * v0.2 measured neither. It built the reviewer's input from the harness's own
 * `audit.jsonl`, filtered by harness session id, and counted audit records as
 * the coverage denominator. Every mechanical condition passed, and the thing
 * being measured was the wrong artifact: the harness audit records the
 * decisions the harness made, and contains no user message, no assistant
 * reply, no tool result, no compaction. A reviewer reading it can see that a
 * write was denied and cannot see what the user asked for. "Complete harness
 * audit read" was being reported as "complete Pi session read".
 *
 * That is an instrument error rather than a bug: the number was right about
 * something nobody wanted to know.
 *
 * This module is the reader those sentences refer to. It is deliberately
 * dumb - it parses lines and counts them - because the coverage claim is only
 * worth anything if the thing making it cannot also decide what to skip.
 *
 * Pure: filesystem access is injected, so a test can present a truncated or
 * unreadable session without creating one.
 */

/** The subset of a Pi session entry this module reads. Pi's own type is
 * richer; depending on more of it would couple the coverage measurement to
 * Pi's internals for no gain. */
export interface PiSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface SessionReaderIO {
  readFile(file: string): string;
  exists(file: string): boolean;
}

export interface SessionReadResult {
  /** Absolute path actually read. */
  file: string;
  /** True when the file was found and read at all. */
  found: boolean;
  /**
   * Physical non-empty lines in the file. This is the denominator of the
   * section 32 coverage claim, and it is counted from the raw text rather
   * than from anything that parsed - a line that could not be parsed is
   * still a line that was not retrieved.
   */
  linesTotal: number;
  /** Lines that parsed into an entry with an id. */
  linesParsed: number;
  /** Lines that were present and did not parse. */
  linesUnparsed: number;
  /** The session header line, when the file carries one. */
  header: Record<string, unknown> | null;
  entries: PiSessionEntry[];
  /** Every entry id in the file, for the citation check. */
  entryIds: string[];
  /** Why the read is incomplete, when it is. */
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a Pi session JSONL in full.
 *
 * Every line is counted whether or not it parses. A reader that silently
 * dropped the lines it could not understand would report perfect coverage of
 * a file it had partly failed to read, which is precisely the failure
 * condition 1 exists to catch.
 */
export function readPiSession(file: string, io: SessionReaderIO): SessionReadResult {
  const empty: SessionReadResult = {
    file,
    found: false,
    linesTotal: 0,
    linesParsed: 0,
    linesUnparsed: 0,
    header: null,
    entries: [],
    entryIds: [],
    reason: "session file not found",
  };
  if (!io.exists(file)) return empty;

  let raw: string;
  try {
    raw = io.readFile(file);
  } catch (error) {
    return { ...empty, reason: `session file could not be read: ${String(error)}` };
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const entries: PiSessionEntry[] = [];
  let header: Record<string, unknown> | null = null;
  let unparsed = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unparsed++;
      continue;
    }
    if (!isRecord(parsed)) {
      unparsed++;
      continue;
    }
    // Pi's first line is the session header: `{"type":"session","version":3,
    // "id":<uuid>,"cwd":...}`. It carries an id, but that id names the
    // session rather than an entry inside it, so it is held separately - a
    // reviewer citing the session's own uuid has cited the file, not
    // anything in it. It is still a line, and still counted.
    if (header === null && parsed.type === "session") {
      header = parsed;
      continue;
    }
    if (typeof parsed.id !== "string" || typeof parsed.type !== "string") {
      if (header === null) header = parsed;
      else unparsed++;
      continue;
    }
    entries.push({
      type: parsed.type,
      id: parsed.id,
      parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
      ...parsed,
    } as PiSessionEntry);
  }

  const parsedLines = entries.length + (header !== null ? 1 : 0);
  return {
    file,
    found: true,
    linesTotal: lines.length,
    linesParsed: parsedLines,
    linesUnparsed: unparsed,
    header,
    entries,
    entryIds: entries.map((entry) => entry.id),
    reason:
      unparsed === 0
        ? `read ${parsedLines} of ${lines.length} line(s)`
        : `${unparsed} line(s) in the session file could not be parsed`,
  };
}

/**
 * How much of one entry's prose the reviewer is shown.
 *
 * A whole session can be far larger than a reviewer's context, and something
 * has to give. What must NOT give is the line count: dropping entries would
 * make the coverage claim false in exactly the way condition 1 exists to
 * catch. So every entry is always rendered and always counted, and only the
 * *body* of an over-long one is abbreviated - with the elision stated inline,
 * so a reviewer can see that there is more and say so rather than silently
 * reviewing a prefix.
 */
export const DEFAULT_MAX_BODY_CHARS = 4000;

function abbreviate(text: string, maxBodyChars: number): string {
  if (maxBodyChars <= 0 || text.length <= maxBodyChars) return text;
  return `${text.slice(0, maxBodyChars)} [... ${text.length - maxBodyChars} chars elided]`;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        isRecord(part) && typeof part.text === "string"
          ? part.text
          : isRecord(part) && typeof part.type === "string"
            ? `[${part.type}]`
            : "",
      )
      .filter((part) => part.length > 0)
      .join(" ");
  }
  return "";
}

/**
 * Render one session entry for a reviewer to read.
 *
 * Every entry type gets a line, including the ones with no prose. A model
 * change and a compaction are exactly the events a retrospective needs to
 * explain a shift in behaviour, and a renderer that emitted only messages
 * would hide them while still counting them as read.
 *
 * The entry id leads every line because the evidence contract requires the
 * reviewer to cite ids, and it can only cite what it was shown.
 */
export function renderSessionEntry(
  entry: PiSessionEntry,
  maxBodyChars: number = DEFAULT_MAX_BODY_CHARS,
): string {
  const head = `${entry.id} [${entry.type}]`;
  switch (entry.type) {
    case "message": {
      const message = isRecord(entry.message) ? entry.message : {};
      const role = typeof message.role === "string" ? message.role : "unknown";
      const body = abbreviate(textOf(message.content), maxBodyChars);
      return `${head} ${role}: ${body}`;
    }
    case "model_change":
      return `${head} model -> ${String(entry.provider)}/${String(entry.modelId)}`;
    case "thinking_level_change":
      return `${head} thinking level -> ${String(entry.thinkingLevel)}`;
    case "compaction":
      return `${head} context compacted (kept from ${String(entry.firstKeptEntryId)}): ${String(entry.summary)}`;
    case "branch_summary":
      return `${head} branched from ${String(entry.fromId)}: ${String(entry.summary)}`;
    case "custom": {
      // Custom entries are how other extensions record their own state in
      // the session. Their payload is often the only trace of what a
      // sibling extension did, so it is shown rather than summarised away -
      // abbreviated like any other body when it is large.
      const data = entry.data === undefined ? "" : ` ${abbreviate(JSON.stringify(entry.data), maxBodyChars)}`;
      return `${head} ${String(entry.customType ?? "custom")}${data}`;
    }
    case "custom_message":
      return `${head} ${String(entry.customType ?? "custom")}: ${abbreviate(textOf(entry.content), maxBodyChars)}`;
    case "session_info":
      return `${head} session named ${String(entry.name)}`;
    default:
      return `${head}`;
  }
}

/**
 * The full session as the reviewer sees it, one entry per line.
 *
 * One line per entry, unconditionally. The count of lines here is the count
 * of entries read, so a reviewer that is handed this transcript has been
 * handed everything the reader retrieved.
 */
export function renderSessionTranscript(
  result: SessionReadResult,
  maxBodyChars: number = DEFAULT_MAX_BODY_CHARS,
): string {
  return result.entries.map((entry) => renderSessionEntry(entry, maxBodyChars)).join("\n");
}
