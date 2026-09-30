/**
 * Guard installed Pi's native `/model` selector. Pi's bundled CLI is outside
 * this repository, but this is the executable the user invokes. Scoped
 * OpenRouter models must retain catalog price metadata after refresh.
 *
 * The patch is applied by scripts/patch-pi-model-selector.mjs. This test
 * checks three things, in order of how they have actually failed:
 *   1. the patched source module LOADS (a hand edit once wrote the config.js
 *      import one directory short; a body-only regex match did not catch it);
 *   2. the script's --check mode reports every hunk present (so a Pi
 *      reinstall that silently reverts the patch fails here, with the fix
 *      named in the output);
 *   3. the specific scoped-model fallback text is present in both files.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolvePiDist } from "../scripts/pi-dist.mjs";

const dist = resolvePiDist("modes/interactive/components/model-selector.js") ?? "";
const selector = path.join(dist, "modes/interactive/components/model-selector.js");
const patchScript = path.resolve("scripts/patch-pi-model-selector.mjs");

// The bundle chunk defining the model selector is hash-named by esbuild and
// changes on every Pi update; discover it exactly as the patch script does.
function findBundleChunk(): string | null {
  const dir = path.join(dist, "bundle/chunks");
  if (!fs.existsSync(dir)) return null;
  const hits = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(dir, f))
    .filter((f) => fs.readFileSync(f, "utf8").includes("loadModelsFromSnapshot(){"));
  return hits.length === 1 ? hits[0] : null;
}

test("native /model preserves OpenRouter catalog pricing for scoped models", {
  skip: !dist || !fs.existsSync(selector) || findBundleChunk() === null,
}, async () => {
  const bundleChunk = findBundleChunk();
  assert.ok(bundleChunk, "bundle chunk defining loadModelsFromSnapshot not found");
  // 1. The patched module must resolve every import it was given.
  await assert.doesNotReject(
    () => import(pathToFileURL(selector).href),
    `patched ${selector} does not load; run: node ${patchScript}`,
  );

  // 2. The patch script agrees the patch is fully present.
  const check = spawnSync(process.execPath, [patchScript, "--check", "--dist", dist], { encoding: "utf8" });
  assert.equal(check.status, 0, `patch-pi-model-selector --check failed:\n${check.stdout}${check.stderr}`);
  assert.doesNotMatch(check.stdout, /NEEDS PATCH|applied/, `patch not fully applied:\n${check.stdout}`);

  // 3. The scoped-model fallback text itself.
  const source = fs.readFileSync(selector, "utf8");
  const bundle = fs.readFileSync(bundleChunk!, "utf8");
  const scopedFallback = /const model = this\.modelRuntime\.getModel\(scoped\.model\.provider, scoped\.model\.id\) \?\? scoped\.model;\s*const cost = model\.provider === "openrouter" && !model\.cost \? catalogCosts\.get\(model\.id\) : undefined;\s*return \{ \.\.\.scoped, model: cost \? \{ \.\.\.model, cost \} : model \};/s;

  assert.match(source, scopedFallback);
  assert.match(
    bundle,
    /let model=this\.modelRuntime\.getModel\(scoped\.model\.provider,scoped\.model\.id\)\?\?scoped\.model,cost=model\.provider==="openrouter"&&!model\.cost\?catalogCosts\.get\(model\.id\):void 0;return\{\.\.\.scoped,model:cost\?\{\.\.\.model,cost\}:model\}/,
  );
});
