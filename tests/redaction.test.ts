import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../src/control-plane/redaction.ts";

// All test credentials below are fabricated.

test("bearer tokens are redacted", () => {
  const result = redactSecrets("header: Bearer abc123def456ghi789 trailing");
  assert.ok(!result.text.includes("abc123def456ghi789"));
  assert.ok(result.text.includes("[REDACTED:bearer-token]"));
});

test("authorization headers are redacted, header name preserved", () => {
  const result = redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==');
  assert.ok(result.text.toLowerCase().includes("authorization"));
  assert.ok(!result.text.includes("dXNlcjpwYXNzd29yZA=="));
});

test("API keys are redacted (OpenAI, Anthropic, GitHub, AWS)", () => {
  const openai = redactSecrets("key=sk-FAKEFAKEFAKEFAKEFAKE1234");
  assert.ok(!openai.text.includes("sk-FAKEFAKEFAKEFAKEFAKE1234"));
  const anthropic = redactSecrets("sk-ant-FAKEFAKEFAKEFAKE-FAKE123");
  assert.ok(anthropic.text.includes("[REDACTED:anthropic-key]"));
  const github = redactSecrets("token ghp_FAKEFAKEFAKEFAKEFAKEFAKE12");
  assert.ok(github.text.includes("[REDACTED:github-token]"));
  const aws = redactSecrets("AKIAIOSFODNN7EXAMPLE");
  assert.ok(aws.text.includes("[REDACTED:aws-key-id]"));
});

test("JWTs are redacted", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.FAKEsignatureFAKE";
  const result = redactSecrets(`token: ${jwt}`);
  assert.ok(!result.text.includes(jwt));
  assert.ok(result.text.includes("[REDACTED:jwt]"));
});

test("password assignments are redacted, key name preserved", () => {
  const result = redactSecrets('db_password = "hunter2xyz"');
  assert.ok(result.text.includes("db_password"));
  assert.ok(!result.text.includes("hunter2xyz"));
  const yaml = redactSecrets("ADMIN_PASSWORD: supersecretvalue");
  assert.ok(!yaml.text.includes("supersecretvalue"));
});

test("private key blocks are redacted across lines", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEFAKE\nFAKEFAKE==\n-----END RSA PRIVATE KEY-----";
  const result = redactSecrets(`before\n${pem}\nafter`);
  assert.ok(!result.text.includes("MIIFAKEFAKE"));
  assert.ok(result.text.includes("[REDACTED:private-key]"));
  assert.ok(result.text.includes("before"));
  assert.ok(result.text.includes("after"));
});

test(".env style secrets are redacted, key name preserved", () => {
  const result = redactSecrets("HALOPSA_CLIENT_SECRET=abcdef123456\nNORMAL_FLAG=true");
  assert.ok(result.text.includes("HALOPSA_CLIENT_SECRET"));
  assert.ok(!result.text.includes("abcdef123456"));
  assert.ok(result.text.includes("NORMAL_FLAG=true"));
});

test("cookie headers are redacted", () => {
  const result = redactSecrets("Cookie: session=abc123; theme=dark");
  assert.ok(!result.text.includes("session=abc123"));
});

test("non-secret text remains readable and counts are reported", () => {
  const input = "The quick brown fox reads config.yaml and runs npm test. password_hint: use the usual one";
  const result = redactSecrets("Bearer tok_abcdef123456 " + input);
  assert.ok(result.text.includes("The quick brown fox reads config.yaml and runs npm test."));
  assert.equal(result.total >= 1, true);
  assert.ok(result.redactions["bearer-token"] >= 1);
});

test("redaction is deterministic", () => {
  const input = "Authorization: Bearer aaaa1111bbbb2222 and PASSWORD=qwertyuiop";
  assert.equal(redactSecrets(input).text, redactSecrets(input).text);
});
