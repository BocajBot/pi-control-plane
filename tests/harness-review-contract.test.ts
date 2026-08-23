/**
 * The retrospective evidence contract (spec section 32).
 *
 * A reviewer is accepted only when all three conditions hold: the whole
 * session was retrieved through the fixed reader, the structured output
 * passes runtime shape validation, and every item cites a source entry id
 * that actually occurs in that session.
 *
 * These are written as refusals on purpose. The failure this contract exists
 * to stop is a plausible-looking reviewer output being promoted as evidence,
 * so the tests that matter are the ones that prove something plausible is
 * turned away - an id shaped exactly like a real one but absent from the
 * session, a perfect set of citations over a transcript that was only half
 * read, a section that vanished from the reply.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkReviewEvidence,
  extractCitations,
  isEmptySectionPlaceholder,
  nextReviewGeneration,
  parseReviewProposals,
  renderReviewPrompt,
  validateReviewProposals,
  type ReviewProposals,
} from "../src/harness/agents.ts";

/** Ids this fake session actually produced. Condition 3 is membership in
 * this set, not "looks like an id". */
const SESSION_IDS: ReadonlySet<string> = new Set([
  "aud_11111111111111111111111111111111",
  "dec_22222222222222222222222222222222",
  "inc_33333333333333333333333333333333",
]);

const AUD = "aud_11111111111111111111111111111111";
const DEC = "dec_22222222222222222222222222222222";
const INC = "inc_33333333333333333333333333333333";

/** An id the reviewer could have invented: correct prefix, correct shape,
 * accepted by `idKind()`, and never issued by this session. */
const FABRICATED = "aud_ffffffffffffffffffffffffffffffff";

function proposals(overrides: Partial<ReviewProposals> = {}): ReviewProposals {
  return {
    findings: [`the sandbox refuses without bwrap || ${AUD}`],
    patterns: [`retries were always bounded at 3 || ${DEC}`],
    mistakes: [`scope was widened without approval (cause: model) || ${INC}`],
    userPreferences: [`the user prefers pkexec over sudo || ${AUD}`],
    modelSpecificGuidance: [`model-a needs the scope restated each turn || ${DEC}`],
    projectLessons: [`ids are prefixed by record kind || ${AUD}`],
    unresolvedIssues: [`why the second bwrap probe was slower || ${INC}`],
    memoryCandidates: [{ content: "the user prefers pkexec over sudo", sources: [AUD, DEC] }],
    ...overrides,
  };
}

const COMPLETE_READ = { linesExpected: 412, linesRead: 412 };

/* --- condition 2: runtime shape validation ------------------------ */

test("validateReviewProposals: a well-formed proposal set is returned unchanged", () => {
  const value = proposals();
  const validated = validateReviewProposals(value);
  assert.notEqual(validated, null);
  assert.equal(validated, value, "a valid shape is passed through, not rebuilt");
});

test("validateReviewProposals: a missing section is refused rather than defaulted to empty", () => {
  // A truncated reply must not be indistinguishable from a reviewer that
  // honestly found no patterns. Defaulting would erase that difference.
  const truncated = proposals() as unknown as Record<string, unknown>;
  delete truncated.patterns;
  assert.equal(validateReviewProposals(truncated), null);
});

test("validateReviewProposals: malformed structured output is refused, not repaired", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "FINDINGS: none"],
    ["an array", []],
    ["a section that is not an array", proposals({ findings: "one finding" as never })],
    ["a section holding a non-string", proposals({ patterns: ["ok", 7 as never] })],
    ["memoryCandidates missing", (() => {
      const value = proposals() as unknown as Record<string, unknown>;
      delete value.memoryCandidates;
      return value;
    })()],
    ["memoryCandidates not an array", proposals({ memoryCandidates: {} as never })],
    ["a candidate that is not an object", proposals({ memoryCandidates: ["text" as never] })],
    ["a candidate with no content", proposals({ memoryCandidates: [{ sources: [AUD] } as never] })],
    [
      "a candidate whose sources are not strings",
      proposals({ memoryCandidates: [{ content: "x", sources: [1 as never] }] }),
    ],
    [
      "a candidate whose sources field is a bare string",
      proposals({ memoryCandidates: [{ content: "x", sources: AUD as never }] }),
    ],
  ];
  for (const [label, value] of cases) {
    assert.equal(validateReviewProposals(value), null, `${label} must be refused`);
  }
});

test("validateReviewProposals: an unknown extra section does not invalidate the shape", () => {
  // Extra keys are never read. Refusing them would break the first time a
  // later schema adds a section.
  const extended = { ...proposals(), futureSection: ["something"] };
  assert.notEqual(validateReviewProposals(extended), null);
});

/* --- citation extraction ------------------------------------------ */

test("extractCitations: pulls ids from the `text || id, id` convention", () => {
  assert.deepEqual(
    extractCitations(`the retry count stayed at 3 || ${AUD}, ${DEC}`),
    [AUD, DEC],
  );
});

test("extractCitations: strips backticks and trailing punctuation, and reads bare inline ids", () => {
  assert.deepEqual(extractCitations(`scope widened in \`${AUD}\`.`), [AUD]);
  assert.deepEqual(extractCitations(`see (${DEC}) and [${INC}]`), [DEC, INC]);
  assert.deepEqual(
    extractCitations(`observed twice: ${AUD} then ${AUD} again || ${AUD}`),
    [AUD],
    "duplicates collapse, order preserved",
  );
});

test("extractCitations: prose that merely contains a record-kind word is not a citation", () => {
  // idKind() reads everything before the first underscore, so a bare word
  // like "inc" would resolve to the incident kind. Requiring
  // <prefix>_<body> is what keeps free-text scanning honest.
  assert.deepEqual(extractCitations("the inc was closed and the dec stood"), []);
  assert.deepEqual(extractCitations("no citation here at all"), []);
  assert.deepEqual(extractCitations("candidate memories, each as <session entry ids>"), []);
});

/* --- condition 3: citations must name a real session entry -------- */

test("evidence gate: a complete read with every item cited is accepted", () => {
  const { acceptance, filtered } = checkReviewEvidence(proposals(), SESSION_IDS, COMPLETE_READ);
  assert.equal(acceptance.accepted, true);
  assert.equal(acceptance.readComplete, true);
  assert.equal(acceptance.shapeValid, true);
  assert.equal(acceptance.citationsValid, true);
  assert.deepEqual(acceptance.rejectedItems, []);
  assert.equal(acceptance.linesExpected, 412);
  assert.equal(acceptance.linesRead, 412);
  assert.match(acceptance.reason, /grounded/);
  assert.deepEqual(filtered, proposals(), "nothing is dropped from an accepted review");
});

/* --- precondition: the reviewer actually produced output ----------- */

test("evidence gate: an empty reviewer reply is refused, not accepted as a review of nothing", () => {
  // The defect the first live packaged run exposed: a reasoning model spent
  // its whole output budget thinking and stopped on `length` having emitted no
  // text. The empty reply parsed to zero proposals, which passes shape, passes
  // citations (nothing to cite) and passes the read - and the review was
  // accepted. An empty answer is "the reviewer said nothing", never "the
  // reviewer found nothing"; the gate must tell them apart.
  const empty = parseReviewProposals("");
  const { acceptance } = checkReviewEvidence(empty, SESSION_IDS, COMPLETE_READ, "");
  assert.equal(acceptance.reviewProduced, false);
  assert.equal(acceptance.accepted, false, "an empty reply is not an accepted review");
  assert.equal(acceptance.readComplete, true, "the read itself was fine");
  assert.equal(acceptance.shapeValid, true, "empty is a well-formed shape");
  assert.equal(acceptance.citationsValid, true, "there was nothing to cite");
  assert.match(acceptance.reason, /produced no output/);
});

test("evidence gate: a whitespace-only reviewer reply is refused", () => {
  const { acceptance } = checkReviewEvidence(
    parseReviewProposals("   \n\t  "),
    SESSION_IDS,
    COMPLETE_READ,
    "   \n\t  ",
  );
  assert.equal(acceptance.reviewProduced, false);
  assert.equal(acceptance.accepted, false);
});

test("evidence gate: a non-blank reply that proposes nothing is a legitimate empty review", () => {
  // The other side of the line. A reviewer that read the whole session and
  // genuinely had nothing durable to promote still *answered*. That must be
  // accepted - the precondition is "did the reviewer speak", not "did it find
  // something".
  const prose = "I read the full session. Nothing here rises to a durable lesson.";
  const { acceptance } = checkReviewEvidence(
    parseReviewProposals(prose),
    SESSION_IDS,
    COMPLETE_READ,
    prose,
  );
  assert.equal(acceptance.reviewProduced, true);
  assert.equal(acceptance.accepted, true, "the reviewer answered; it simply had nothing to promote");
});

test("evidence gate: omitting the raw reply leaves the produced-output precondition satisfied", () => {
  // Callers exercising the citation logic directly (these tests, and the
  // corpus smoke) have no reply text to offer. Omitting it must not turn the
  // precondition into a silent rejection of an otherwise-valid review.
  const { acceptance } = checkReviewEvidence(proposals(), SESSION_IDS, COMPLETE_READ);
  assert.equal(acceptance.reviewProduced, true);
  assert.equal(acceptance.accepted, true);
});

test("evidence gate: an item citing an id that never occurred in the session is refused", () => {
  // The whole point of condition 3. `FABRICATED` passes idKind() and is
  // indistinguishable from a real id by shape alone; only membership in the
  // session's entry ids separates "cites a source" from "cites a source that
  // exists".
  const invented = `the reviewer decided the cache is coherent || ${FABRICATED}`;
  const { acceptance, filtered } = checkReviewEvidence(
    proposals({ findings: [invented] }),
    SESSION_IDS,
    COMPLETE_READ,
  );
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.citationsValid, false);
  assert.equal(acceptance.readComplete, true, "the read itself was fine");
  assert.equal(acceptance.shapeValid, true, "the shape itself was fine");
  assert.deepEqual(filtered.findings, [], "the ungrounded finding does not survive");
  assert.deepEqual(acceptance.rejectedItems, [invented]);
  // Sanity check that the fabricated id is only failing on existence: it is
  // a well-formed id, so the refusal is not an accident of shape.
  assert.deepEqual(extractCitations(invented), [FABRICATED]);
});

test("evidence gate: an item with no citation at all is refused", () => {
  const uncited = "everything looked fine to me";
  const { acceptance, filtered } = checkReviewEvidence(
    proposals({ patterns: [uncited] }),
    SESSION_IDS,
    COMPLETE_READ,
  );
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.citationsValid, false);
  assert.deepEqual(filtered.patterns, []);
  assert.deepEqual(acceptance.rejectedItems, [uncited]);
});

test("evidence gate: the rule covers every item class, not just memory candidates", () => {
  // v0.1 checked citations on MEMORY alone. Each of these sections must now
  // reject an uncited item on its own.
  const classes: Array<keyof ReviewProposals> = [
    "findings",
    "patterns",
    "mistakes",
    "userPreferences",
    "modelSpecificGuidance",
    "projectLessons",
    "unresolvedIssues",
  ];
  for (const field of classes) {
    const { acceptance } = checkReviewEvidence(
      proposals({ [field]: ["an assertion with no source"] } as Partial<ReviewProposals>),
      SESSION_IDS,
      COMPLETE_READ,
    );
    assert.equal(acceptance.accepted, false, `${field} must require a citation`);
    assert.deepEqual(acceptance.rejectedItems, ["an assertion with no source"]);
  }
});

test("evidence gate: a memory candidate whose sources are invented is refused, content kept verbatim", () => {
  const { acceptance, filtered } = checkReviewEvidence(
    proposals({
      memoryCandidates: [
        { content: "the cache is coherent", sources: [FABRICATED] },
        { content: "no source at all", sources: [] },
        { content: "genuinely grounded", sources: [DEC] },
      ],
    }),
    SESSION_IDS,
    COMPLETE_READ,
  );
  assert.equal(acceptance.accepted, false);
  assert.deepEqual(filtered.memoryCandidates, [
    { content: "genuinely grounded", sources: [DEC] },
  ]);
  assert.deepEqual(acceptance.rejectedItems, ["the cache is coherent", "no source at all"]);
});

test("evidence gate: rejectedItems preserves the dropped text verbatim", () => {
  // The reviewer's ungrounded assertion is still information about the
  // reviewer. It must come back byte-for-byte, not summarised or trimmed.
  const raw = "  the *sandbox* is definitely safe now -- trust me || not-an-id  ";
  const { acceptance, filtered } = checkReviewEvidence(
    proposals({ projectLessons: [raw] }),
    SESSION_IDS,
    COMPLETE_READ,
  );
  assert.deepEqual(acceptance.rejectedItems, [raw]);
  assert.equal(acceptance.rejectedItems[0], raw);
  assert.deepEqual(filtered.projectLessons, []);
});

/* --- condition 1: the read must have been complete ---------------- */

test("evidence gate: a short read refuses the review even when every citation is perfect", () => {
  const { acceptance, filtered } = checkReviewEvidence(proposals(), SESSION_IDS, {
    linesExpected: 412,
    linesRead: 40,
  });
  assert.equal(acceptance.accepted, false, "a partial reading is not a review of the session");
  assert.equal(acceptance.readComplete, false);
  assert.equal(acceptance.citationsValid, true, "citations were fine; the read was not");
  assert.equal(acceptance.shapeValid, true);
  assert.deepEqual(acceptance.rejectedItems, []);
  assert.equal(acceptance.linesRead, 40);
  assert.equal(acceptance.linesExpected, 412);
  assert.match(acceptance.reason, /short read: 40 of 412/);
  assert.deepEqual(filtered, proposals(), "the items are still returned, the review is not accepted");
});

test("evidence gate: reading zero lines is not a complete read of zero lines", () => {
  // A reader that failed to open the session file reports 0/0. Equality
  // alone would certify a review of nothing.
  const { acceptance } = checkReviewEvidence(proposals(), SESSION_IDS, {
    linesExpected: 0,
    linesRead: 0,
  });
  assert.equal(acceptance.readComplete, false);
  assert.equal(acceptance.accepted, false);
  assert.match(acceptance.reason, /no session lines were retrieved/);
});

test("evidence gate: a read longer than expected is not treated as complete", () => {
  const { acceptance } = checkReviewEvidence(proposals(), SESSION_IDS, {
    linesExpected: 412,
    linesRead: 500,
  });
  assert.equal(acceptance.readComplete, false);
  assert.equal(acceptance.accepted, false);
});

/* --- the three conditions are reported separately ----------------- */

test("evidence gate: malformed output fails the shape check and promotes nothing", () => {
  const malformed = { findings: "not an array" } as unknown as ReviewProposals;
  const { acceptance, filtered } = checkReviewEvidence(malformed, SESSION_IDS, COMPLETE_READ);
  assert.equal(acceptance.shapeValid, false);
  assert.equal(acceptance.accepted, false);
  assert.equal(acceptance.citationsValid, false, "citations could not be established");
  assert.match(acceptance.reason, /shape validation/);
  // Even a caller that ignores `accepted` cannot promote anything.
  assert.deepEqual(filtered, {
    findings: [],
    patterns: [],
    mistakes: [],
    userPreferences: [],
    modelSpecificGuidance: [],
    projectLessons: [],
    unresolvedIssues: [],
    memoryCandidates: [],
  });
});

test("evidence gate: a short read and a bad citation are reported as two distinct failures", () => {
  const { acceptance } = checkReviewEvidence(
    proposals({ findings: [`invented || ${FABRICATED}`] }),
    SESSION_IDS,
    { linesExpected: 10, linesRead: 3 },
  );
  assert.equal(acceptance.readComplete, false);
  assert.equal(acceptance.citationsValid, false);
  assert.match(acceptance.reason, /short read/);
  assert.match(acceptance.reason, /1 item\(s\) cited no entry id/);
});

/* --- end to end with the parser ----------------------------------- */

test("evidence gate: the parser feeds the gate; the parser does not enforce the gate", () => {
  // parseReviewProposals is the parser and checkReviewEvidence is the policy.
  // The parser still returns the ungrounded finding - a parser that silently
  // dropped it would be a policy nobody could find - and the gate is what
  // refuses it.
  const parsed = parseReviewProposals(
    [
      "FINDINGS:",
      `- the sandbox refuses without bwrap || ${AUD}`,
      "- and I think the cache is coherent",
      "MEMORY:",
      `- the user prefers pkexec over sudo || \`${DEC}\``,
    ].join("\n"),
  );
  assert.equal(parsed.findings.length, 2, "the parser reports what the reviewer wrote");

  const { acceptance, filtered } = checkReviewEvidence(parsed, SESSION_IDS, COMPLETE_READ);
  assert.equal(acceptance.accepted, false);
  assert.deepEqual(filtered.findings, [`the sandbox refuses without bwrap || ${AUD}`]);
  assert.deepEqual(acceptance.rejectedItems, ["and I think the cache is coherent"]);
  assert.deepEqual(filtered.memoryCandidates, [
    { content: "the user prefers pkexec over sudo", sources: [DEC] },
  ]);
});

/* --- lone "nothing to report" placeholder is an empty section ------ */
/* Measured (VALIDATION §12): the dominant citation-gate rejection was a
 * model writing a "none"-class placeholder into an otherwise-empty section,
 * which the parser then counted as one uncited item and, under M5
 * all-or-nothing, used to sink the whole review. parseReviewProposals now
 * drops a *lone* placeholder so the section reads as empty. The three cases
 * that fix must satisfy - and the classifier it rests on - are pinned here. */

test("placeholder: a section whose only line is a 'none'-class placeholder parses to empty", () => {
  const parsed = parseReviewProposals(
    [
      "FINDINGS:",
      `- the sandbox refuses without bwrap || ${AUD}`,
      "MISTAKES:",
      "- None observed.",
    ].join("\n"),
  );
  assert.deepEqual(parsed.mistakes, [], "the lone placeholder is not counted as an item");
  assert.equal(parsed.findings.length, 1, "real sections are untouched");

  // With the empty section gone, a fully-cited review is accepted rather than
  // being sunk by a placeholder nobody could cite.
  const { acceptance, filtered } = checkReviewEvidence(parsed, SESSION_IDS, COMPLETE_READ);
  assert.equal(acceptance.accepted, true);
  assert.deepEqual(acceptance.rejectedItems, [], "no placeholder survives to be rejected");
  assert.deepEqual(filtered.mistakes, []);
});

test("placeholder: alongside a real item the placeholder stays an item and (uncited) rejects", () => {
  // Scope guard: the collapse fires only when the placeholder is ALONE. Here it
  // shares the section with a real cited item, so it cannot hide - it stays an
  // item and, being uncited, still sinks the review.
  const parsed = parseReviewProposals(
    [
      "MISTAKES:",
      `- scope was widened without approval (cause: model) || ${INC}`,
      "- None observed.",
    ].join("\n"),
  );
  assert.equal(parsed.mistakes.length, 2, "the placeholder is not dropped when it is not alone");

  const { acceptance, filtered } = checkReviewEvidence(parsed, SESSION_IDS, COMPLETE_READ);
  assert.equal(acceptance.accepted, false);
  assert.deepEqual(
    filtered.mistakes,
    [`scope was widened without approval (cause: model) || ${INC}`],
    "the cited item survives",
  );
  assert.deepEqual(acceptance.rejectedItems, ["None observed."], "the placeholder rejects as uncited");
});

test("placeholder: a lone genuine uncited fact is not a placeholder - it stays an item and rejects", () => {
  // The gate keeps its teeth: a real observation that simply lacks a citation is
  // not a "nothing to report" declaration, so it is not collapsed and still sinks
  // the review.
  const parsed = parseReviewProposals(
    ["MISTAKES:", "- scope was widened without approval (cause: model)"].join("\n"),
  );
  assert.equal(parsed.mistakes.length, 1, "a genuine fact is still an item");

  const { acceptance } = checkReviewEvidence(parsed, SESSION_IDS, COMPLETE_READ);
  assert.equal(acceptance.accepted, false);
  assert.deepEqual(acceptance.rejectedItems, ["scope was widened without approval (cause: model)"]);
});

test("isEmptySectionPlaceholder: emptiness declarations are placeholders", () => {
  for (const s of [
    "",
    "   ",
    "_none_",
    "none",
    "None.",
    "None observed.",
    "None identified in this session.",
    "No guidance corrections needed",
    "no issues found",
    "Nothing to report.",
    "N/A",
    "n/a",
    "nil",
    "-",
    "—",
    "TBD",
    "not applicable",
    // markdown-emphasized placeholders (VALIDATION §12 third addendum: qwen #4)
    "_None observed_",
    "_None observed_.",
    "*none*",
    "**None**",
    "*Nothing to report.*",
  ]) {
    assert.equal(isEmptySectionPlaceholder(s), true, `expected placeholder: ${JSON.stringify(s)}`);
  }
});

test("isEmptySectionPlaceholder: substantive claims are NOT placeholders", () => {
  for (const s of [
    "none of the tools were denied",
    "None were denied this session",
    "the user prefers pkexec over sudo",
    "scope was widened without approval (cause: model)",
    "no-build documented for test_output",
    // emphasis stripping must not turn a substantive claim into a placeholder
    "*none of the tools were denied*",
    "_the retry count is 3_",
  ]) {
    assert.equal(isEmptySectionPlaceholder(s), false, `expected substantive: ${JSON.stringify(s)}`);
  }
});

test("placeholder: a lone underscore-wrapped '_None observed_' section parses to empty", () => {
  // The exact qwen #4 shape from VALIDATION §12 third addendum: markdown-italic
  // placeholders that the first cut of the classifier missed.
  const parsed = parseReviewProposals(
    [
      "FINDINGS:",
      `- the sandbox refuses without bwrap || ${AUD}`,
      "MODELGUIDANCE:",
      "- _None observed_",
      "UNRESOLVED:",
      "- _None observed_",
    ].join("\n"),
  );
  assert.deepEqual(parsed.modelSpecificGuidance, []);
  assert.deepEqual(parsed.unresolvedIssues, []);

  const { acceptance } = checkReviewEvidence(parsed, SESSION_IDS, COMPLETE_READ);
  assert.equal(acceptance.accepted, true, "no underscore-wrapped placeholder survives to reject");
  assert.deepEqual(acceptance.rejectedItems, []);
});

/* --- generations --------------------------------------------------- */

test("nextReviewGeneration: 1-based, max + 1, never an overwrite", () => {
  assert.equal(nextReviewGeneration([]), 1);
  assert.equal(nextReviewGeneration([1]), 2);
  assert.equal(nextReviewGeneration([1, 2, 3]), 4);
  assert.equal(nextReviewGeneration([3, 1, 2]), 4, "order of the listing does not matter");
  assert.equal(nextReviewGeneration([7]), 8, "a gap is not filled in - history is not renumbered");
});

test("nextReviewGeneration: junk in the directory listing cannot steer a write onto generation 1", () => {
  assert.equal(nextReviewGeneration([Number.NaN]), 1);
  assert.equal(nextReviewGeneration([0, -3]), 1);
  assert.equal(nextReviewGeneration([2, Number.NaN, 1.5, 0]), 3);
});

/* --- the prompt states the rule it will be judged by --------------- */

test("renderReviewPrompt: a citation is demanded on every item class, not only on MEMORY", () => {
  const prompt = renderReviewPrompt("ENTRY 1\nENTRY 2", ["the user prefers pkexec"]);
  assert.match(prompt, /Every item in every section/);
  for (const section of [
    "findings",
    "patterns",
    "mistakes",
    "preferences",
    "model guidance",
    "lessons",
    "unresolved questions",
    "memory candidates",
  ]) {
    assert.ok(prompt.includes(section), `the citation rule must name ${section}`);
  }
  assert.doesNotMatch(
    prompt,
    /Every MEMORY candidate must cite/,
    "the rule is no longer scoped to memory candidates alone",
  );
});

test("renderReviewPrompt: states plainly that uncited items are dropped", () => {
  const prompt = renderReviewPrompt("ENTRY 1", []);
  assert.match(prompt, /Uncited items are dropped/);
  assert.match(prompt, /checked against/, "the reviewer is told its citations are verified");
});

test("renderReviewPrompt: still carries the transcript and existing memory", () => {
  const prompt = renderReviewPrompt("ENTRY 1\nENTRY 2", ["the user prefers pkexec"]);
  assert.match(prompt, /ENTRY 1\nENTRY 2/);
  assert.match(prompt, /- the user prefers pkexec/);
  assert.match(renderReviewPrompt("ENTRY 1", []), /_none_/);
});
