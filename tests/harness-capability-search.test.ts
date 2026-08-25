import assert from "node:assert/strict";
import test from "node:test";

import { matchingUserGrants, needTerms, searchCapabilities } from "../src/harness/capability-search.ts";
import { describeAvailable, resolveDelegateModel } from "../src/harness/delegate-model.ts";

const CATALOG = [
  { name: "pi_harness_bash", description: "Run a shell command inside an OS-level sandbox (bubblewrap). Network is unshared unless the scope grants it." },
  { name: "harness_delegate", description: "Consult a read-only advisor, run a bounded subagent, or run a bounded operator." },
  { name: "read", description: "Read a file from the scope root." },
];

test("a natural-language need matches by terms, not by whole-sentence substring", () => {
  // The pre-fix implementation substring-matched the entire need, so a need
  // phrased as a sentence could only match a description containing that
  // sentence verbatim - i.e. never. It reported "No capability matches" for
  // a shell tool that was present and loaded.
  const need = "run a command on the host outside the bubblewrap sandbox, with network access";
  assert.equal(
    CATALOG.some((tool) => (tool.description ?? "").toLowerCase().includes(need.toLowerCase())),
    false,
    "precondition: no description contains the whole need",
  );

  const hits = searchCapabilities(need, CATALOG);
  assert.equal(hits[0]?.name, "pi_harness_bash");
});

test("a single-word need still matches by substring, ranked first", () => {
  const hits = searchCapabilities("shell", CATALOG);
  assert.equal(hits[0]?.name, "pi_harness_bash");
});

test("a need matching nothing returns no hits rather than the whole catalog", () => {
  assert.deepEqual(searchCapabilities("photosynthesis", CATALOG), []);
});

test("stopwords and short words carry no signal", () => {
  assert.deepEqual(needTerms("I want to be able to use the network"), ["able", "network"]);
});

test("a network need surfaces the user-only grant that unblocks it", () => {
  // The case that produced this: a delegate concluded the task was impossible
  // because no TOOL grants networking. The grant exists, but only the user can
  // apply it, so it has to be reported as something to ask for.
  const grants = matchingUserGrants("reach localhost port 9292 over http from the sandbox");
  assert.equal(grants[0]?.command, "/harness scope network on");
});

test("a need with no matching grant offers none", () => {
  assert.deepEqual(matchingUserGrants("photosynthesis"), []);
});

const MODELS = [
  { provider: "llama-swap", id: "qwen3-8-27b-thinking" },
  { provider: "openrouter", id: "deepseek/deepseek-v4-pro-0813" },
  { provider: "llama-swap", id: "shared-id" },
  { provider: "openrouter", id: "shared-id" },
];

test("provider/id resolves exactly", () => {
  const resolved = resolveDelegateModel("llama-swap/qwen3-8-27b-thinking", MODELS);
  assert.equal(resolved.ok && resolved.model.provider, "llama-swap");
});

test("a bare id resolves when only one provider offers it", () => {
  const resolved = resolveDelegateModel("qwen3-8-27b-thinking", MODELS);
  assert.equal(resolved.ok && resolved.model.provider, "llama-swap");
});

test("an ambiguous bare id is refused, not guessed", () => {
  // Guessing would silently route the delegate to a different model, and a
  // different bill, than the caller named.
  const resolved = resolveDelegateModel("shared-id", MODELS);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.reason, /provider\/id/);
});

test("an unknown model is refused and the refusal names what was available", () => {
  const resolved = resolveDelegateModel("no-such-model", MODELS);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.reason, /llama-swap\/qwen3-8-27b-thinking/);
});

test("the available list is truncated rather than dumped", () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ provider: "p", id: `m${index}` }));
  assert.match(describeAvailable(many), /and 10 more/);
});
