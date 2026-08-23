/**
 * Pi Harness - advisors, bounded subagents, and retrospective reviewers
 * (spec sections 6.2, 6.3, 7; invariants SA1-SA5, MO4, MO5).
 *
 * Pure. This module builds delegation contracts, renders them into prompts,
 * and parses handoffs back. It never spawns anything: execution is injected
 * as a `DelegateRunner` by the extension, which is what lets the authority
 * rules below be tested without a model in the loop.
 *
 * The authority rule that matters is SA3, and it is enforced structurally.
 * `buildContract()` takes the *parent's* scope, autonomy, and approval
 * policy, and derives the child's by intersection. There is no parameter
 * through which a caller can hand a child more than the parent had, so a
 * subagent cannot enlarge its own authority even if the code calling it
 * tries to - which is the realistic failure, since the caller is itself
 * often model-driven.
 *
 * MO5 is enforced by the same shape: an advisor's contract fixes
 * `kind: "advisor"` with read-only capabilities, and there is no transition
 * from an advisor contract to a coordinator role. An advisor's output comes
 * back as a `Handoff` - evidence and recommendation (SA4) - and something
 * else has to act on it.
 */

import { inheritApprovalPolicy, inheritAutonomy } from "./policy.ts";
import { narrowScope, type PathOps } from "./scope.ts";
import {
  HARNESS_SCHEMA_VERSION,
  type Actor,
  type ApprovalPolicy,
  type AutonomyMode,
  type DelegateKind,
  type DelegationContract,
  type Handoff,
  type ModelConfiguration,
  type ReviewAcceptance,
  type ScopeState,
} from "./types.ts";
import { idKind, makeId, nowIso, type Clock, type RandomSource } from "./util.ts";

/**
 * Capabilities each delegate kind may ever be granted. Intersected with the
 * requested list, so asking for more yields less rather than an error - and
 * the difference between requested and granted is recorded on the contract
 * for the audit trail.
 *
 * MVP subagents are read-only (spec section 26 "deferred": write-capable
 * subagents wait until write isolation is independently proven).
 */
const KIND_CAPABILITIES: Record<DelegateKind, ReadonlySet<string>> = {
  advisor: new Set(["read", "grep", "find", "ls", "scoped_read", "scoped_list", "request_read_scope"]),
  subagent: new Set([
    "read", "grep", "find", "ls", "local_web_search",
    "scoped_read", "scoped_list", "request_read_scope",
  ]),
  reviewer: new Set(["read", "grep", "find", "ls"]),
  // An operator holds the read tools plus scoped_exec: a single tool that runs
  // a command inside an OS-level sandbox whose only writable path is the
  // operator's own narrowed scope root. scoped_exec is deliberately absent from
  // every other kind's set, so exec is impossible for advisor/subagent/reviewer
  // and cannot be acquired by asking. The child never gets the coordinator's
  // pi_harness_bash; scoped_exec is its only execution surface.
  operator: new Set([
    "read", "grep", "find", "ls",
    "scoped_read", "scoped_list", "request_read_scope", "scoped_exec",
  ]),
};

export interface DelegationRequest {
  kind: DelegateKind;
  objective: string;
  /** Requested subdirectory of the parent scope. Omit to inherit the parent
   * scope unchanged (still narrowed to a non-expanding copy). */
  scopeTarget?: string;
  requestedCapabilities: string[];
  requestedAutonomy?: AutonomyMode;
  requestedApprovalPolicy?: ApprovalPolicy;
  /** Minimum necessary context (SA2). The caller assembles this; the
   * contract records exactly what was shared. */
  contextPackage: string[];
  expectedOutput: string;
}

export interface ParentAuthority {
  session: string;
  actor: Actor;
  scope: ScopeState;
  autonomy: AutonomyMode;
  approvalPolicy: ApprovalPolicy;
  cwd: string;
}

export type ContractOutcome =
  | { ok: true; contract: DelegationContract; droppedCapabilities: string[] }
  | { ok: false; reason: string; rule: string };

/**
 * Build a delegation contract (spec section 7).
 *
 * Every field of the spec's contract block is populated - objective, scope,
 * allowed capabilities, autonomy, approval policy, context package, expected
 * output, escalation behavior - because SA1 says every subagent has one, and
 * a contract with a blank field is a contract with an unstated default.
 */
export function buildContract(
  parent: ParentAuthority,
  request: DelegationRequest,
  ops: PathOps,
  clock: Clock = () => new Date(),
  random?: RandomSource,
): ContractOutcome {
  if (request.objective.trim().length === 0) {
    return { ok: false, reason: "a delegation needs an objective", rule: "SA1" };
  }

  // Scope: a strict subset of the parent's, never a sibling or a superset.
  const childScope =
    request.scopeTarget === undefined
      ? narrowScope(parent.scope, parent.scope.root, parent.cwd, ops, parent.actor, clock)
      : narrowScope(parent.scope, request.scopeTarget, parent.cwd, ops, parent.actor, clock);
  if (childScope === null) {
    return {
      ok: false,
      reason: `requested delegate scope is not inside the parent scope: ${request.scopeTarget ?? parent.scope.root}`,
      rule: "SA3",
    };
  }

  const permitted = KIND_CAPABILITIES[request.kind];
  const granted = request.requestedCapabilities.filter((capability) => permitted.has(capability));
  const dropped = request.requestedCapabilities.filter((capability) => !permitted.has(capability));

  return {
    ok: true,
    contract: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      id: makeId("delegation", random),
      kind: request.kind,
      objective: request.objective.trim(),
      scope: childScope,
      allowedCapabilities: granted.sort(),
      // Intersection with the parent in both directions (SA3, SA5).
      autonomy: inheritAutonomy(parent.autonomy, request.requestedAutonomy ?? "interactive"),
      approvalPolicy: inheritApprovalPolicy(
        parent.approvalPolicy,
        request.requestedApprovalPolicy ?? "all-actions",
      ),
      contextPackage: request.contextPackage,
      expectedOutput: request.expectedOutput,
      escalationBehavior:
        "If blocked, stop and return the exact request in `blockedRequest`. Do not wait silently, and do not work around the boundary.",
      parentSession: parent.session,
      parentActor: parent.actor,
      createdAt: nowIso(clock),
    },
    droppedCapabilities: dropped,
  };
}

/* ------------------------------------------------------------------ *
 * Prompting and handoff parsing
 * ------------------------------------------------------------------ */

const HANDOFF_SECTIONS = [
  "CONCLUSION",
  "EVIDENCE",
  "ASSUMPTIONS",
  "UNRESOLVED",
  "RECOMMENDED",
  "BLOCKED",
] as const;

/**
 * Render the contract as the delegate's instructions.
 *
 * The handoff format is stated as required output rather than requested,
 * and the escalation rule is repeated in the body. Both matter because the
 * parse below is deterministic: a delegate that free-forms its answer
 * produces a handoff with an empty conclusion, which the caller surfaces as
 * a failed delegation rather than as a result.
 */
export function renderContractPrompt(contract: DelegationContract): string {
  return [
    `You are a bounded ${contract.kind} operating under a delegation contract from Pi.`,
    "",
    "## Contract",
    "",
    `Objective: ${contract.objective}`,
    `Scope: ${contract.scope.allowedRoots.join(", ")}`,
    `Allowed capabilities: ${contract.allowedCapabilities.join(", ") || "(none)"}`,
    `Autonomy: ${contract.autonomy}`,
    `Approval policy: ${contract.approvalPolicy}`,
    `Expected output: ${contract.expectedOutput}`,
    "",
    "## Boundaries",
    "",
    "- You may not act outside the scope above, and you may not enlarge it.",
    contract.allowedCapabilities.includes("scoped_exec")
      ? "- You may run commands only through scoped_exec, which runs each command in an OS-level sandbox whose one writable path is your scope root; the command is refused if it would reach outside your scope or if the sandbox is unavailable. You have no other way to act."
      : "- You may not modify files. Your output is evidence and recommendation; the parent decides what to act on.",
    `- ${contract.escalationBehavior}`,
    "",
    "## Context provided",
    "",
    contract.contextPackage.length > 0
      ? contract.contextPackage.map((item) => `- ${item}`).join("\n")
      : "_none_",
    "",
    "## Required response format",
    "",
    "Reply with exactly these sections, each on its own line prefixed as shown:",
    "",
    "CONCLUSION: <one paragraph>",
    "EVIDENCE: <one item per line, prefixed with `- `>",
    "ASSUMPTIONS: <one item per line, prefixed with `- `>",
    "UNRESOLVED: <one item per line, prefixed with `- `>",
    "RECOMMENDED: <one item per line, prefixed with `- `>",
    "BLOCKED: <the exact authority you needed and did not have, or `none`>",
    "",
    "Separate what you observed from what you inferred. An inference stated as an observation is a failed handoff.",
  ].join("\n");
}

/**
 * Parse a delegate's reply into a `Handoff`.
 *
 * Missing sections become empty lists rather than throwing: a partial
 * handoff is still evidence, and the caller can see it is partial because
 * `conclusion` is empty. Throwing here would discard a delegate's entire
 * output over a formatting slip.
 */
export function parseHandoff(raw: string): Handoff {
  const sections = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z]+)\s*:\s*(.*)$/);
    if (match && (HANDOFF_SECTIONS as readonly string[]).includes(match[1])) {
      current = match[1];
      sections.set(current, []);
      const inline = match[2].trim();
      if (inline.length > 0) sections.get(current)!.push(inline);
      continue;
    }
    if (current === null) continue;
    const item = line.replace(/^\s*[-*]\s+/, "").trim();
    if (item.length > 0) sections.get(current)!.push(item);
  }

  const get = (key: string): string[] => sections.get(key) ?? [];
  const blocked = get("BLOCKED").join(" ").trim();

  return {
    conclusion: get("CONCLUSION").join(" ").trim(),
    evidence: get("EVIDENCE"),
    assumptions: get("ASSUMPTIONS"),
    unresolvedQuestions: get("UNRESOLVED"),
    recommendedActions: get("RECOMMENDED"),
    // "none" is the documented way to say nothing blocked; treat the empty
    // string the same way rather than reporting a block with no content.
    blockedRequest: blocked.length === 0 || blocked.toLowerCase() === "none" ? null : blocked,
  };
}

/** Injected executor. The extension supplies one backed by Pi's
 * `createAgentSession`; tests supply one that returns a canned string. */
export type DelegateRunner = (
  contract: DelegationContract,
  prompt: string,
) => Promise<{ text: string; model: ModelConfiguration | null }>;

export interface DelegationResult {
  contract: DelegationContract;
  handoff: Handoff;
  /** Recorded for MO4: which model produced this reading is evidence. */
  model: ModelConfiguration | null;
}

export async function runDelegate(
  contract: DelegationContract,
  run: DelegateRunner,
): Promise<DelegationResult> {
  const prompt = renderContractPrompt(contract);
  const { text, model } = await run(contract, prompt);
  return { contract, handoff: parseHandoff(text), model };
}

/* ------------------------------------------------------------------ *
 * Retrospective review (spec section 6.3)
 * ------------------------------------------------------------------ */

/**
 * A reviewer's proposals. Deliberately *proposals*: MVP stores them for
 * human promotion rather than applying them (spec section 6.4), and the type
 * says so, so nothing downstream can mistake one for an applied change.
 */
export interface ReviewProposals {
  findings: string[];
  patterns: string[];
  mistakes: string[];
  userPreferences: string[];
  modelSpecificGuidance: string[];
  projectLessons: string[];
  unresolvedIssues: string[];
  /** Candidate durable memories, each of which must carry a citation before
   * memory.ts will accept it (M5). */
  memoryCandidates: Array<{ content: string; sources: string[] }>;
}

export function renderReviewPrompt(sessionTranscript: string, existingMemory: string[]): string {
  return [
    "You are a retrospective reviewer. You are reading a completed Pi session in full.",
    "",
    "You have learning authority and no operational authority. You may not modify project",
    "files, alter policy, or rewrite history. Your output is a set of proposals.",
    "",
    "Extract, in this order:",
    "",
    "FINDINGS: durable facts established during the session",
    "PATTERNS: recurring behavior worth naming",
    "MISTAKES: incidents, with what actually caused each one",
    "PREFERENCES: user preferences evidenced by what the user accepted or rejected",
    "MODELGUIDANCE: corrections specific to the model that ran this session, and to no other",
    "LESSONS: project-specific lessons",
    "UNRESOLVED: questions the session did not answer",
    "MEMORY: candidate durable memories",
    "",
    "Mark each section with its name as a heading - `## FINDINGS` or `FINDINGS:`, either is read -",
    "and write every item in every one of those sections in this form, one per line:",
    "",
    "- <text> || <session entry ids, comma separated>",
    "",
    "Rules:",
    "- Attribute a mistake to a cause (model, user/workflow, tool, environment, policy, mixed, unknown).",
    '  "unknown" is a real answer. A guessed cause is worse than an unattributed one.',
    "- Do not attribute to the model what the workflow caused. If the user's own process contributed,",
    "  say so plainly with the evidence.",
    "- Every item in every section - findings, patterns, mistakes, preferences, model guidance, lessons,",
    "  unresolved questions and memory candidates alike - must cite at least one session entry id it",
    "  came from. An item you cannot trace to an entry is one you did not read; do not write it.",
    "- Cite ids that occur in the transcript below, copied exactly. Every transcript line begins with",
    "  the id of the entry it came from, so the id you need is the first token of the line you are",
    "  citing. Every citation is checked against this session's entries, so an id shaped like an id",
    "  but not present in the session counts as no citation at all. Do not copy the placeholder above.",
    "- Uncited items are dropped. They are recorded verbatim as rejected so a human can see what you",
    "  tried to assert, but they do not become findings, lessons, or memory.",
    "- Leave a section empty when it has nothing to report: omit the section entirely, or write its",
    "  heading with no items beneath it. Never write a placeholder line such as \"none\", \"_none_\",",
    "  \"None observed\", \"no corrections needed\", or \"N/A\". A placeholder cites no source, is counted",
    "  as an uncited item, and a single uncited item rejects the whole review. An empty section is",
    "  correct and expected; a placeholder is an error.",
    "- Do not convert speculation into fact.",
    "",
    "## Existing durable memory",
    "",
    existingMemory.length > 0 ? existingMemory.map((m) => `- ${m}`).join("\n") : "_none_",
    "",
    "## Session transcript",
    "",
    sessionTranscript,
  ].join("\n");
}

/**
 * Ornamentation models put around an id: code backticks, quotes, and the
 * sentence punctuation that follows an id at the end of a clause. Stripped
 * before `idKind()` ever sees the token, because a reviewer that writes
 * `` `aud_1`, `` is still citing aud_1 and refusing that citation would push
 * the reviewer toward asserting things uncited instead.
 *
 * Shared by the parser and by `extractCitations()` so the two cannot drift:
 * an id the parser accepts and the evidence gate does not would look, from
 * the outside, exactly like a fabricated citation.
 */
const ID_DECORATION = /^[`'"]+|[`'".,]+$/g;

function stripIdDecoration(token: string): string {
  return token.replace(ID_DECORATION, "");
}

const REVIEW_KEYS: Array<[keyof ReviewProposals | "MEMORY", string]> = [
  ["findings", "FINDINGS"],
  ["patterns", "PATTERNS"],
  ["mistakes", "MISTAKES"],
  ["userPreferences", "PREFERENCES"],
  ["modelSpecificGuidance", "MODELGUIDANCE"],
  ["projectLessons", "LESSONS"],
  ["unresolvedIssues", "UNRESOLVED"],
];

/**
 * Remove the prompt from a reply that contains it.
 *
 * Not a heuristic: the caller knows the exact string it sent, so this is an
 * equality test, and a reply that merely resembles the prompt is left alone.
 *
 * Two things produce an echoed prompt. A nested session's `message_end`
 * fires for the prompt as well as the answer, so a collector without a role
 * filter returns both - that is fixed at the source, and this is the second
 * line of defence. And some models simply restate their instructions before
 * answering, which nothing at the source can prevent.
 *
 * It matters because the reviewer prompt contains the literal section
 * headers the parser looks for, each followed by a description of what the
 * section is for. Parsed, those descriptions become eight proposals that
 * cite nothing, and condition 3 is all-or-nothing: the whole review is then
 * rejected, including the model's real and correctly cited items. Observed
 * on the first live run of the gate - 24 phantom items, none of them the
 * reviewer's fault.
 */
/**
 * A section heading in a reviewer's reply.
 *
 * The prompt names the sections in capitals and says nothing about how to
 * mark them, so a model marks them however it marks headings. The first live
 * reviewer wrote `## FINDINGS`; the parser accepted only `FINDINGS:`, so the
 * model's entire answer was silently invisible and the only things parsed
 * were the prompt's own `FINDINGS: durable facts...` lines echoed back. The
 * review was rejected for citing nothing while its real items sat unread in
 * the same string.
 *
 * Recognising the markdown forms is not a loosening of the evidence
 * contract. Parsing decides what the reviewer *said*; `checkReviewEvidence`
 * decides what is accepted, and every item found here still has to cite an
 * id from the session.
 *
 * Groups: 1 = leading hashes, 2 = asterisks, 3 = the name, 4 = colon,
 * 5 = anything on the same line after it.
 */
const HEADING_LINE = /^\s*(#{1,6}\s*)?(\*{0,2})([A-Z]+)\2\s*(:)?\s*(.*)$/;

/**
 * Is this really a heading, or a sentence that starts with a capitalised
 * word that happens to be one?
 *
 * Something has to mark it: a leading `#`, surrounding `**`, a colon, or
 * nothing following it on the line. Without this, "MEMORY leak in the
 * parser" would open the MEMORY section and donate its own tail as the
 * first item.
 */
function isHeading(match: RegExpMatchArray): boolean {
  const [, hashes, stars, , colon, rest] = match;
  return Boolean(hashes) || stars.length > 0 || Boolean(colon) || rest.trim().length === 0;
}

export function stripEchoedPrompt(reply: string, prompt: string): string {
  const needle = prompt.trim();
  if (needle.length === 0) return reply;
  const at = reply.indexOf(needle);
  if (at === -1) return reply;
  return (reply.slice(0, at) + reply.slice(at + needle.length)).trim();
}

/**
 * Whether a line is a bare "this section has nothing to report" placeholder
 * rather than a substantive item. Measured (VALIDATION §12): models emit these -
 * `_none_`, "None observed.", "No guidance corrections needed", "None identified
 * in this session." - into empty sections, and each becomes an uncited item that
 * sinks the whole review. This recognizes the emptiness declaration so a *lone*
 * one can be treated as an empty section (see parseReviewProposals).
 *
 * Deliberately narrow: "none of/none were/none was/…" are substantive claims and
 * are NOT placeholders, and an "no <x> …" line only counts when it declares
 * absence (needed/observed/identified/…). A genuine uncited fact must still read
 * as an item and still reject.
 */
export function isEmptySectionPlaceholder(content: string): boolean {
  // Strip surrounding markdown emphasis (_italic_, *italic*, **bold**) before
  // classifying: measured (VALIDATION §12 third addendum) models write the
  // placeholder emphasized - `_None observed_` - which is semantically identical
  // to the bare form. `_`/`*` only; `-` and `—` are themselves placeholders and
  // must survive. Leading emphasis is dropped, trailing emphasis folds in with
  // the sentence-punctuation strip.
  const c = content
    .trim()
    .replace(/^[_*]+/u, "")
    .replace(/[_*.…\s]+$/u, "")
    .trim()
    .toLowerCase();
  if (c.length === 0) return true;
  if (["_none_", "none", "n/a", "na", "nil", "-", "—", "tbd", "not applicable"].includes(c)) return true;
  if (/^none\b/.test(c) && !/^none (of|were|was|are|is|had|have|has|will|would|remain)\b/.test(c)) return true;
  if (/^no\b.*\b(needed|observed|identified|found|required|to report|applicable|noted|detected)\b/.test(c)) return true;
  if (/^nothing\b/.test(c)) return true;
  return false;
}

export function parseReviewProposals(raw: string): ReviewProposals {
  const headings = new Set([...REVIEW_KEYS.map(([, key]) => key), "MEMORY"]);
  const sections = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of raw.split("\n")) {
    const match = line.match(HEADING_LINE);
    if (match && headings.has(match[3]) && isHeading(match)) {
      current = match[3];
      sections.set(current, []);
      const inline = match[5].trim();
      if (inline.length > 0) sections.get(current)!.push(inline);
      continue;
    }
    if (current === null) continue;
    const item = line.replace(/^\s*[-*]\s+/, "").trim();
    if (item.length > 0) sections.get(current)!.push(item);
  }

  // A section whose ONLY line is a "nothing to report" placeholder is an empty
  // section, not an item (VALIDATION §12). Scope is deliberately tight so the
  // gate keeps its teeth: this fires only when the placeholder is alone -
  // a placeholder alongside real items stays an item (a model cannot hide an
  // uncited claim behind one), and a lone genuine uncited fact is not a
  // placeholder, so it still reads as an item and still rejects. The citation
  // check and M5 all-or-nothing are untouched; this only changes what counts as
  // an item in the first place.
  for (const [key, items] of sections) {
    if (items.length === 1 && isEmptySectionPlaceholder(items[0].split("||")[0])) {
      sections.set(key, []);
    }
  }

  const proposals: ReviewProposals = {
    findings: [],
    patterns: [],
    mistakes: [],
    userPreferences: [],
    modelSpecificGuidance: [],
    projectLessons: [],
    unresolvedIssues: [],
    memoryCandidates: [],
  };
  for (const [field, heading] of REVIEW_KEYS) {
    (proposals[field as Exclude<keyof ReviewProposals, "memoryCandidates">] as string[]) =
      sections.get(heading) ?? [];
  }

  for (const line of sections.get("MEMORY") ?? []) {
    const [content, sources] = line.split("||");
    // A citation has to be a real record id, not merely a non-empty string.
    //
    // Requiring only "something after the ||" was too weak in practice: a
    // live reviewer echoed the instruction line from the prompt back as a
    // candidate, with the literal placeholder as its citation, and it was
    // promoted to durable memory as a fact. Checking the id against the
    // prefixes util.ts actually issues is what makes M5 mean "this came from
    // somewhere" rather than "this has a non-empty second field".
    //
    // Backticks are stripped first: models routinely format ids as code.
    const sourceList = (sources ?? "")
      .split(",")
      .map((source) => stripIdDecoration(source.trim()))
      .filter((source) => source.length > 0 && idKind(source) !== null);
    // Uncited candidates are dropped here rather than at promotion time, so
    // the reviewer's own output shows what survived (M5).
    if (content.trim().length > 0 && sourceList.length > 0) {
      proposals.memoryCandidates.push({ content: content.trim(), sources: sourceList });
    }
  }

  return proposals;
}

/* ------------------------------------------------------------------ *
 * Retrospective evidence contract (spec section 32)
 * ------------------------------------------------------------------ */

/**
 * Proof that the reviewer was shown the whole session.
 *
 * Two counters rather than a boolean because a short read has to be
 * *attributable*: "the reviewer saw 40 of 412 JSONL lines" is an environment
 * or reader bug someone can go fix, whereas `readComplete: false` on its own
 * is indistinguishable from "nobody checked". The counts are supplied by the
 * caller that ran the fixed session reader - this module never touches the
 * filesystem, so it cannot verify the read itself and does not pretend to.
 */
export interface ReviewReadProof {
  linesExpected: number;
  linesRead: number;
}

const REVIEW_STRING_FIELDS = [
  "findings",
  "patterns",
  "mistakes",
  "userPreferences",
  "modelSpecificGuidance",
  "projectLessons",
  "unresolvedIssues",
] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Condition 2 of the evidence contract: runtime shape validation.
 *
 * This exists because the `ReviewProposals` annotation is not a runtime
 * guarantee anywhere in this package - nothing typechecks it, and the values
 * that reach the gate come from a model reply, a JSON file written by an
 * older build, or another module's `Record<string, unknown>`. A shape the
 * type system believes and the runtime does not is exactly the case this
 * catches.
 *
 * Strict in the direction that matters: every section must be *present* and
 * an array. Defaulting a missing section to `[]` would make a truncated
 * reply indistinguishable from a reviewer that honestly found nothing, and
 * "found nothing" is an acceptable review while "the reply was cut off" is
 * not. Unknown extra keys are tolerated - they are never read, and rejecting
 * them would break the moment a later schema adds a section.
 *
 * Returns null rather than a repaired object: a repaired shape is a guess
 * about what the reviewer meant, and this whole contract exists to stop
 * guesses being recorded as evidence.
 */
export function validateReviewProposals(value: unknown): ReviewProposals | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  for (const field of REVIEW_STRING_FIELDS) {
    if (!isStringArray(record[field])) return null;
  }

  if (!Array.isArray(record.memoryCandidates)) return null;
  for (const candidate of record.memoryCandidates) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return null;
    }
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.content !== "string") return null;
    if (!isStringArray(entry.sources)) return null;
  }

  return value as ReviewProposals;
}

/**
 * Does this token have the shape of an id `makeId()` could have produced?
 *
 * `idKind()` recovers the kind from everything before the first underscore,
 * which is the right rule for a field that is known to hold an id and the
 * wrong rule for a token scraped out of prose: with no underscore at all,
 * the bare English word "inc" resolves to the incident kind, and a sentence
 * mentioning "Acme Inc" would register as a citation. Requiring
 * `<prefix>_<non-empty body>` is what makes scanning free text safe.
 */
function isHarnessCitationCandidate(token: string): boolean {
  const underscore = token.indexOf("_");
  if (underscore <= 0 || underscore === token.length - 1) return false;
  return idKind(token) !== null;
}

/**
 * Does this token have the shape of a *Pi* session entry id?
 *
 * Pi mints entry ids as bare hex - `97a1812d` - and the session header's own
 * id as a uuid. Neither is in the harness's `<prefix>_<body>` namespace, so
 * before this existed every citation to a real session entry was rejected as
 * a fabrication. That was not a stricter gate, it was a broken one: it made
 * the only ids a reviewer of a real session *could* cite unciteable, and the
 * fix to condition 1 would have turned every live review into a rejection.
 *
 * Widening the syntax does not widen the authority. This answers "could this
 * token be an id"; `checkReviewEvidence()` still requires the token to occur
 * in the set of ids this session actually produced, and that set is what
 * makes a citation true. The floor of 8 hex characters is here only so that
 * short hex-looking English ("added", "facade") cannot become a candidate;
 * a longer coincidence would still have to collide exactly with a real id.
 */
const PI_ENTRY_ID = /^(?:[0-9a-f]{8,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

function isCitationCandidate(token: string): boolean {
  return isHarnessCitationCandidate(token) || PI_ENTRY_ID.test(token);
}

/**
 * Characters that separate a citation from its surroundings.
 *
 * Brackets and the `||` pipe are treated as separators rather than as
 * decoration to strip, which keeps `stripIdDecoration()` byte-identical to
 * what `parseReviewProposals()` has always applied while still recovering
 * the id from `(dec_1)` or `[aud_2]`.
 */
const CITATION_SEPARATORS = /[\s,;|()\[\]{}<>]+/;

/**
 * Pull the candidate ids out of one proposal line.
 *
 * Handles both conventions the reviewer actually produces: the prompt's
 * `<text> || <ids>` form, and ids mentioned inline in the prose ("widened in
 * aud_9 without approval"). Scanning the whole line rather than only the
 * right-hand side of `||` means a reviewer that grounds its claim in the
 * sentence still gets credit for it - the contract is about whether the item
 * is traceable, not about whether the model obeyed the layout.
 *
 * Order is preserved and duplicates are collapsed, so the result can be
 * reported to a human as "what this item claims to rest on".
 *
 * This answers only "does this look like an id". Whether the id exists is a
 * separate question, and deliberately so: see `checkReviewEvidence()`.
 */
export function extractCitations(item: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const token of item.split(CITATION_SEPARATORS)) {
    const id = stripIdDecoration(token.trim());
    if (!isCitationCandidate(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    found.push(id);
  }
  return found;
}

function emptyProposals(): ReviewProposals {
  return {
    findings: [],
    patterns: [],
    mistakes: [],
    userPreferences: [],
    modelSpecificGuidance: [],
    projectLessons: [],
    unresolvedIssues: [],
    memoryCandidates: [],
  };
}

/**
 * The evidence gate (spec section 32, "Retrospective evidence contract").
 *
 * Accepts a reviewer's output only if all three conditions hold together:
 *
 *  1. the whole session was actually retrieved through the fixed reader,
 *  2. the structured output passes runtime shape validation, and
 *  3. every item - finding, pattern, mistake, preference, model-guidance
 *     proposal, project lesson, unresolved question and memory candidate -
 *     cites at least one entry id that occurs in *this* session.
 *
 * Condition 3 is checked against `knownEntryIds`, not merely against
 * `idKind()`, and that distinction is the entire point. `idKind()` answers
 * "is this shaped like an id", which a model can satisfy by inventing one;
 * membership in `knownEntryIds` answers "did this session produce it". The
 * v0.1 rule only asked the first question, and only of memory candidates,
 * after a reviewer echoed the prompt's own instruction line back as a
 * candidate citing the literal placeholder and it was promoted as a durable
 * fact. Extending the rule to every item class closes the same hole in the
 * six classes that were never checked.
 *
 * The three conditions are reported separately on the returned
 * `ReviewAcceptance` because the remedies differ and collapsing them would
 * hide which one to apply: a short read is a reader or environment bug, an
 * invalid shape is a prompt or model-output bug, and a missing citation is
 * the reviewer asserting something it did not get from the session.
 *
 * Rejected items are returned verbatim rather than summarised. An uncited
 * claim is still information - it is what this reviewer was inclined to
 * assert without evidence, which is worth seeing - it just is not evidence.
 */
export function checkReviewEvidence(
  proposals: ReviewProposals,
  knownEntryIds: ReadonlySet<string>,
  read: ReviewReadProof,
  rawReply?: string,
): { acceptance: ReviewAcceptance; filtered: ReviewProposals } {
  // Precondition. A reviewer that produced no text at all parses to zero
  // proposals, which passes shape (empty is well-formed), passes citations
  // (nothing to cite), and - if the reader did its job - passes the complete
  // read. All three conditions then certify a review that never happened. This
  // is not hypothetical: the first live packaged run drove a reasoning model
  // whose entire output budget went into a thinking block, so it stopped on
  // `length` having emitted no answer; the empty reply was accepted as a valid
  // empty review. The raw reply is passed in so the gate can tell "said
  // nothing" from "found nothing" - the distinction section 19 requires and
  // the reason the raw reply is stored at all. Callers that have no reply text
  // to offer (unit tests exercising the citation logic directly) omit it, and
  // the precondition is treated as satisfied for them.
  const reviewProduced = rawReply === undefined ? true : rawReply.trim().length > 0;

  // Condition 1. `linesExpected > 0` is required, not incidental: a reader
  // that failed to open the session file reports 0 expected and 0 read, and
  // `0 === 0` would otherwise certify a review of nothing as a complete read.
  const readComplete = read.linesExpected > 0 && read.linesRead === read.linesExpected;

  // Condition 2, re-checked here rather than trusted from the annotation.
  const shapeValid = validateReviewProposals(proposals) !== null;

  if (!shapeValid) {
    // Condition 3 is reported as false because it was not established, not
    // because it was tested and failed - there is no trustworthy item list to
    // test. `filtered` comes back empty and well-formed so a caller that
    // ignores `accepted` still cannot promote anything from a malformed reply.
    return {
      acceptance: {
        accepted: false,
        reviewProduced,
        readComplete,
        shapeValid: false,
        citationsValid: false,
        rejectedItems: [],
        linesExpected: read.linesExpected,
        linesRead: read.linesRead,
        uniformCitation: false,
        reason:
          "structured reviewer output failed shape validation; citations could not be checked",
      },
      filtered: emptyProposals(),
    };
  }

  const rejectedItems: string[] = [];

  const grounded = (item: string): boolean =>
    extractCitations(item).some((id) => knownEntryIds.has(id));

  const keepCited = (items: string[]): string[] =>
    items.filter((item) => {
      if (grounded(item)) return true;
      rejectedItems.push(item);
      return false;
    });

  const filtered: ReviewProposals = {
    findings: keepCited(proposals.findings),
    patterns: keepCited(proposals.patterns),
    mistakes: keepCited(proposals.mistakes),
    userPreferences: keepCited(proposals.userPreferences),
    modelSpecificGuidance: keepCited(proposals.modelSpecificGuidance),
    projectLessons: keepCited(proposals.projectLessons),
    unresolvedIssues: keepCited(proposals.unresolvedIssues),
    // Memory candidates carry a dedicated `sources` field, so that field is
    // the citation - not the prose. A candidate whose content happens to
    // mention an id while its sources are empty or invented has not cited
    // anything; `content` is what gets recorded as rejected, because the
    // content is the assertion a human needs to see.
    memoryCandidates: proposals.memoryCandidates.filter((candidate) => {
      const cited = candidate.sources
        .map((source) => stripIdDecoration(source.trim()))
        .some((id) => isCitationCandidate(id) && knownEntryIds.has(id));
      if (cited) return true;
      rejectedItems.push(candidate.content);
      return false;
    }),
  };

  const citationsValid = rejectedItems.length === 0;

  // Citation *diversity*, reported and never enforced. See the field comment
  // on ReviewAcceptance.uniformCitation for why this cannot be a rejection:
  // the gate can verify that an id belongs to this session, and no mechanical
  // check can verify that the entry supports the claim it is attached to.
  const survivingItems = [
    ...filtered.findings,
    ...filtered.patterns,
    ...filtered.mistakes,
    ...filtered.userPreferences,
    ...filtered.modelSpecificGuidance,
    ...filtered.projectLessons,
    ...filtered.unresolvedIssues,
  ];
  const citedIds = new Set<string>();
  for (const item of survivingItems) {
    for (const id of extractCitations(item)) {
      if (knownEntryIds.has(id)) citedIds.add(id);
    }
  }
  for (const candidate of filtered.memoryCandidates) {
    for (const source of candidate.sources) {
      const id = stripIdDecoration(source.trim());
      if (knownEntryIds.has(id)) citedIds.add(id);
    }
  }
  const itemCount = survivingItems.length + filtered.memoryCandidates.length;
  const uniformCitation = itemCount > 1 && citedIds.size === 1;

  const failures: string[] = [];
  if (!reviewProduced) {
    failures.push("the reviewer produced no output; nothing was reviewed");
  }
  if (!readComplete) {
    failures.push(
      read.linesExpected === 0
        ? "no session lines were retrieved through the session reader"
        : `short read: ${read.linesRead} of ${read.linesExpected} session lines retrieved`,
    );
  }
  if (!citationsValid) {
    failures.push(
      `${rejectedItems.length} item(s) cited no entry id occurring in this session`,
    );
  }

  return {
    acceptance: {
      accepted: reviewProduced && readComplete && citationsValid,
      reviewProduced,
      readComplete,
      shapeValid: true,
      citationsValid,
      rejectedItems,
      linesExpected: read.linesExpected,
      linesRead: read.linesRead,
      uniformCitation,
      reason:
        failures.length === 0
          ? uniformCitation
            ? `complete read, valid shape, every item grounded in a session entry - but all ${itemCount} items cite the same single entry, which is what padded citations look like; check them`
            : "complete read, valid shape, every item grounded in a session entry"
          : failures.join("; "),
    },
    filtered,
  };
}

/**
 * The generation number for the next review of a session.
 *
 * A resumed session gets reviewed again, and the second reviewer reads a
 * longer transcript than the first. Numbering the runs instead of
 * overwriting keeps both readings: the first conclusion was true of the
 * session as it stood, and destroying it would leave no record of what was
 * believed at the time or of the fact that a later run disagreed.
 *
 * Generations are 1-based. `existing` is normally derived from a directory
 * listing, which is untrusted input - a stray or truncated filename must not
 * yield NaN or 0 and steer the next write on top of generation 1 - so
 * anything that is not a positive integer is ignored rather than repaired.
 */
export function nextReviewGeneration(existing: number[]): number {
  let highest = 0;
  for (const generation of existing) {
    if (!Number.isInteger(generation) || generation < 1) continue;
    if (generation > highest) highest = generation;
  }
  return highest + 1;
}
