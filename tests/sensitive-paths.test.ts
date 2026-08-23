import assert from "node:assert/strict";
import { test } from "node:test";
import { isSensitiveReadTarget } from "../src/control-plane/sensitive-paths.ts";

const AGENT = "/home/u/.pi/agent";

test("agent dir: Pi reading its own skills/config is not sensitive (the reported case)", () => {
  assert.equal(isSensitiveReadTarget("/home/u/.pi/agent/skills/harness-tune/SKILL.md", AGENT), false);
  assert.equal(isSensitiveReadTarget("/home/u/.pi/agent/AGENTS.md", AGENT), false);
  assert.equal(isSensitiveReadTarget(AGENT, AGENT), false);
});

test("agent dir: auth.json stays gated even though it lives under the agent dir", () => {
  assert.equal(isSensitiveReadTarget("/home/u/.pi/agent/auth.json", AGENT), true);
});

test("sensitive by basename, suffix, substring, and path", () => {
  assert.equal(isSensitiveReadTarget("/home/u/proj/.env", AGENT), true); // suffix
  assert.equal(isSensitiveReadTarget("/home/u/proj/prod.env", AGENT), true); // *.env
  assert.equal(isSensitiveReadTarget("/home/u/.ssh/id_rsa", AGENT), true); // basename + path
  assert.equal(isSensitiveReadTarget("/home/u/x/credentials", AGENT), true); // basename
  assert.equal(isSensitiveReadTarget("/home/u/x/server.pem", AGENT), true); // suffix
  assert.equal(isSensitiveReadTarget("/home/u/x/my-secret-notes.txt", AGENT), true); // substring "secret"
  assert.equal(isSensitiveReadTarget("/home/u/.aws/config", AGENT), true); // path substring
  assert.equal(isSensitiveReadTarget("/home/u/.hermes/config.yaml", AGENT), true); // path substring
});

test("ordinary files are not swept in (defaults stay narrow)", () => {
  assert.equal(isSensitiveReadTarget("/home/u/proj/src/main.ts", AGENT), false);
  assert.equal(isSensitiveReadTarget("/home/u/proj/src/tokenizer.ts", AGENT), false); // not "token" substring
  assert.equal(isSensitiveReadTarget("/home/u/proj/docs/author.md", AGENT), false); // not "auth" substring
  assert.equal(isSensitiveReadTarget("/etc/hostname", AGENT), false); // out of scope but not secret -> free
});

test("null agentDir: no carve-out, defaults still apply", () => {
  assert.equal(isSensitiveReadTarget("/home/u/.ssh/id_rsa", null), true);
  assert.equal(isSensitiveReadTarget("/home/u/proj/main.ts", null), false);
});

test("extra patterns from config extend the defaults", () => {
  assert.equal(
    isSensitiveReadTarget("/home/u/x/company.vault", AGENT, { basenames: ["company.vault"] }),
    true,
  );
  assert.equal(
    isSensitiveReadTarget("/home/u/private/notes.txt", AGENT, { pathSubstrings: ["/private/"] }),
    true,
  );
});
