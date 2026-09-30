/**
 * Locate the installed Pi's `dist/` directory. Shared by the /model pricing
 * patch script and the runtime tests so every consumer agrees on the answer.
 *
 * Order (first hit wins):
 *   1. $PI_CODING_AGENT_DIST
 *   2. Pi's managed install (0.86+): ~/.pi/agent/install/current-version names
 *      the release, whose package tree holds the runtime pi actually runs.
 *   3. Legacy global npm prefixes (~/.local, /opt/homebrew).
 *
 * `pi update` swaps the release directory, so the resolved path changes with
 * every version — never hard-code a release number.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG_DIST = "node_modules/@earendil-works/pi-coding-agent/dist";

function managedInstallDist() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  const versionFile = path.join(agentDir, "install/current-version");
  if (!fs.existsSync(versionFile)) return undefined;
  const version = fs.readFileSync(versionFile, "utf8").trim();
  return version ? path.join(agentDir, "install/releases", version, PKG_DIST) : undefined;
}

/** All candidate dist directories, in priority order (may include non-existent paths). */
export function piDistCandidates() {
  return [
    process.env.PI_CODING_AGENT_DIST,
    managedInstallDist(),
    path.join(os.homedir(), ".local/lib", PKG_DIST),
    "/opt/homebrew/lib/" + PKG_DIST,
  ].filter((p) => typeof p === "string" && p.length > 0);
}

/** First candidate that contains `marker` (default: the extension loader), or undefined. */
export function resolvePiDist(marker = "core/extensions/loader.js") {
  return piDistCandidates().find((p) => fs.existsSync(path.join(p, marker)));
}
