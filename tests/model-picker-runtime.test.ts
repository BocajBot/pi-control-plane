/** Real Pi loader/SelectList/settings smoke; no provider calls or user settings writes. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { resolvePiDist } from "../scripts/pi-dist.mjs";

const dist = resolvePiDist();

test("/models Ctrl+s saves the filtered selection; Enter/Esc/failed switches do not save", {
  skip: !dist,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-picker-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temp;
  try {
    const settingsFile = path.join(temp, "settings.json");
    const original = { theme: "dark", defaultThinkingLevel: "medium", packages: ["keep"] };
    fs.writeFileSync(settingsFile, JSON.stringify(original));
    const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(path.join(dist!, "core/extensions/loader.js")).href);
    const { initTheme } = await import(pathToFileURL(path.join(dist!, "modes/interactive/theme/theme.js")).href);
    initTheme("dark", false);
    const runtime = createExtensionRuntime();
    const selected: string[] = [];
    let canSelect = true;
    runtime.setModel = async (m: { id: string }) => { selected.push(m.id); return canSelect; };
    const loaded = await loadExtensions([path.resolve("extensions/model-picker.ts")], process.cwd(), undefined, runtime);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    const command = extension.commands.get("models");
    const models = [{ provider: "test", id: "alpha" }, { provider: "test", id: "beta" }];
    const notices: string[] = [];
    let keys = ["beta", "\x13"];
    const ctx = {
      cwd: temp, mode: "tui", modelRegistry: { getAll: () => models },
      ui: {
        notify: (message: string) => notices.push(message),
        custom: async (factory: Function) => {
          let result: unknown;
          const component = factory({ requestRender() {} }, {}, {}, (value: unknown) => { result = value; });
          assert.match(component.render(80).join("\n"), /Ctrl\+s/);
          for (const line of component.render(20).slice(0, 3)) assert.ok(stripVTControlCharacters(line).length <= 20);
          for (const key of keys) component.handleInput(key);
          assert.notEqual(result, undefined, "picker must resolve");
          return result;
        },
      },
    };
    await command.handler("", ctx);
    assert.deepEqual(selected, ["beta"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), {
      ...original, defaultProvider: "test", defaultModel: "beta",
    });
    assert.match(notices.pop()!, /Default model saved: test\/beta/);
    const saved = fs.readFileSync(settingsFile, "utf8");
    keys = ["alpha", "\r"];
    await command.handler("", ctx);
    assert.equal(selected.at(-1), "alpha");
    assert.equal(fs.readFileSync(settingsFile, "utf8"), saved);
    keys = ["no-match", "\x13", "\x1b"];
    await command.handler("", ctx);
    assert.equal(selected.length, 2);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), saved);
    canSelect = false;
    keys = ["alpha", "\x13"];
    await command.handler("", ctx);
    assert.match(notices.pop()!, /default not saved/);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), saved);
    canSelect = true;
    fs.writeFileSync(settingsFile, "{broken");
    await command.handler("", ctx);
    assert.match(notices.pop()!, /saving the default failed/);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), "{broken");
    fs.writeFileSync(settingsFile, saved);
    keys = ["alpha", "\x1b[115;5u"]; // Kitty Ctrl+s
    await extension.shortcuts.get("alt+m").handler(ctx);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).defaultModel, "alpha");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("/models renders long model refs untruncated even with a description column", {
  skip: !dist,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-picker-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temp;
  try {
    fs.writeFileSync(path.join(temp, "settings.json"), "{}");
    const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(path.join(dist!, "core/extensions/loader.js")).href);
    const { initTheme } = await import(pathToFileURL(path.join(dist!, "modes/interactive/theme/theme.js")).href);
    initTheme("dark", false);
    const runtime = createExtensionRuntime();
    runtime.setModel = async () => true;
    const loaded = await loadExtensions([path.resolve("extensions/model-picker.ts")], process.cwd(), undefined, runtime);
    assert.deepEqual(loaded.errors, []);
    const command = loaded.extensions[0].commands.get("models");
    // 46-char ref: wider than pi-tui's 32-char default primary column. The
    // cost makes a description render, which is the path that truncates.
    const longId = "nemotron-3-5-lightning-30b-a3b".padEnd(41, "-");
    const ref = `openrouter/${longId}`;
    const models = [{ provider: "openrouter", id: longId, cost: { input: 1, output: 2 } }];
    let lines: string[] = [];
    const ctx = {
      cwd: temp, mode: "tui", modelRegistry: { getAll: () => models },
      ui: {
        notify: () => {},
        custom: async (factory: Function) => {
          const component = factory({ requestRender() {} }, {}, {}, () => {});
          lines = component.render(100).map((l: string) => stripVTControlCharacters(l));
          return { value: ref, saveDefault: false };
        },
      },
    };
    await command.handler("", ctx);
    assert.ok(
      lines.some((line) => line.includes(ref)),
      `full ref ${ref} must appear in the picker render; got:\n${lines.join("\n")}`,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("/models Tab cycles sort modes; order and header follow the mode", {
  skip: !dist,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-picker-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temp;
  try {
    fs.writeFileSync(path.join(temp, "settings.json"), "{}");
    const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(path.join(dist!, "core/extensions/loader.js")).href);
    const { initTheme } = await import(pathToFileURL(path.join(dist!, "modes/interactive/theme/theme.js")).href);
    initTheme("dark", false);
    const runtime = createExtensionRuntime();
    runtime.setModel = async () => true;
    const loaded = await loadExtensions([path.resolve("extensions/model-picker.ts")], process.cwd(), undefined, runtime);
    assert.deepEqual(loaded.errors, []);
    const command = loaded.extensions[0].commands.get("models");
    // name, price, provider and publisher orders are usage-independent, so
    // assertions hold against whatever real ~/.pi/agent/model-usage.json has.
    const models = [
      { provider: "openrouter", id: "alpha", cost: { input: 9, output: 9 } },
      { provider: "openrouter", id: "beta", cost: { input: 1, output: 2 } },
      { provider: "llama-swap", id: "zeta" },
      { provider: "openrouter", id: "anthropic/claude" },
    ];
    const refOrder = (lines: string[]): string[] =>
      lines.flatMap((l) => l.match(/(?:openrouter|llama-swap)\/\S+/g) ?? []);
    const rendered: string[][] = [];
    const ctx = {
      cwd: temp, mode: "tui", modelRegistry: { getAll: () => models },
      ui: {
        notify: () => {},
        custom: async (factory: Function) => {
          const component = factory({ requestRender() {} }, {}, {}, () => {});
          const snapshot = (): void => {
            rendered.push(component.render(100).map((l: string) => stripVTControlCharacters(l)));
          };
          snapshot(); // frecency
          component.handleInput("\t");
          snapshot(); // name
          component.handleInput("\t");
          snapshot(); // price
          component.handleInput("\t");
          snapshot(); // provider
          component.handleInput("\t");
          snapshot(); // publisher
          component.handleInput("\t");
          snapshot(); // back to frecency
          component.handleInput("\x1b");
          return null;
        },
      },
    };
    await command.handler("", ctx);
    assert.equal(rendered.length, 6);
    assert.match(rendered[0].join("\n"), /Tab sort: frecency/);
    assert.match(rendered[1].join("\n"), /Tab sort: name/);
    assert.deepEqual(refOrder(rendered[1]), [
      "llama-swap/zeta", "openrouter/alpha", "openrouter/anthropic/claude", "openrouter/beta",
    ]);
    assert.match(rendered[2].join("\n"), /Tab sort: price/);
    // Cheapest input first, unpriced last.
    assert.deepEqual(refOrder(rendered[2]), [
      "openrouter/beta", "openrouter/alpha", "llama-swap/zeta", "openrouter/anthropic/claude",
    ]);
    assert.match(rendered[3].join("\n"), /Tab sort: provider/);
    // Registry provider groups: llama-swap, then openrouter (name order inside).
    assert.deepEqual(refOrder(rendered[3]), [
      "llama-swap/zeta", "openrouter/alpha", "openrouter/anthropic/claude", "openrouter/beta",
    ]);
    assert.match(rendered[4].join("\n"), /Tab sort: publisher/);
    // Upstream publisher groups: anthropic, llama-swap (no id segment), z-ai…
    // here: anthropic < llama-swap < openrouter (ids without a segment).
    assert.deepEqual(refOrder(rendered[4]), [
      "openrouter/anthropic/claude", "llama-swap/zeta", "openrouter/alpha", "openrouter/beta",
    ]);
    assert.match(rendered[5].join("\n"), /Tab sort: frecency/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
