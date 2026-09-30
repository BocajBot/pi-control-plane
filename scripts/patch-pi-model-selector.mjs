#!/usr/bin/env node
/**
 * Re-apply the local "OpenRouter catalog pricing in /model" patch to an
 * installed Pi. Pi's bundled CLI lives outside this repo and `npm install`
 * overwrites it, so the patch is kept here as anchored string replacements
 * instead of hand edits.
 *
 * Two targets, both patched idempotently:
 *   1. dist/modes/interactive/components/model-selector.js (readable source,
 *      loaded by tests/model-picker-runtime.test.ts). The `config.js` import
 *      is written as a path COMPUTED from the target file's own directory —
 *      never a hand-counted `../..` (that is exactly what broke on
 *      2026-09-19: one `..` short, "Cannot find module dist/modes/config.js").
 *   2. dist/bundle/chunks/<the chunk defining the model selector>.js — the
 *      executable pi actually runs. Minified, so the fs/path alias names are
 *      discovered from the chunk's own import statements, not assumed.
 *
 * Every anchor must match exactly once (or the patched form already be
 * present). Anything else aborts with a message and no writes. A backup of
 * each file it changes is written next to it as `<file>.pre-patch.bak`.
 *
 * Usage: node scripts/patch-pi-model-selector.mjs [--check] [--dist <dir>]
 *   --check  report status, write nothing (exit 1 if a patch is missing)
 *   --dist   Pi dist directory (default: $PI_CODING_AGENT_DIST, else the
 *            managed install under ~/.pi/agent/install, else a legacy global
 *            npm prefix — see scripts/pi-dist.mjs)
 */
import fs from "node:fs";
import path from "node:path";
import { piDistCandidates, resolvePiDist } from "./pi-dist.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const distArg = args[args.indexOf("--dist") + 1];
const explicitDist = args.includes("--dist") && distArg ? path.resolve(distArg) : undefined;
const dist = explicitDist ?? resolvePiDist("modes/interactive/components/model-selector.js");
if (dist === undefined) {
  console.error("no installed Pi dist found; looked in:");
  for (const c of piDistCandidates()) console.error(`  ${c}`);
  process.exit(2);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Count non-overlapping occurrences. */
const count = (text, needle) => text.split(needle).length - 1;

/**
 * Apply one anchored replacement. Returns the new text and what happened.
 * `pristine` must occur exactly once unless `patched` is already present.
 */
function applyHunk(text, { name, pristine, patched }) {
  if (text.includes(patched)) return { text, status: "already" };
  const n = count(text, pristine);
  if (n !== 1) {
    throw new Error(`${name}: anchor matched ${n} times (expected 1); refusing to patch`);
  }
  // Function form: a string replacement would interpret `$$`/`$&` patterns in
  // the patched text (the render line contains `$${...}`).
  return { text: text.replace(pristine, () => patched), status: "applied" };
}

function patchFile(file, hunks) {
  const original = fs.readFileSync(file, "utf8");
  let text = original;
  const statuses = [];
  for (const hunk of hunks) {
    const r = applyHunk(text, hunk);
    text = r.text;
    statuses.push(`${hunk.name}: ${r.status}`);
  }
  const changed = text !== original;
  if (changed && !check) {
    fs.writeFileSync(`${file}.pre-patch.bak`, original);
    fs.writeFileSync(file, text);
  }
  return { changed, statuses };
}

// ---------------------------------------------------------------- source ----

function sourceHunks(selectorFile) {
  // Import path computed from where the file lives, POSIX separators, leading
  // "./" or "../" guaranteed for ESM.
  let rel = path.relative(path.dirname(selectorFile), path.join(dist, "config.js")).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return [
    {
      name: "source: imports",
      pristine:
        'import { modelsAreEqual } from "@earendil-works/pi-ai";\n' +
        'import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text, } from "@earendil-works/pi-tui";\n',
      patched:
        'import { modelsAreEqual } from "@earendil-works/pi-ai";\n' +
        'import { readFileSync } from "node:fs";\n' +
        'import { join } from "node:path";\n' +
        `import { getAgentDir } from "${rel}";\n` +
        'import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text, } from "@earendil-works/pi-tui";\n',
    },
    {
      name: "source: loadModelsFromSnapshot",
      pristine:
        "    loadModelsFromSnapshot() {\n" +
        "        const models = this.modelRuntime.getAvailableSnapshot().map((model) => ({\n" +
        "            provider: model.provider,\n" +
        "            id: model.id,\n" +
        "            model,\n" +
        "        }));\n" +
        "        this.allModels = this.sortModels(models);\n" +
        "        this.scopedModels = this.scopedModels.map((scoped) => {\n" +
        "            const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);\n" +
        "            return refreshed ? { ...scoped, model: refreshed } : scoped;\n" +
        "        });\n",
      patched:
        "    getOpenRouterCosts() {\n" +
        "        try {\n" +
        '            const catalog = JSON.parse(readFileSync(join(getAgentDir(), "models-store.json"), "utf8"));\n' +
        "            return new Map((catalog.openrouter?.models ?? []).filter((model) => model?.id && model?.cost).map((model) => [model.id, model.cost]));\n" +
        "        }\n" +
        "        catch {\n" +
        "            return new Map();\n" +
        "        }\n" +
        "    }\n" +
        "    loadModelsFromSnapshot() {\n" +
        "        const catalogCosts = this.getOpenRouterCosts();\n" +
        "        const models = this.modelRuntime.getAvailableSnapshot().map((model) => {\n" +
        '            const cost = model.provider === "openrouter" && !model.cost ? catalogCosts.get(model.id) : undefined;\n' +
        "            return { provider: model.provider, id: model.id, model: cost ? { ...model, cost } : model };\n" +
        "        });\n" +
        "        this.allModels = this.sortModels(models);\n" +
        "        this.scopedModels = this.scopedModels.map((scoped) => {\n" +
        "            const model = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id) ?? scoped.model;\n" +
        '            const cost = model.provider === "openrouter" && !model.cost ? catalogCosts.get(model.id) : undefined;\n' +
        "            return { ...scoped, model: cost ? { ...model, cost } : model };\n" +
        "        });\n",
    },
    {
      name: "source: getCostBadge",
      pristine:
        "        return sorted;\n" +
        "    }\n" +
        "    getScopeText() {\n",
      patched:
        "        return sorted;\n" +
        "    }\n" +
        "    getCostBadge(model) {\n" +
        '        if (model.provider !== "openrouter" || !model.cost)\n' +
        '            return "";\n' +
        "        const fmt = (rate) => {\n" +
        "            if (!Number.isFinite(rate))\n" +
        '                return "?";\n' +
        "            if (rate === 0)\n" +
        '                return "0";\n' +
        "            return String(parseFloat(rate.toPrecision(3)));\n" +
        "        };\n" +
        '        const tierMark = model.cost.tiers?.length ? "+" : "";\n' +
        "        return theme.fg(\"dim\", `  $${fmt(model.cost.input)}/$${fmt(model.cost.output)}${tierMark} per Mtok`);\n" +
        "    }\n" +
        "    getScopeText() {\n",
    },
    {
      name: "source: render line",
      pristine:
        "            const line = `${cursor}${currentMarker}${modelText} ${providerBadge}${defaultBadge}`;\n",
      patched:
        "            const costBadge = this.getCostBadge(item.model);\n" +
        "            const line = `${cursor}${currentMarker}${modelText} ${providerBadge}${costBadge}${defaultBadge}`;\n",
    },
  ];
}

// ---------------------------------------------------------------- bundle ----

/** Find the bundle chunk that defines the model selector's snapshot loader. */
function findBundleChunk() {
  const dir = path.join(dist, "bundle/chunks");
  if (!fs.existsSync(dir)) return null;
  const hits = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(dir, f))
    .filter((f) => fs.readFileSync(f, "utf8").includes("loadModelsFromSnapshot(){"));
  if (hits.length !== 1) throw new Error(`bundle: expected exactly one chunk defining loadModelsFromSnapshot, found ${hits.length}`);
  return hits[0];
}

/**
 * Discover the minified alias for a named import in this chunk. esbuild keeps
 * every module's imports at chunk top level (all in scope everywhere), and
 * re-aliases the same name per module (readFileSync3, readFileSync15, ...).
 * Any of them would work; use the one declared nearest BEFORE `before` so the
 * output matches what a hand edit in that module region would have used.
 */
function alias(chunk, name, modules, before) {
  let best = null;
  for (const mod of modules) {
    const re = new RegExp(`import\\{([^}]*)\\}from"${escapeRegExp(mod)}"`, "g");
    for (const m of chunk.matchAll(re)) {
      if (m.index >= before) continue;
      for (const spec of m[1].split(",")) {
        const [orig, as] = spec.trim().split(/\s+as\s+/);
        if (orig === name && (best === null || m.index > best.index)) best = { index: m.index, alias: as ?? orig };
      }
    }
  }
  if (best === null) throw new Error(`bundle: no import of ${name} from ${modules.join("|")} before the model selector`);
  return best.alias;
}

function bundleHunks(chunk) {
  const at = chunk.indexOf("loadModelsFromSnapshot(){");
  // If the patch is already present, reuse the aliases it was written with so
  // the idempotence check compares against the real text, not a re-guess.
  const existing = /getOpenRouterCosts\(\)\{try\{return new Map\(\(JSON\.parse\((\w+)\((\w+)\(getAgentDir\(\)/.exec(chunk);
  const readFileSync = existing?.[1] ?? alias(chunk, "readFileSync", ["fs", "node:fs"], at);
  const join = existing?.[2] ?? alias(chunk, "join", ["path", "node:path"], at);
  if (!/function getAgentDir\(\)\{/.test(chunk)) throw new Error("bundle: getAgentDir not defined in this chunk");
  return [
    {
      name: "bundle: loadModelsFromSnapshot",
      pristine:
        "loadModelsFromSnapshot(){let models=this.modelRuntime.getAvailableSnapshot().map(model=>({provider:model.provider,id:model.id,model}));" +
        "this.allModels=this.sortModels(models),this.scopedModels=this.scopedModels.map(scoped=>{let refreshed=this.modelRuntime.getModel(scoped.model.provider,scoped.model.id);return refreshed?{...scoped,model:refreshed}:scoped}),",
      patched:
        `getOpenRouterCosts(){try{return new Map((JSON.parse(${readFileSync}(${join}(getAgentDir(),"models-store.json"))).openrouter?.models??[]).filter(model=>model?.id&&model?.cost).map(model=>[model.id,model.cost]))}catch{return new Map}}` +
        "loadModelsFromSnapshot(){let catalogCosts=this.getOpenRouterCosts(),models=this.modelRuntime.getAvailableSnapshot().map(model=>{let cost=model.provider===\"openrouter\"&&!model.cost?catalogCosts.get(model.id):void 0;return{provider:model.provider,id:model.id,model:cost?{...model,cost}:model}});" +
        "this.allModels=this.sortModels(models),this.scopedModels=this.scopedModels.map(scoped=>{let model=this.modelRuntime.getModel(scoped.model.provider,scoped.model.id)??scoped.model,cost=model.provider===\"openrouter\"&&!model.cost?catalogCosts.get(model.id):void 0;return{...scoped,model:cost?{...model,cost}:model}}),",
    },
    {
      name: "bundle: render line",
      pristine:
        "providerBadge=theme.fg(\"muted\",`[${item.provider}]`),line=`${cursor}${currentMarker}${modelText} ${providerBadge}${defaultBadge}`;",
      patched:
        "providerBadge=theme.fg(\"muted\",`[${item.provider}]`),cost=item.provider===\"openrouter\"&&item.model.cost?theme.fg(\"dim\",`  $${item.model.cost.input}/$${item.model.cost.output} per Mtok`):\"\",line=`${cursor}${currentMarker}${modelText} ${providerBadge}${cost}${defaultBadge}`;",
    },
  ];
}

// ------------------------------------------------------------------ main ----

const selectorFile = path.join(dist, "modes/interactive/components/model-selector.js");
if (!fs.existsSync(selectorFile)) {
  console.error(`not found: ${selectorFile}`);
  process.exit(2);
}

let missing = false;
try {
  const src = patchFile(selectorFile, sourceHunks(selectorFile));
  console.log(`${path.relative(dist, selectorFile)}: ${src.changed ? (check ? "NEEDS PATCH" : "patched") : "up to date"}`);
  for (const s of src.statuses) console.log(`  ${s}`);
  if (src.changed && check) missing = true;

  const chunkFile = findBundleChunk();
  if (chunkFile === null) {
    console.log("bundle/chunks: not present, skipped");
  } else {
    const chunk = fs.readFileSync(chunkFile, "utf8");
    const b = patchFile(chunkFile, bundleHunks(chunk));
    console.log(`${path.relative(dist, chunkFile)}: ${b.changed ? (check ? "NEEDS PATCH" : "patched") : "up to date"}`);
    for (const s of b.statuses) console.log(`  ${s}`);
    if (b.changed && check) missing = true;
  }
} catch (err) {
  console.error(`aborted, nothing written: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Prove the patched source actually loads (this is what the hand edit broke).
try {
  await import(new URL(`file://${selectorFile}`).href);
  console.log("source module import: ok");
} catch (err) {
  console.error(`source module import FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
process.exit(missing ? 1 : 0);
