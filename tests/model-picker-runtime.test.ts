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
