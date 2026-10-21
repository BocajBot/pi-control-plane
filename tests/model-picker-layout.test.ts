/** Model picker rows must show the whole provider/id reference, not clip it. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { resolvePiDist } from "../scripts/pi-dist.mjs";

const dist = resolvePiDist();

test("picker rows render long model references in full on a normal terminal", {
  skip: !dist,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-picker-layout-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temp;
  try {
    const { loadExtensions, createExtensionRuntime } = await import(
      pathToFileURL(path.join(dist!, "core/extensions/loader.js")).href
    );
    const { initTheme } = await import(
      pathToFileURL(path.join(dist!, "modes/interactive/theme/theme.js")).href
    );
    initTheme("dark", false);
    const runtime = createExtensionRuntime();
    runtime.setModel = async () => true;
    const loaded = await loadExtensions(
      [path.resolve("extensions/model-picker.ts")],
      process.cwd(),
      undefined,
      runtime,
    );
    assert.deepEqual(loaded.errors, []);
    const command = loaded.extensions[0].commands.get("models");

    // Longer than SelectList's default 32-char label column.
    const longKey = "openrouter/anthropic/claude-sonnet-4.5-thinking";
    const models = [
      {
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4.5-thinking",
        cost: { input: 3, output: 15 },
      },
      {
        provider: "openrouter",
        id: "qwen/qwen3-coder-480b-a35b-instruct",
        cost: { input: 0.2, output: 0.8 },
      },
    ];
    let lines: string[] = [];
    const ctx = {
      cwd: temp,
      mode: "tui",
      modelRegistry: { getAll: () => models },
      ui: {
        notify: () => {},
        custom: async (factory: Function) => {
          let result: unknown;
          const component = factory(
            { requestRender() {} },
            {},
            {},
            (value: unknown) => {
              result = value;
            },
          );
          lines = component.render(120).map((line: string) => stripVTControlCharacters(line));
          component.handleInput("\x1b");
          return result;
        },
      },
    };

    await command.handler("", ctx);

    const row = lines.find((line) => line.includes("openrouter/anthropic/claude-sonnet"));
    assert.ok(row, "the long model row is visible");
    assert.ok(row!.includes(longKey), `full model reference kept in row: ${row}`);
    assert.match(row!, /\$3\/\$15 per Mtok/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
