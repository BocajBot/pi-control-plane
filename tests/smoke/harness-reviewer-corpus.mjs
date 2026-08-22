// Deterministic stress of the retrospective evidence contract over every
// REAL Pi session on this machine. No model is loaded and none is needed:
// every axis below is a property of the harness, not of a reviewer.
//
// The axes are measured separately and never collapsed, because "the review
// was rejected" is six different facts:
//
//   complete source read | parser success | citation syntactic validity
//   | citation source membership | review acceptance | semantic relevance
//
// The one axis this cannot reach is a live model's citation discipline over
// a long session. That needs a reviewer; see harness-reviewer-stress.mjs.
//
//   node tests/smoke/harness-reviewer-corpus.mjs
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { readPiSession, renderSessionTranscript } = await import(`${REPO}/src/harness/session-reader.ts`);
const { checkReviewEvidence, extractCitations, parseReviewProposals, renderReviewPrompt, stripEchoedPrompt } =
  await import(`${REPO}/src/harness/agents.ts`);

const io = { readFile: (f) => fs.readFileSync(f, "utf8"), exists: (f) => fs.existsSync(f) };
const base = path.join(os.homedir(), ".pi/agent/sessions");
const files = [];
for (const d of fs.readdirSync(base)) {
  const p = path.join(base, d);
  if (!fs.statSync(p).isDirectory()) continue;
  for (const f of fs.readdirSync(p)) if (f.endsWith(".jsonl")) files.push(path.join(p, f));
}

const tally = {
  sessions: 0, completeRead: 0, shortRead: 0,
  ids: 0, idsCitable: 0,
  parserOk: 0, membershipOk: 0, accepted: 0,
  fabricatedRejected: 0, truncationCaught: 0,
  echoSurvived: 0, markdownParsed: 0, uniformWarned: 0,
  withTools: 0, withFailedTools: 0, withModelSwitch: 0, withCompaction: 0, withCustom: 0,
  biggest: 0, totalLines: 0,
};
const failures = [];

/** A reviewer reply in the shape a real one produced live: markdown headings
 * and `text || id` citations. */
function replyCiting(ids, opts = {}) {
  const cite = (i) => ids[Math.min(i, ids.length - 1)];
  const one = opts.uniform ? () => ids[0] : cite;
  return [
    "## FINDINGS",
    `- the session opened against a real project || ${one(0)}`,
    `- work proceeded through recorded entries || ${one(1)}`,
    "## PATTERNS",
    `- the operator drove with short instructions || ${one(2)}`,
    "## MISTAKES",
    `- none attributable, cause unknown || ${one(3)}`,
    "## LESSONS",
    `- the transcript is legible after the fact || ${one(4)}`,
    "## UNRESOLVED",
    `- whether the objective was met || ${one(5)}`,
    "## MEMORY",
    `- this session is recorded end to end || ${one(0)}`,
  ].join("\n");
}

const gate = (read, reply) => {
  const parsed = parseReviewProposals(reply);
  return {
    parsed,
    ...checkReviewEvidence(parsed, new Set(read.entryIds), {
      linesExpected: read.linesTotal,
      linesRead: read.linesParsed,
    }),
  };
};

for (const file of files) {
  const read = readPiSession(file, io);
  const raw = fs.readFileSync(file, "utf8");
  const physical = raw.split("\n").filter((l) => l.trim()).length;
  tally.sessions++;
  tally.totalLines += read.linesTotal;
  tally.biggest = Math.max(tally.biggest, read.linesTotal);

  // --- axis 1: complete source read, against the raw line count ---
  const complete = read.linesTotal === physical && read.linesParsed === read.linesTotal && read.linesTotal > 0;
  if (complete) tally.completeRead++;
  else { tally.shortRead++; failures.push(`${path.basename(file)}: short read ${read.linesParsed}/${physical}`); }

  const types = new Set(read.entries.map((e) => e.type));
  if (raw.includes('"toolCall"')) tally.withTools++;
  if (raw.includes('"isError":true')) tally.withFailedTools++;
  if (read.entries.filter((e) => e.type === "model_change").length > 1) tally.withModelSwitch++;
  if (types.has("compaction")) tally.withCompaction++;
  if (types.has("custom")) tally.withCustom++;

  if (read.entryIds.length < 2) continue;

  // --- axis 2: citation syntactic validity, through the real extractor ---
  for (const id of read.entryIds) {
    tally.ids++;
    if (extractCitations(`a finding || ${id}`).includes(id)) tally.idsCitable++;
    else failures.push(`${path.basename(file)}: entry id ${id} is not a citation candidate`);
  }

  // --- axes 3-5: parser, membership, acceptance ---
  const good = gate(read, replyCiting(read.entryIds));
  if (good.acceptance.shapeValid) tally.parserOk++;
  else failures.push(`${path.basename(file)}: parser rejected a well-formed reply`);
  if (good.acceptance.citationsValid) tally.membershipOk++;
  else failures.push(`${path.basename(file)}: real ids failed membership - ${good.acceptance.rejectedItems[0]}`);
  if (good.acceptance.accepted) tally.accepted++;

  // --- the attacks, one per axis ---
  // Fabricated id of exactly the right shape must not be accepted.
  const fake = gate(read, replyCiting(["deadbeef"]));
  if (!fake.acceptance.accepted) tally.fabricatedRejected++;
  else failures.push(`${path.basename(file)}: a fabricated id was accepted`);

  // A damaged line must fail condition 1, not vanish from the denominator.
  const lines = raw.trim().split("\n");
  const cut = [...lines];
  cut[Math.floor(cut.length / 2)] = cut[Math.floor(cut.length / 2)].slice(0, 15);
  const damagedIo = { exists: () => true, readFile: () => cut.join("\n") + "\n" };
  const damaged = readPiSession(file, damagedIo);
  if (damaged.linesTotal === lines.length && damaged.linesParsed < damaged.linesTotal) tally.truncationCaught++;
  else failures.push(`${path.basename(file)}: a damaged line did not fail the read`);

  // Prompt echo must not poison an otherwise valid review.
  const prompt = renderReviewPrompt(renderSessionTranscript(read), []);
  const echoed = gate(read, stripEchoedPrompt(`${prompt}\n${replyCiting(read.entryIds)}`, prompt));
  if (echoed.acceptance.accepted) tally.echoSurvived++;
  else failures.push(`${path.basename(file)}: prompt echo sank a valid review - ${echoed.acceptance.reason}`);

  // Markdown headings must parse (a live reviewer used them).
  if (good.parsed.findings.length === 2) tally.markdownParsed++;
  else failures.push(`${path.basename(file)}: markdown headings did not parse`);

  // Semantic relevance stays a warning, and must actually fire.
  const uniform = gate(read, replyCiting(read.entryIds, { uniform: true }));
  if (uniform.acceptance.uniformCitation && uniform.acceptance.accepted) tally.uniformWarned++;
  else failures.push(`${path.basename(file)}: uniform citation was not warned-and-accepted`);
}

const line = (k, v, of) => console.log(`  ${k.padEnd(32)} ${String(v).padStart(4)}${of ? ` / ${of}` : ""}`);
console.log(`\nreal Pi sessions: ${tally.sessions}  (${tally.totalLines} lines, largest ${tally.biggest})\n`);
console.log("corpus features");
line("with tool calls", tally.withTools, tally.sessions);
line("with failed tool activity", tally.withFailedTools, tally.sessions);
line("with a model switch", tally.withModelSwitch, tally.sessions);
line("with compaction", tally.withCompaction, tally.sessions);
line("with custom entries", tally.withCustom, tally.sessions);
const measured = tally.parserOk;
console.log("\nmeasured axes");
line("complete source read", tally.completeRead, tally.sessions);
line("citation syntactic validity", tally.idsCitable, tally.ids);
line("parser success", tally.parserOk, measured);
line("citation source membership", tally.membershipOk, measured);
line("review acceptance", tally.accepted, measured);
line("semantic warning (not a gate)", tally.uniformWarned, measured);
console.log("\nattacks");
line("fabricated id rejected", tally.fabricatedRejected, measured);
line("damaged line fails the read", tally.truncationCaught, measured);
line("prompt echo survived", tally.echoSurvived, measured);
line("markdown headings parsed", tally.markdownParsed, measured);
if (tally.withCompaction === 0)
  console.log("\nNOTE: no real session on disk contains a compaction, so that axis is unexercised.");
console.log(failures.length ? `\nFAILURES (${failures.length}):` : "\nno failures");
for (const f of failures.slice(0, 15)) console.log(`  ${f}`);
