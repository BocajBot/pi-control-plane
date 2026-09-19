/**
 * Real Pi-loader verification of the consent-gated keybind claims: the
 * reserved shift+tab conflict, the keybindings.json unbind, and the
 * consent-driven registration must behave against pi's actual extension
 * loader, runner diagnostics, and KeybindingsManager — not just the fakes.
 * Skipped when no installed pi dist is present (PI_CODING_AGENT_DIST override).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const dist = [
  process.env.PI_CODING_AGENT_DIST,
  "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist",
  path.join(os.homedir(), ".local/lib/node_modules/@earendil-works/pi-coding-agent/dist"),
].find((p) => p && fs.existsSync(path.join(p, "core/extensions/loader.js")));

const CONSENT = {
  version: 1 as const,
  decidedAt: "2026-01-01T00:00:00.000Z",
};

/**
 * Diagnostics about the consent-gated key only. Unrelated built-in collisions
 * (e.g. alt+b shadowing tui.editor.cursorWordLeft for the bash widget) are not
 * this test's subject and would otherwise fail every zero-diagnostic check.
 */
function keyDiagnostics(diagnostics: { message: string }[]): { message: string }[] {
  return diagnostics.filter((d) => /shift\+tab|ctrl\+shift\+m/.test(d.message));
}

async function bootControlPlane(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { loadExtensions, createExtensionRuntime, clearExtensionCache } = await import(
    pathToFileURL(path.join(dist!, "core/extensions/loader.js")).href
  );
  const { ExtensionRunner } = await import(pathToFileURL(path.join(dist!, "core/extensions/runner.js")).href);
  const { KeybindingsManager } = await import(pathToFileURL(path.join(dist!, "core/keybindings.js")).href);
  const { initTheme } = await import(pathToFileURL(path.join(dist!, "modes/interactive/theme/theme.js")).href);
  initTheme("dark", false);
  clearExtensionCache();
  const runtime = createExtensionRuntime();
  const loaded = await loadExtensions([path.resolve("extensions/control-plane.ts")], process.cwd(), undefined, runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0]!;
  const runner = new ExtensionRunner(
    loaded.extensions,
    runtime,
    process.cwd(),
    { getBranch: () => [] },
    {},
  );
  const resolved = KeybindingsManager.create(agentDir).getResolvedBindings();
  const shortcutMap = runner.getShortcuts(resolved);
  const diagnostics = (runner as unknown as { shortcutDiagnostics: { message: string }[] }).shortcutDiagnostics;
  return { extension, shortcutMap, diagnostics };
}

test("reserved shift+tab claim activates only with recorded consent plus the keybindings.json unbind", {
  skip: !dist,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "keybind-consent-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    // No consent: no claim, no diagnostics, builtin thinking-cycle untouched.
    let { extension, shortcutMap, diagnostics } = await bootControlPlane(temp);
    assert.ok(extension.shortcuts.has("alt+p"), "alt+p is unconditional");
    assert.ok(!extension.shortcuts.has("shift+tab"), "no claim before consent");
    assert.ok(!shortcutMap.has("shift+tab"));
    assert.deepEqual(keyDiagnostics(diagnostics), []);
    assert.deepEqual((await KeybindingsResolvedFor(temp))["app.thinking.cycle"], "shift+tab"); // single binding resolves to a string

    // Claude consent recorded but the unbind never written: pi's own guard
    // skips the extension claim with a diagnostic warning.
    fs.writeFileSync(
      path.join(temp, "control-plane-keys.json"),
      JSON.stringify({ ...CONSENT, decision: "claude", unboundActions: ["app.thinking.cycle"] }),
    );
    ({ extension, shortcutMap, diagnostics } = await bootControlPlane(temp));
    assert.ok(extension.shortcuts.has("shift+tab"), "the extension tries to claim shift+tab...");
    assert.ok(!shortcutMap.has("shift+tab"), "...and pi's reserved-key guard skips it");
    assert.ok(
      diagnostics.some((d) => /shift\+tab.*conflicts with built-in shortcut/.test(d.message)),
      `expected the builtin-conflict diagnostic, got: ${JSON.stringify(diagnostics)}`,
    );

    // The unbind (what the consent dialog writes) flips pi's guard off: the
    // claim registers cleanly with no diagnostics.
    fs.writeFileSync(path.join(temp, "keybindings.json"), JSON.stringify({ "app.thinking.cycle": [] }));
    ({ extension, shortcutMap, diagnostics } = await bootControlPlane(temp));
    assert.ok(extension.shortcuts.has("shift+tab"));
    assert.ok(shortcutMap.has("shift+tab"), "claim wins after the consented unbind");
    assert.deepEqual(keyDiagnostics(diagnostics), []);
    assert.deepEqual((await KeybindingsResolvedFor(temp))["app.thinking.cycle"], []);

    // Custom recorded key: no reserved collision, registers as-is.
    fs.writeFileSync(
      path.join(temp, "control-plane-keys.json"),
      JSON.stringify({ ...CONSENT, decision: "custom", customKey: "ctrl+shift+m", unboundActions: [] }),
    );
    ({ extension, shortcutMap, diagnostics } = await bootControlPlane(temp));
    assert.ok(extension.shortcuts.has("ctrl+shift+m"));
    assert.ok(shortcutMap.has("ctrl+shift+m"));
    assert.ok(!extension.shortcuts.has("shift+tab"));
    assert.deepEqual(keyDiagnostics(diagnostics), []);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

/** Resolved bindings through pi's real KeybindingsManager for the temp dir (only entries with keys). */
async function KeybindingsResolvedFor(agentDir: string): Promise<Record<string, unknown>> {
  const { KeybindingsManager } = await import(pathToFileURL(path.join(dist!, "core/keybindings.js")).href);
  return KeybindingsManager.create(agentDir).getResolvedBindings() as Record<string, unknown>;
}
