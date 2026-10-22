/** The packaged theme must pass the installed Pi's strict theme schema. */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolvePiDist } from "../scripts/pi-dist.mjs";

const dist = resolvePiDist();

test("pi-cyberpunk validates and loads against the installed Pi theme schema", {
  skip: !dist,
}, async () => {
  const theme = await import(
    pathToFileURL(path.join(dist!, "modes/interactive/theme/theme.js")).href
  );
  const schema = await import(
    pathToFileURL(path.join(dist!, "modes/interactive/theme/theme-schema.js")).href
  );
  // main.ts installs this validator before loading resources; without it the
  // loader accepts tokens the real startup path rejects (and drops the theme).
  theme.setThemeJsonValidator(schema.validateThemeJson);
  const loaded = theme.loadThemeFromPath(path.resolve(".pi/themes/pi-cyberpunk.json"));
  assert.equal(loaded.name, "pi-cyberpunk");
});
