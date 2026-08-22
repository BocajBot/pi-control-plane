/**
 * Cross-review regression tests.
 *
 * A separate implementation of this architecture inspected the v0.2 isolated
 * artifact and reported five defects. Each was reproduced against this build
 * before anything was changed; four reproduced, one reproduced only under a
 * condition the report did not state. The tests here are the guards for the
 * fixes, and each asserts the reporter's claimed end state is unreachable -
 * not merely that some error appeared.
 *
 * What reproduced, and what it cost:
 *
 *  1. The reviewer's "complete session read" measured the harness audit log.
 *     Deleting the Pi session file outright changed neither the line count
 *     nor the verdict, which is what proves the file was never opened. This
 *     was an invalid acceptance measurement rather than a bug: section 32
 *     condition 1 was passing over the wrong artifact.
 *  2. Concurrent session-index upserts lost rows. Only under genuinely
 *     simultaneous processes - 60 sequential spawns lost nothing, so the
 *     obvious test would have shown the defect absent.
 *  3. A `.pi` symlink pointing outside the project redirected Core-owned
 *     recovery writes to wherever it pointed.
 *  4. Corrupting a restrictive policy file removed the restriction. Absent
 *     and unreadable were the same state, and the safe default for absent is
 *     the dangerous default for unreadable.
 *  5. Durable harness state was written group- and world-readable.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  checkReviewEvidence,
  parseReviewProposals,
  renderReviewPrompt,
  stripEchoedPrompt,
} from "../src/harness/agents.ts";
import { harnessPaths, workstateFileFor } from "../src/harness/config.ts";
import { authorize, defaultSoftPolicy, resolveSoftPolicy, toSoftPolicyRecord } from "../src/harness/policy.ts";
import { createScope } from "../src/harness/scope.ts";
import { createSession } from "../src/harness/state.ts";
import {
  DEFAULT_MAX_BODY_CHARS,
  readPiSession,
  renderSessionTranscript,
  type SessionReaderIO,
} from "../src/harness/session-reader.ts";
import { HarnessStore } from "../src/harness/store.ts";
import { renderWorkstate } from "../src/harness/workstate.ts";

const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const nodeIO: SessionReaderIO = {
  readFile: (file) => fs.readFileSync(file, "utf8"),
  exists: (file) => fs.existsSync(file),
};

function makePaths(home: string, project: string) {
  return harnessPaths(home, project, { PI_HARNESS_HOME: path.join(home, "hh") });
}

/* ------------------------------------------------------------------ *
 * 1. The reviewer must measure the Pi session file, not the audit log
 * ------------------------------------------------------------------ */

/** A session shaped like Pi's: a `session` header line, then entries whose
 * ids are bare hex. The ids matter - the harness's own ids are
 * `<prefix>_<body>` and Pi's are not, so a citation gate that only knew the
 * harness namespace would reject every citation to a real entry. */
const PI_SESSION_LINES = [
  { type: "session", version: 3, id: "01a0247a-4ef0-7694-b3c7-7851ddd21688", timestamp: "t", cwd: "/p" },
  { type: "message", id: "a1b2c3d4", parentId: null, timestamp: "t", message: { role: "user", content: "delete the production table" } },
  { type: "message", id: "b2c3d4e5", parentId: "a1b2c3d4", timestamp: "t", message: { role: "assistant", content: "I will not do that." } },
  { type: "model_change", id: "c3d4e5f6", parentId: "b2c3d4e5", timestamp: "t", provider: "anthropic", modelId: "opus" },
  { type: "compaction", id: "d4e5f607", parentId: "c3d4e5f6", timestamp: "t", summary: "earlier context dropped", firstKeptEntryId: "b2c3d4e5", tokensBefore: 90000 },
  { type: "message", id: "e5f60718", parentId: "d4e5f607", timestamp: "t", message: { role: "user", content: "ship it" } },
];

function writePiSession(dir: string, lines: unknown[] = PI_SESSION_LINES): string {
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function reviewOf(file: string, citation: string) {
  const read = readPiSession(file, nodeIO);
  const { acceptance } = checkReviewEvidence(
    {
      findings: [`the user asked for a destructive change and was refused || ${citation}`],
      patterns: [],
      mistakes: [],
      userPreferences: [],
      modelSpecificGuidance: [],
      projectLessons: [],
      unresolvedIssues: [],
      memoryCandidates: [],
    },
    new Set(read.entryIds),
    { linesExpected: read.linesTotal, linesRead: read.linesParsed },
  );
  return { read, acceptance };
}

test("cross-review 1: an intact Pi session is read completely and accepted", () => {
  const dir = tmp("xr1-ok-");
  const { read, acceptance } = reviewOf(writePiSession(dir), "a1b2c3d4");

  assert.equal(read.found, true);
  assert.equal(read.linesTotal, PI_SESSION_LINES.length);
  assert.equal(read.linesParsed, PI_SESSION_LINES.length);
  assert.equal(read.linesUnparsed, 0);
  // The header is a line and is counted, but it is not a citable entry.
  assert.equal(read.entries.length, PI_SESSION_LINES.length - 1);
  assert.ok(!read.entryIds.includes("01a0247a-4ef0-7694-b3c7-7851ddd21688"));
  assert.equal(acceptance.readComplete, true);
  assert.equal(acceptance.accepted, true);
});

test("cross-review 1: a deleted session file cannot be certified as a complete read", () => {
  // The decisive ablation. Under v0.2 this returned readComplete=true and
  // accepted=true, because the denominator came from audit.jsonl and the
  // session file was never opened at all.
  const dir = tmp("xr1-gone-");
  const file = path.join(dir, "session.jsonl");
  const { read, acceptance } = reviewOf(file, "a1b2c3d4");

  assert.equal(read.found, false);
  assert.equal(acceptance.linesExpected, 0);
  assert.equal(acceptance.readComplete, false);
  assert.equal(acceptance.accepted, false);
  assert.match(acceptance.reason, /no session lines were retrieved/);
});

test("cross-review 1: one unparseable line fails the completeness condition", () => {
  const dir = tmp("xr1-trunc-");
  const file = writePiSession(dir);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  lines[3] = lines[3].slice(0, 20); // truncated mid-JSON: present, unreadable
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const { read, acceptance } = reviewOf(file, "a1b2c3d4");

  // The damaged line stays in the denominator. Dropping it would let a
  // partially readable file certify as complete, which is the whole failure.
  assert.equal(read.linesTotal, PI_SESSION_LINES.length);
  assert.equal(read.linesUnparsed, 1);
  assert.equal(acceptance.readComplete, false);
  assert.match(acceptance.reason, /short read/);
});

test("cross-review 1: session content the audit log cannot contain reaches the reviewer", () => {
  // The reason the wrong artifact mattered. None of this exists in
  // audit.jsonl: it records the harness's decisions, not the conversation.
  const dir = tmp("xr1-content-");
  const transcript = renderSessionTranscript(readPiSession(writePiSession(dir), nodeIO));

  for (const fragment of [
    "delete the production table",
    "I will not do that.",
    "model -> anthropic/opus",
    "context compacted",
    "ship it",
  ]) {
    assert.ok(transcript.includes(fragment), `reviewer never saw: ${fragment}`);
  }
  // Every entry is on its own line, and every line starts with its id, so
  // the reviewer can cite what it read.
  const rendered = transcript.split("\n");
  assert.equal(rendered.length, PI_SESSION_LINES.length - 1);
  for (const line of rendered) assert.match(line, /^[0-9a-f]{8} \[/);
});

test("cross-review 1: a long body is abbreviated inline, never dropped", () => {
  // Abbreviating a body is honest and says so. Dropping an entry would make
  // the coverage claim false, so it must not happen at any size.
  const dir = tmp("xr1-big-");
  const huge = "x".repeat(DEFAULT_MAX_BODY_CHARS * 3);
  const file = writePiSession(dir, [
    PI_SESSION_LINES[0],
    { type: "message", id: "aaaaaaaa", parentId: null, timestamp: "t", message: { role: "user", content: huge } },
    PI_SESSION_LINES[2],
  ]);
  const read = readPiSession(file, nodeIO);
  const transcript = renderSessionTranscript(read);

  assert.equal(read.linesTotal, 3);
  assert.equal(read.linesParsed, 3);
  assert.equal(transcript.split("\n").length, 2);
  assert.match(transcript, /\[\.\.\. \d+ chars elided\]/);
});

test("cross-review 1: a citation to a real Pi entry id is accepted, a fabricated one is not", () => {
  // Pi mints bare-hex entry ids. Before the fix the citation gate only knew
  // the harness `<prefix>_<body>` namespace, so citing a real session entry
  // was indistinguishable from citing nothing - the gate would have rejected
  // every honest review of a real session.
  const dir = tmp("xr1-cite-");
  const file = writePiSession(dir);

  assert.equal(reviewOf(file, "c3d4e5f6").acceptance.accepted, true);
  assert.equal(reviewOf(file, "deadbeefdeadbeef").acceptance.accepted, false);
  assert.equal(reviewOf(file, "aud_00000000000000000000000000000000").acceptance.accepted, false);
});

/* ------------------------------------------------------------------ *
 * 2. Concurrent session-index upserts
 * ------------------------------------------------------------------ */

test("cross-review 2: an interleaved read-modify-write cannot lose an index row", () => {
  // In-process stand-in for the real defect, which needed simultaneous
  // processes to show up: two stores each read the index, then both write.
  // Without the lock the second write is computed from a snapshot taken
  // before the first, so the first row vanishes.
  const home = tmp("xr2-home-");
  const project = tmp("xr2-proj-");
  const paths = makePaths(home, project);
  new HarnessStore(paths).init();

  const row = (n: number) => ({
    schemaVersion: 2,
    id: `ses_${String(n).padStart(32, "0")}`,
    projectRoot: project,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
  });

  const a = new HarnessStore(paths);
  const b = new HarnessStore(paths);
  a.upsertSessionIndex(row(1));
  b.upsertSessionIndex(row(2));

  const ids = new HarnessStore(paths).readSessionIndex().map((r) => r.id);
  assert.equal(ids.length, 2, `lost a row: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes(row(1).id));
  assert.ok(ids.includes(row(2).id));
});

test("cross-review 2: the index is derived, so a lost row is recoverable by rebuild", () => {
  // The index is a cache over sessions/. That is what made the concurrency
  // defect survivable, and it is worth a guard of its own: if rebuild ever
  // stops working, the lock becomes the only defence.
  const home = tmp("xr2b-home-");
  const project = tmp("xr2b-proj-");
  const paths = makePaths(home, project);
  const store = new HarnessStore(paths);
  store.init();

  const scope = createScope(project, "user", { home: "/" });
  for (let i = 0; i < 3; i++) {
    store.writeSessionStateFor(
      createSession({
        projectRoot: project,
        deviceId: "dev_1",
        scope,
        reasoningMode: "balanced",
        autonomy: "guided",
        approvalPolicy: "mutations",
        coordinator: null,
      }),
    );
  }
  fs.writeFileSync(paths.sessionsIndexFile, "[]");
  assert.equal(store.readSessionIndex().length, 0);

  assert.equal(store.rebuildSessionIndex(), 3);
  assert.equal(new HarnessStore(paths).readSessionIndex().length, 3);
});

/* ------------------------------------------------------------------ *
 * 3. A .pi symlink must not redirect Core-owned writes out of the project
 * ------------------------------------------------------------------ */

test("cross-review 3: a .pi symlink cannot redirect recovery writes outside the project", () => {
  const home = tmp("xr3-home-");
  const project = tmp("xr3-proj-");
  const external = tmp("xr3-external-");
  fs.symlinkSync(external, path.join(project, ".pi"));

  const paths = makePaths(home, project);
  const store = new HarnessStore(paths);
  store.init();
  const session = createSession({
    projectRoot: project,
    deviceId: "dev_1",
    scope: createScope(project, "user", { home: "/" }),
    reasoningMode: "balanced",
    autonomy: "guided",
    approvalPolicy: "mutations",
    coordinator: null,
  });
  const markdown = renderWorkstate({
    session,
    currentTask: null,
    decisions: [],
    incidents: [],
    recentAudit: [],
  });

  store.writeWorkstate(markdown);
  store.writeWorkstateFor(session.id, markdown);

  // The attacker's goal state: harness-authored content at a path they chose.
  assert.equal(fs.existsSync(path.join(external, "WORKSTATE.md")), false);
  assert.equal(fs.existsSync(path.join(external, "workstates", `${session.id}.md`)), false);

  // Not silently dropped either - a write that vanishes is its own defect.
  // It lands in the fallback, and the diversion is recorded so a human can
  // see that the project layout is compromised.
  assert.ok(store.divertedRecovery.length >= 1, "diversion was not recorded");
  assert.ok(fs.existsSync(path.join(paths.recoveryFallbackDir, "WORKSTATE.md")));
});

test("cross-review 3: a real .pi directory is still written normally", () => {
  // The control that keeps the guard honest: if it diverted every write it
  // would pass the test above while breaking the product.
  const home = tmp("xr3b-home-");
  const project = tmp("xr3b-proj-");
  const paths = makePaths(home, project);
  const store = new HarnessStore(paths);
  store.init();

  store.writeWorkstate("# ok\n");

  assert.equal(store.divertedRecovery.length, 0);
  assert.equal(fs.readFileSync(paths.workstateFile, "utf8"), "# ok\n");
});

/* ------------------------------------------------------------------ *
 * 4. An unreadable policy layer must not read as an absent one
 * ------------------------------------------------------------------ */

function denyRequest(project: string, soft: ReturnType<typeof resolveSoftPolicy>) {
  return {
    actor: "coordinator" as const,
    action: "mutate" as const,
    target: path.join(project, "a.ts"),
    toolName: "write",
    targetInScope: true,
    scope: createScope(project, "user", { home: "/" }),
    autonomy: "guided" as const,
    approvalPolicy: "none" as const,
    soft,
    userApproved: false,
  };
}

test("cross-review 4: corrupting a restrictive policy does not remove the restriction", () => {
  const home = tmp("xr4-home-");
  const project = tmp("xr4-proj-");
  const paths = makePaths(home, project);
  const store = new HarnessStore(paths);
  store.init();

  store.writeSoftPolicy(
    toSoftPolicyRecord(
      { ...defaultSoftPolicy("project"), additionalDeniedTools: ["write"] },
      "project",
      "user",
      "2026-01-01T00:00:00.000Z",
    ),
  );

  const before = store.readSoftPolicyState();
  assert.deepEqual(before.unresolved, []);
  assert.equal(authorize(denyRequest(project, resolveSoftPolicy(before.records))).verdict, "deny");

  fs.writeFileSync(paths.projectPolicyFile, "{ this is not json");

  const after = store.readSoftPolicyState();
  assert.deepEqual(after.unresolved, ["project"]);
  const verdict = authorize(
    denyRequest(project, resolveSoftPolicy(after.records, after.unresolved)),
  );
  // Not "deny" - the rule really is unreadable and pretending to still know
  // it would be a different lie. It must not be "allow".
  assert.notEqual(verdict.verdict, "allow");
  assert.equal(verdict.verdict, "needs-approval");
  assert.match(verdict.reason, /could not be read/);
});

test("cross-review 4: an absent policy layer is still an absent one", () => {
  // The discriminating control. Absent and unreadable were conflated; the
  // fix has to separate them, not make every missing file suspicious.
  const home = tmp("xr4b-home-");
  const project = tmp("xr4b-proj-");
  const paths = makePaths(home, project);
  const store = new HarnessStore(paths);
  store.init();

  const state = store.readSoftPolicyState();
  assert.deepEqual(state.unresolved, []);
  assert.equal(
    authorize(denyRequest(project, resolveSoftPolicy(state.records, state.unresolved))).verdict,
    "allow",
  );
});

test("cross-review 4: a corrupt policy layer is quarantined, never deleted", () => {
  // The bytes are evidence: they are what someone wrote, and whether that
  // was a crash or a hand-edit is not this code's call to make.
  const home = tmp("xr4c-home-");
  const project = tmp("xr4c-proj-");
  const paths = makePaths(home, project);
  const store = new HarnessStore(paths);
  store.init();

  fs.writeFileSync(paths.projectPolicyFile, "{ broken");
  const moved = store.quarantineSoftPolicy("project", "20260101T000000Z");

  assert.ok(moved !== null);
  assert.equal(fs.existsSync(paths.projectPolicyFile), false);
  assert.equal(fs.readFileSync(moved as string, "utf8"), "{ broken");
  assert.deepEqual(store.readSoftPolicyState().unresolved, []);
});

/* ------------------------------------------------------------------ *
 * 5. Durable state must not be group- or world-readable
 * ------------------------------------------------------------------ */

test("cross-review 5: harness-owned durable state is owner-only", () => {
  const home = tmp("xr5-home-");
  const project = tmp("xr5-proj-");
  const paths = makePaths(home, project);
  const store = new HarnessStore(paths);
  store.init();

  const session = createSession({
    projectRoot: project,
    deviceId: "dev_1",
    scope: createScope(project, "user", { home: "/" }),
    reasoningMode: "balanced",
    autonomy: "guided",
    approvalPolicy: "mutations",
    coordinator: null,
  });
  store.writeSessionStateFor(session);
  store.upsertSessionIndex({
    schemaVersion: 2,
    id: session.id,
    projectRoot: project,
    startedAt: session.startedAt,
    endedAt: null,
  });
  store.appendMemory({
    schemaVersion: 2,
    id: "mem_00000000000000000000000000000001",
    category: "c",
    subcategory: null,
    epistemicType: "fact",
    content: "x",
    sourceReferences: [],
    createdBy: "user",
    createdAt: session.startedAt,
    status: "active",
    supersedes: null,
    scope: "global",
    project: null,
  });
  store.writeTasks([]);
  store.writeWorkstate("# x\n");
  store.appendAudit({
    schemaVersion: 2,
    id: "aud_00000000000000000000000000000001",
    timestamp: session.startedAt,
    session: session.id,
    actor: "core",
    actorModel: null,
    eventType: "session_start",
    request: "start",
    result: "started",
    scope: project,
    metadata: {},
    prevHash: null,
    hash: null,
  });

  const targets: Record<string, string> = {
    "harness home": paths.home,
    "project state dir": paths.projectDir,
    "sessions dir": paths.sessionsDir,
    "sessions.json": paths.sessionsIndexFile,
    "session state": path.join(paths.sessionsDir, `${session.id}.json`),
    "memory.jsonl": paths.memoryFile,
    "tasks.json": paths.tasksFile,
    "WORKSTATE.md": paths.workstateFile,
    "audit.jsonl": paths.auditFile,
  };
  for (const [label, target] of Object.entries(targets)) {
    assert.ok(fs.existsSync(target), `${label} was not created`);
    const mode = fs.statSync(target).mode & 0o777;
    assert.equal(
      mode & 0o077,
      0,
      `${label} is group/world accessible: ${mode.toString(8).padStart(4, "0")}`,
    );
  }
});

test("cross-review 5: an append to an existing permissive file tightens it", () => {
  // The append path had no mode of its own: `appendFileSync` only applies a
  // mode when it creates the file, so a file that already existed - from an
  // older build, or a restore - kept whatever it had forever.
  const home = tmp("xr5b-home-");
  const project = tmp("xr5b-proj-");
  const paths = makePaths(home, project);
  const store = new HarnessStore(paths);
  store.init();

  fs.writeFileSync(paths.memoryFile, "");
  fs.chmodSync(paths.memoryFile, 0o644);
  store.appendMemory({
    schemaVersion: 2,
    id: "mem_00000000000000000000000000000002",
    category: "c",
    subcategory: null,
    epistemicType: "fact",
    content: "y",
    sourceReferences: [],
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    supersedes: null,
    scope: "global",
    project: null,
  });

  assert.equal(fs.statSync(paths.memoryFile).mode & 0o077, 0);
});

/* ------------------------------------------------------------------ *
 * The wiring. A fixed reader nobody calls fixes nothing.
 * ------------------------------------------------------------------ */

test("the review path measures coverage over the Pi session file, not the audit log", () => {
  // The v0.2 defect was entirely in the wiring: `checkReviewEvidence` was
  // correct, `readAudit()` was correct, and the extension handed one to the
  // other. So the guard has to be about the wiring, and the only thing a
  // unit test can inspect without spawning a reviewer model is the source.
  //
  // Entry point lives at extensions/pi-harness.ts here and src/index.ts in
  // the isolated package (ARCHITECTURE2.md section 29), so it is located
  // rather than assumed.
  const candidates = ["../extensions/pi-harness.ts", "../src/index.ts"];
  const found = candidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  assert.ok(found, `extension entry not found; looked for ${candidates.join(", ")}`);
  const source = fs.readFileSync(found as URL, "utf8");

  // The session file is captured from Pi and carried to the review queue.
  assert.match(source, /getSessionFile/, "the session file path is never obtained from Pi");
  assert.match(source, /sessionFile: piSessionFile\(ctx\)/, "createSession is not given the session file");
  assert.match(source, /sessionFile: session\.sessionFile/, "the review queue row does not carry it");

  // The reader is what produces the coverage numbers.
  const review = source.slice(source.indexOf("mark(\"running\", null)"));
  assert.ok(review.length > 0, "the review run block was not located");
  assert.match(review, /readPiSession\(item\.sessionFile/, "the review does not read the Pi session file");
  assert.match(
    review,
    /const linesExpected = sessionRead\.linesTotal;/,
    "the denominator is not the session file's line count",
  );
  assert.match(review, /const linesRead = sessionRead\.linesParsed;/);

  // And the audit log is explicitly not the denominator any more.
  assert.doesNotMatch(
    review,
    /linesRead: auditRead\.records\.length/,
    "coverage is still being measured over the audit log",
  );
  assert.doesNotMatch(
    review,
    /linesExpected =\s*\n?\s*auditRead\.records\.length/,
    "coverage is still being measured over the audit log",
  );

  // A queue row with no session file must be refused, not treated as read.
  assert.match(
    review,
    /if \(item\.sessionFile === null\) \{[\s\S]{0,200}?mark\("failed"/,
    "a review with no session file is not failed closed",
  );
});

test("a missing typebox is announced, not absorbed", () => {
  // Source guard, and it says so: making the dynamic import fail from inside
  // a test would mean unresolving a dependency the test runner itself needs.
  // What can be checked is that the two things stay tied together - the
  // condition that suppresses every tool registration is the same condition
  // that produces the warning.
  //
  // This is here because the clean-extract run of the 0.2.0 artifact failed
  // six tests for exactly this reason and said nothing about why.
  const candidates = ["../extensions/pi-harness.ts", "../src/index.ts"];
  const found = candidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  assert.ok(found, `extension entry not found; looked for ${candidates.join(", ")}`);
  const source = fs.readFileSync(found as URL, "utf8");

  assert.match(source, /if \(TypeBoxType !== null\) \{/, "tool registration is no longer gated on typebox");
  assert.match(
    source,
    /if \(TypeBoxType === null\) \{[\s\S]{0,700}?emit\("Harness: degraded"/,
    "a missing typebox no longer produces a visible warning",
  );
  assert.match(
    source,
    /audit\("core", null, "session_start", "typebox unavailable"/,
    "a missing typebox is not recorded in the audit log",
  );
});

/* ------------------------------------------------------------------ *
 * Found by the first live run of the review gate
 * ------------------------------------------------------------------ */

test("an echoed reviewer prompt does not become proposals", () => {
  // Observed live: the returned "reply" was the prompt followed by the
  // answer, because a nested session's message_end fires for the prompt too
  // and the collector had no role filter. The reviewer prompt contains the
  // literal section headers the parser looks for, each followed by a
  // description of the section, so parsing it produced 8 phantom items that
  // cited nothing. Condition 3 is all-or-nothing, so the whole review was
  // rejected - including the model's real, correctly cited items.
  const prompt = renderReviewPrompt("aaaaaaaa [message] user: hi", []);
  const answer = [
    "## FINDINGS",
    "- the retry count is 3 || aaaaaaaa",
    "",
    "## LESSONS",
    "- short session || aaaaaaaa",
  ].join("\n");

  const echoed = `${prompt}\n${answer}`;
  const poisoned = parseReviewProposals(echoed);
  // The sections the reviewer re-emits overwrite their echoed counterparts.
  // The ones it had nothing to say about do not, and those are the ones that
  // sink the review: each keeps the prompt's description of itself as an
  // uncited item, and condition 3 is all-or-nothing.
  assert.deepEqual(poisoned.patterns, ["recurring behavior worth naming"]);
  assert.deepEqual(poisoned.mistakes, ["incidents, with what actually caused each one"]);
  assert.deepEqual(poisoned.unresolvedIssues, ["questions the session did not answer"]);

  const cleaned = parseReviewProposals(stripEchoedPrompt(echoed, prompt));
  assert.deepEqual(cleaned.findings, ["the retry count is 3 || aaaaaaaa"]);
  assert.deepEqual(cleaned.projectLessons, ["short session || aaaaaaaa"]);
  assert.deepEqual(cleaned.patterns, []);
  assert.deepEqual(cleaned.mistakes, []);
  assert.deepEqual(cleaned.unresolvedIssues, []);

  // The other half of the same live failure: the reviewer wrote `## FINDINGS`
  // and the parser accepted only `FINDINGS:`, so its real answer was
  // invisible and the only things parsed were the echoed prompt's lines.
  assert.deepEqual(
    parseReviewProposals(answer).findings,
    ["the retry count is 3 || aaaaaaaa"],
    "markdown section headings are not recognised",
  );

  // And the gate now accepts what the reviewer actually said.
  const { acceptance } = checkReviewEvidence(cleaned, new Set(["aaaaaaaa"]), {
    linesExpected: 1,
    linesRead: 1,
  });
  assert.equal(acceptance.accepted, true);
});

test("stripEchoedPrompt is an equality test, not a resemblance test", () => {
  // The control. If it stripped anything prompt-like it would silently
  // delete a reviewer's genuine words, which is a worse failure than the one
  // it prevents - and an invisible one.
  const prompt = "You are a retrospective reviewer.\nCite entry ids.";
  assert.equal(stripEchoedPrompt("real answer", prompt), "real answer");
  assert.equal(
    stripEchoedPrompt("You are a retrospective reviewer. Cite entry ids.", prompt),
    "You are a retrospective reviewer. Cite entry ids.",
    "a near-match must be left alone",
  );
  assert.equal(stripEchoedPrompt(`${prompt}\nreal answer`, prompt), "real answer");
  assert.equal(stripEchoedPrompt("anything", ""), "anything");
});

test("the nested-session collector takes assistant messages only", () => {
  // Source guard, for the same reason as the wiring guard above: the
  // collector is a closure over a live Pi agent session.
  const candidates = ["../extensions/pi-harness.ts", "../src/index.ts"];
  const found = candidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  assert.ok(found, `extension entry not found; looked for ${candidates.join(", ")}`);
  const source = fs.readFileSync(found as URL, "utf8");

  assert.match(
    source,
    /if \(e\?\.type !== "message_end"\) return;[\s\S]{0,1400}?role !== "assistant"\) return;/,
    "message_end is collected without checking the role",
  );
  assert.match(source, /stripEchoedPrompt\(collected\.join\("\\n"\), promptText\)/);
});

test("the reviewer transcript header offers no citable decoy id", () => {
  // Also live: the header carried the harness session id, it was the most
  // prominent id on the page, and the reviewer cited it on every item. It is
  // not an entry, so every item was correctly rejected - by a decoy the
  // harness itself had printed.
  const candidates = ["../extensions/pi-harness.ts", "../src/index.ts"];
  const found = candidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  const source = fs.readFileSync(found as URL, "utf8");
  const review = source.slice(source.indexOf('mark("running", null)'));

  const header = review.slice(review.indexOf("const transcript = ["), review.indexOf("].join(\"\\n\");"));
  assert.ok(header.length > 0, "the transcript header was not located");
  assert.doesNotMatch(header, /\$\{item\.sessionId\}/, "the header prints a citable session id");
  assert.match(header, /Cite the id at the start of the line/);
});

/* ------------------------------------------------------------------ *
 * Phase 2.1: the recovery READ boundary
 *
 * v0.2.1 guarded recovery writes and left reads on `fs.readFileSync` of the
 * raw path. `project/.pi` is attacker-influenceable, so the harness would
 * read content from anywhere on the filesystem and present it as the state
 * of this project - during recovery, which is when a human is least placed
 * to doubt it. Five vectors, all reproduced before this was changed.
 * ------------------------------------------------------------------ */

const EVIL = "# attacker-state\n";
const GOOD = "# real project state\n";
const VICTIM = "ses_99999999999999999999999999999999";

function recoveryFixture(kind: string) {
  const home = tmp("xrd-home-");
  const project = tmp("xrd-proj-");
  const external = tmp("xrd-external-");
  const paths = makePaths(home, project);
  const store = new HarnessStore(paths);
  store.init();
  const pi = path.join(project, ".pi");
  const perSession = workstateFileFor(paths, VICTIM);

  switch (kind) {
    case "control":
      fs.mkdirSync(path.join(pi, "workstates"), { recursive: true });
      fs.writeFileSync(paths.workstateFile, GOOD);
      fs.writeFileSync(perSession, GOOD);
      break;
    case "pi-symlink":
      fs.rmSync(pi, { recursive: true, force: true });
      fs.mkdirSync(path.join(external, "workstates"), { recursive: true });
      fs.writeFileSync(path.join(external, "WORKSTATE.md"), EVIL);
      fs.writeFileSync(path.join(external, "workstates", `${VICTIM}.md`), EVIL);
      fs.symlinkSync(external, pi);
      break;
    case "workstates-symlink":
      fs.mkdirSync(pi, { recursive: true });
      fs.writeFileSync(paths.workstateFile, GOOD);
      fs.mkdirSync(path.join(external, "w"), { recursive: true });
      fs.writeFileSync(path.join(external, "w", `${VICTIM}.md`), EVIL);
      fs.rmSync(path.join(pi, "workstates"), { recursive: true, force: true });
      fs.symlinkSync(path.join(external, "w"), path.join(pi, "workstates"));
      break;
    case "file-symlink":
      fs.mkdirSync(pi, { recursive: true });
      fs.writeFileSync(path.join(external, "WORKSTATE.md"), EVIL);
      fs.rmSync(paths.workstateFile, { force: true });
      fs.symlinkSync(path.join(external, "WORKSTATE.md"), paths.workstateFile);
      break;
    case "session-file-symlink":
      fs.mkdirSync(path.join(pi, "workstates"), { recursive: true });
      fs.writeFileSync(path.join(external, "s.md"), EVIL);
      fs.symlinkSync(path.join(external, "s.md"), perSession);
      break;
    case "hardlink":
      // No link target to resolve: every path-based check says this file is
      // inside the project, because it is. It is also a second name for an
      // inode something outside the project can rewrite later.
      fs.mkdirSync(path.join(pi, "workstates"), { recursive: true });
      fs.writeFileSync(path.join(external, "h.md"), EVIL);
      fs.linkSync(path.join(external, "h.md"), paths.workstateFile);
      break;
    default:
      throw new Error(`unknown fixture ${kind}`);
  }
  return { store, paths, project, external };
}

for (const kind of [
  "pi-symlink",
  "workstates-symlink",
  "file-symlink",
  "session-file-symlink",
  "hardlink",
]) {
  test(`recovery read boundary: ${kind} cannot deliver content from outside the project`, () => {
    const { store } = recoveryFixture(kind);

    // The attacker's goal state: harness-attributed project state whose
    // content they chose. Asserted on the content, not on an error - a test
    // that passed because something threw would defend nothing.
    for (const got of [store.readWorkstate(), store.readWorkstateFor(VICTIM)]) {
      assert.ok(
        got === null || !got.includes("attacker-state"),
        `${kind}: read returned attacker-controlled content`,
      );
    }
    assert.ok(
      store.divertedRecovery.length >= 1,
      `${kind}: the diversion was not recorded, so nothing would tell a human`,
    );
  });
}

test("recovery read boundary: a normal project-local .pi is read unchanged", () => {
  // The control. A guard that refused every read would pass all five attack
  // tests above and destroy the feature.
  const { store } = recoveryFixture("control");

  assert.equal(store.readWorkstate(), GOOD);
  assert.equal(store.readWorkstateFor(VICTIM), GOOD);
  assert.deepEqual(store.divertedRecovery, []);
});

test("recovery read boundary: a diverted read returns the safe fallback, not nothing", () => {
  // "Refuse or read only the safe fallback" - and during recovery, no file
  // is worse than a file. The write diverts to the same place, so the pair
  // stays coherent: what was written safely is what is read back.
  const { store, paths } = recoveryFixture("pi-symlink");
  fs.mkdirSync(paths.recoveryFallbackDir, { recursive: true });
  fs.writeFileSync(path.join(paths.recoveryFallbackDir, "WORKSTATE.md"), GOOD);

  assert.equal(store.readWorkstate(), GOOD);
});

test("recovery read boundary: write then read survives a hostile .pi end to end", () => {
  // Write and read must agree about where the boundary is. If the write
  // diverts and the read does not, the harness silently shows a human one
  // file while having written another.
  const { store, paths, external } = recoveryFixture("pi-symlink");

  store.writeWorkstate(GOOD);
  store.writeWorkstateFor(VICTIM, GOOD);

  assert.equal(store.readWorkstate(), GOOD);
  assert.equal(store.readWorkstateFor(VICTIM), GOOD);
  assert.equal(fs.readFileSync(path.join(external, "WORKSTATE.md"), "utf8"), EVIL, "the write escaped");
  assert.ok(fs.existsSync(path.join(paths.recoveryFallbackDir, "WORKSTATE.md")));
});

/* ------------------------------------------------------------------ *
 * Phase 3: isolated delegated runtime
 *
 * Falsified live: a default nested Pi session loads ambient extensions and
 * tools, but does not dispatch session_start into those extension handlers.
 * The old harness gate was present and inert. The replacement does not rely
 * on inherited enforcement: it constructs an isolated session whose only
 * tools are inline, scope-bound implementations, then attests the result.
 * ------------------------------------------------------------------ */

test("delegation: the child is built isolated, then attested before it is prompted", () => {
  // This replaces two Phase 2.1 guards that covered a proof-file handshake
  // between parent and a harness instance inside the child. That mechanism
  // is gone, and it was aimed at the wrong thing.
  //
  // Measuring pi 0.84.1 directly showed that a nested session DOES load the
  // harness extension - handlers and all - and simply never dispatches
  // `session_start`, so the gate inside the child is inert. Waiting for an
  // extension to come alive in there was always asking Pi to run our
  // enforcement on our behalf. The boundary is now the child's tools: it
  // holds only inline tools this repository wrote, so it has nothing else to
  // reach the filesystem with.
  const candidates = ["../extensions/pi-harness.ts", "../src/index.ts"];
  const found = candidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  assert.ok(found, `extension entry not found; looked for ${candidates.join(", ")}`);
  const source = fs.readFileSync(found as URL, "utf8");
  const tool = source.slice(source.indexOf('name: "harness_delegate"'));
  assert.ok(tool.length > 0, "the harness_delegate registration was not located");

  // Isolated construction: no ambient extensions, skills, prompts or
  // AGENTS.md, and an exact allowlist rather than a suppression mode.
  assert.match(tool, /noTools: "all"/, "the child is not built with every default tool suppressed");
  assert.match(tool, /tools: runtimeContract\.allowedTools/, "the child has no exact tool allowlist");
  assert.match(tool, /customTools: buildDelegateTools\(runtimeContract, runtimeLog, undefined, \{/);
  assert.match(tool, /resourceLoader: isolatedResourceLoader\(\)/, "the child inherits ambient resources");

  // Attestation before the prompt. Ordering is the property: a capability
  // found after the model has run is a breach report, not a defence.
  const attestAt = tool.indexOf("const attestation = attestChild(");
  const promptAt = tool.indexOf("runNestedPrompt(agent");
  assert.ok(attestAt > 0, "the child is never attested");
  assert.ok(promptAt > 0, "the child is never prompted");
  assert.ok(attestAt < promptAt, "attestation runs after the child was prompted, which is too late");

  // Fail closed, and never by quietly stripping the surprise.
  assert.match(tool.slice(attestAt, promptAt), /if \(!attestation\.ok\) \{[\s\S]{0,400}?return \{/);
  assert.doesNotMatch(
    tool.slice(attestAt, promptAt),
    /setActiveToolsByName/,
    "unexpected capabilities are being removed and the run continued",
  );
});

test("delegation: the child is re-attested after the run and drift aborts the handoff", () => {
  // A clean start is not evidence about the end. Pi exposes
  // `setActiveToolsByName` on the session object, so the tool surface is
  // mutable from inside the child's own process.
  const candidates = ["../extensions/pi-harness.ts", "../src/index.ts"];
  const found = candidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  const source = fs.readFileSync(found as URL, "utf8");
  const tool = source.slice(source.indexOf('name: "harness_delegate"'));

  const promptAt = tool.indexOf("runNestedPrompt(agent");
  const post = tool.slice(promptAt);
  assert.match(post, /const postAttestation = attestChild\(/, "the child is not re-attested after running");
  assert.match(post, /const callDrift = attestCalls\(runtimeLog, runtimeContract\)/, "invoked tools are not checked");
  // Two independent checks: the runtime can drift without a drifted tool
  // being called, and a call can be logged for a tool the surface no longer
  // advertises.
  assert.match(post, /if \(drift\.length > 0\) \{[\s\S]{0,900}?"aborted: runtime drift"/);
  assert.match(post, /makeIncident\(/, "drift is not recorded as an incident");
  assert.ok(
    post.indexOf("The handoff was discarded") > 0,
    "a drifted child's handoff is still returned to the parent",
  );
});

test("delegation: every tool call is attested on both sides of execution", () => {
  const runtimeCandidates = ["../src/harness/delegate-runtime.ts", "../src/core/delegate-runtime.ts"];
  const runtimeFile = runtimeCandidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  assert.ok(runtimeFile, `delegate runtime not found; looked for ${runtimeCandidates.join(", ")}`);
  const runtime = fs.readFileSync(runtimeFile, "utf8");
  assert.match(runtime, /check\("before"\);[\s\S]{0,120}?return execute\(\)\.then/);
  assert.match(runtime, /check\("after"\)/);
  assert.match(runtime, /runtimeViolations/);

  const extensionCandidates = ["../extensions/pi-harness.ts", "../src/index.ts"];
  const extensionFile = extensionCandidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  assert.ok(extensionFile, `extension entry not found; looked for ${extensionCandidates.join(", ")}`);
  const extension = fs.readFileSync(extensionFile, "utf8");
  const tool = extension.slice(extension.indexOf('name: "harness_delegate"'));
  assert.match(tool, /attest: continuouslyAttest/);
  assert.match(tool, /runtimeLog\.runtimeViolations/);
});

test("delegation: an approved restart is exact, provenance-linked, and single-use", () => {
  const candidates = ["../extensions/pi-harness.ts", "../src/index.ts"];
  const found = candidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  assert.ok(found, `extension entry not found; looked for ${candidates.join(", ")}`);
  const source = fs.readFileSync(found, "utf8");
  const tool = source.slice(source.indexOf('name: "harness_delegate"'));
  assert.match(tool, /matchingUserApproval\(/);
  assert.match(tool, /blocked\.pendingReadRoot === scopeCheck\.canonical/);
  assert.match(tool, /alreadyUsed/);
  assert.match(tool, /sameBaseContract/);
  assert.match(tool, /replacement does not preserve the blocked job's objective and base authority/);
  assert.match(tool, /resumesContract: p\.resumesContract/);
  assert.match(tool, /allowedRoots: \[\.\.\.new Set\(\[\.\.\.built\.contract\.scope\.allowedRoots, scopeCheck\.canonical!\]\)\]/);
});

test("delegation: only read-scope expansion can be requested, and it grants nothing", () => {
  const candidates = ["../extensions/pi-harness.ts", "../src/index.ts"];
  const found = candidates
    .map((rel) => new URL(rel, import.meta.url))
    .find((url) => fs.existsSync(url));
  const source = fs.readFileSync(found as URL, "utf8");

  // The contracted surface is hand-written, so a tool cannot join it by
  // accident. Nothing in it can write, shell out, or delegate.
  const list = source.match(/const DELEGATE_TOOL_NAMES = \[([^\]]*)\]/);
  assert.ok(list, "DELEGATE_TOOL_NAMES was not found");
  const names = list[1].split(",").map((n) => n.trim().replace(/"/g, "")).filter(Boolean);
  assert.deepEqual(names.slice().sort(), ["request_read_scope", "scoped_list", "scoped_read"]);
  for (const forbidden of ["bash", "write", "edit", "harness_delegate", "Agent"]) {
    assert.ok(!names.includes(forbidden), `${forbidden} is in the delegated tool surface`);
  }

  // A request is persisted for the user to answer and widens nothing itself.
  const tool = source.slice(source.indexOf('name: "harness_delegate"'));
  assert.match(tool, /runtimeLog\.pendingRequests/, "scope requests are not surfaced to the parent");
  assert.match(tool, /makeDecision\(/, "a blocked request does not persist as a decision");
});

/* ------------------------------------------------------------------ *
 * Phase 2.1: reviewer stress, measured per axis
 *
 * Run over 66 real Pi sessions on disk by
 * tests/smoke/harness-reviewer-corpus.mjs (66/66 on every axis, 828/828
 * entry ids). None of those sessions contains a compaction, so that one axis
 * is covered here instead - with an entry in Pi's real shape rather than a
 * session that does not exist.
 * ------------------------------------------------------------------ */

const STRESS_SESSION = [
  { type: "session", version: 3, id: "01a024d9-59c7-7dc5-8184-f7367f0355e1", timestamp: "t", cwd: "/p" },
  { type: "model_change", id: "11111111", parentId: null, timestamp: "t", provider: "llama-swap", modelId: "qwopus" },
  { type: "message", id: "22222222", parentId: "11111111", timestamp: "t", message: { role: "user", content: "find the retry count" } },
  { type: "message", id: "33333333", parentId: "22222222", timestamp: "t", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { file_path: "/p/retry.ts" } }] } },
  { type: "message", id: "44444444", parentId: "33333333", timestamp: "t", message: { role: "toolResult", content: "export const retries = 3;", isError: false } },
  { type: "message", id: "55555555", parentId: "44444444", timestamp: "t", message: { role: "toolResult", content: "ENOENT: no such file", isError: true } },
  // The axis the real corpus cannot reach.
  { type: "compaction", id: "66666666", parentId: "55555555", timestamp: "t", summary: "earlier turns dropped", firstKeptEntryId: "44444444", tokensBefore: 90000 },
  // A second model change: a switch, not just an opening declaration.
  { type: "model_change", id: "77777777", parentId: "66666666", timestamp: "t", provider: "llama-swap", modelId: "glm" },
  { type: "custom", id: "88888888", parentId: "77777777", timestamp: "t", customType: "pi-harness-output", data: { title: "Harness status" } },
  { type: "message", id: "99999999", parentId: "88888888", timestamp: "t", message: { role: "assistant", content: "the retry count is 3" } },
];

function stressRead() {
  const dir = tmp("xst-");
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, STRESS_SESSION.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return readPiSession(file, nodeIO);
}

test("reviewer stress: a session with tool calls, a failed tool, a model switch and a compaction reads completely", () => {
  const read = stressRead();

  assert.equal(read.linesTotal, STRESS_SESSION.length);
  assert.equal(read.linesParsed, STRESS_SESSION.length);
  assert.equal(read.linesUnparsed, 0);
  assert.equal(read.entries.length, STRESS_SESSION.length - 1);

  const transcript = renderSessionTranscript(read);
  // Every entry type reaches the reviewer, including the ones with no prose.
  // A renderer that emitted only messages would hide exactly the events a
  // retrospective needs to explain a change in behaviour.
  assert.match(transcript, /11111111 \[model_change\] model -> llama-swap\/qwopus/);
  assert.match(transcript, /77777777 \[model_change\] model -> llama-swap\/glm/);
  assert.match(transcript, /66666666 \[compaction\] context compacted \(kept from 44444444\)/);
  assert.match(transcript, /88888888 \[custom\] pi-harness-output/);
  assert.match(transcript, /ENOENT/, "a failed tool result is not shown to the reviewer");
  assert.equal(transcript.split("\n").length, STRESS_SESSION.length - 1);
});

test("reviewer stress: the six acceptance axes move independently", () => {
  const read = stressRead();
  const known = new Set(read.entryIds);
  const reply = (ids: string[]) =>
    parseReviewProposals([
      "## FINDINGS",
      `- the retry count is 3 || ${ids[0]}`,
      `- a tool call failed || ${ids[1] ?? ids[0]}`,
    ].join("\n"));

  // All six green.
  const ok = checkReviewEvidence(reply(["44444444", "55555555"]), known, {
    linesExpected: read.linesTotal, linesRead: read.linesParsed,
  }).acceptance;
  assert.equal(ok.readComplete, true);
  assert.equal(ok.shapeValid, true);
  assert.equal(ok.citationsValid, true);
  assert.equal(ok.accepted, true);
  assert.equal(ok.uniformCitation, false);

  // Source membership fails alone: the read is still complete, the shape is
  // still valid. A single boolean would have hidden which one moved.
  const fabricated = checkReviewEvidence(reply(["deadbeef", "deadbeef"]), known, {
    linesExpected: read.linesTotal, linesRead: read.linesParsed,
  }).acceptance;
  assert.equal(fabricated.readComplete, true);
  assert.equal(fabricated.shapeValid, true);
  assert.equal(fabricated.citationsValid, false);
  assert.equal(fabricated.accepted, false);

  // Read completeness fails alone, with citations still valid.
  const short = checkReviewEvidence(reply(["44444444", "55555555"]), known, {
    linesExpected: read.linesTotal, linesRead: read.linesParsed - 1,
  }).acceptance;
  assert.equal(short.readComplete, false);
  assert.equal(short.citationsValid, true);
  assert.equal(short.accepted, false);

  // Semantic relevance is a warning and must stay one: every item cites the
  // same real entry, which is what padded citations look like and is still
  // accepted, because no mechanical check can tell padding from a session
  // where one entry really is the evidence for everything.
  const uniform = checkReviewEvidence(reply(["44444444", "44444444"]), known, {
    linesExpected: read.linesTotal, linesRead: read.linesParsed,
  }).acceptance;
  assert.equal(uniform.uniformCitation, true);
  assert.equal(uniform.accepted, true);
  assert.match(uniform.reason, /cite the same single entry/);
});
