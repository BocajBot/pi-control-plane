/**
 * Guard installed Pi's native `/model` selector. Pi's bundled CLI is outside
 * this repository, but this is the executable the user invokes. Scoped
 * OpenRouter models must retain catalog price metadata after refresh.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dist = process.env.PI_CODING_AGENT_DIST ?? path.join(
  os.homedir(),
  ".local/lib/node_modules/@earendil-works/pi-coding-agent/dist",
);
const selector = path.join(dist, "modes/interactive/components/model-selector.js");
const bundleChunk = path.join(dist, "bundle/chunks/chunk-JVUZSMYM.js");

test("native /model preserves OpenRouter catalog pricing for scoped models", {
  skip: !fs.existsSync(selector) || !fs.existsSync(bundleChunk),
}, () => {
  const source = fs.readFileSync(selector, "utf8");
  const bundle = fs.readFileSync(bundleChunk, "utf8");
  const scopedFallback = /const model = this\.modelRuntime\.getModel\(scoped\.model\.provider, scoped\.model\.id\) \?\? scoped\.model;\s*const cost = model\.provider === "openrouter" && !model\.cost \? catalogCosts\.get\(model\.id\) : undefined;\s*return \{ \.\.\.scoped, model: cost \? \{ \.\.\.model, cost \} : model \};/s;

  assert.match(source, scopedFallback);
  assert.match(
    bundle,
    /let model=this\.modelRuntime\.getModel\(scoped\.model\.provider,scoped\.model\.id\)\?\?scoped\.model,cost=model\.provider==="openrouter"&&!model\.cost\?catalogCosts\.get\(model\.id\):void 0;return\{\.\.\.scoped,model:cost\?\{\.\.\.model,cost\}:model\}/,
  );
});
