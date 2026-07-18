import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyContextFileToggles,
  exciseExact,
  replaceSkillsBlock,
  toggleName,
} from "../src/control-plane/toggles.ts";

test("exciseExact removes the block and verifies absence", () => {
  const result = exciseExact("start MIDDLE end", "MIDDLE ");
  assert.equal(result, "start end");
});

test("exciseExact fails honestly when the block is absent", () => {
  assert.equal(exciseExact("start end", "MIDDLE"), null);
  assert.equal(exciseExact("anything", ""), null);
});

test("disabled context files are excised; enabled files untouched", () => {
  const fileA = { path: "/p/AGENTS.md", content: "AGENTS CONTENT BLOCK" };
  const fileB = { path: "/p/OTHER.md", content: "OTHER CONTENT BLOCK" };
  const prompt = `prefix\nAGENTS CONTENT BLOCK\nmiddle\nOTHER CONTENT BLOCK\nsuffix`;
  const result = applyContextFileToggles(prompt, [fileA, fileB], {
    [toggleName.contextFile("/p/AGENTS.md")]: false,
  });
  assert.ok(!result.prompt.includes("AGENTS CONTENT BLOCK"));
  assert.ok(result.prompt.includes("OTHER CONTENT BLOCK"));
  assert.deepEqual(result.failed, []);
});

test("failed excision is reported so the source can be re-enabled (honesty rule)", () => {
  const file = { path: "/p/AGENTS.md", content: "CONTENT THAT IS NOT IN THE PROMPT" };
  const result = applyContextFileToggles("some prompt", [file], {
    [toggleName.contextFile("/p/AGENTS.md")]: false,
  });
  assert.equal(result.prompt, "some prompt");
  assert.deepEqual(result.failed, [toggleName.contextFile("/p/AGENTS.md")]);
});

test("empty context files toggle cleanly (nothing to excise)", () => {
  const file = { path: "/p/EMPTY.md", content: "   " };
  const result = applyContextFileToggles("prompt", [file], {
    [toggleName.contextFile("/p/EMPTY.md")]: false,
  });
  assert.deepEqual(result.failed, []);
});

test("skills block replacement swaps full block for filtered block", () => {
  const full = "## Skills\n- alpha: does a\n- beta: does b";
  const filtered = "## Skills\n- alpha: does a";
  const prompt = `intro\n${full}\noutro`;
  const result = replaceSkillsBlock(prompt, full, filtered);
  assert.equal(result, `intro\n${filtered}\noutro`);
});

test("skills block replacement fails honestly when block not found", () => {
  assert.equal(replaceSkillsBlock("no skills here", "## Skills\n- x", "## Skills"), null);
  assert.equal(replaceSkillsBlock("prompt", "", "anything"), null);
});

test("toggle names are stable and namespaced", () => {
  assert.equal(toggleName.contextFile("/a/b.md"), "file:/a/b.md");
  assert.equal(toggleName.skill("s"), "skill:s");
  assert.equal(toggleName.tool("bash"), "tool:bash");
  assert.equal(toggleName.template("t"), "template:t");
});
