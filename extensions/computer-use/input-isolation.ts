/**
 * MPX input isolation (XInput2 multi-pointer).
 *
 * Problem (observed 2026-09-29): physical mouse movement interleaves with
 * synthetic XTEST input because both drive the SAME master pointer
 * ("Virtual core pointer"). A demo click miss could not be attributed to
 * the model.
 *
 * Fix per Multi-pointer X (wiki.archlinux.org/title/Multi-pointer_X):
 *   xinput --create-master "CU-Agent"
 *   physical devices STAY on the core masters (the user keeps their cursor)
 *   xdotool is steered onto "CU-Agent pointer" by cu-client-pointer.so
 *   (LD_PRELOAD; XISetClientPointer) -> its XTEST input drives the SECOND
 *   cursor only. Verified: agent moved to (300,900), core stayed put.
 * The user's mouse and the agent's synthetic input become independent
 * master cursors and cannot displace each other. Fully reversible.
 *
 * Superseded layout (until 2026-09-29): physical slaves were moved to a
 * "CU-Human" master and the agent kept the core cursor; on restore the
 * user's cursor jumped to wherever the agent had left the core pointer.
 */

import { execFileSync } from "node:child_process";

export interface IsolationHandle {
  /** Master pointer id the agent drives (CU_CLIENT_POINTER for the shim). */
  agentPointer: number;
  agentKeyboard: number;
}

interface Dev {
  name: string;
  id: number;
  kind: "pointer" | "keyboard";
  master: number; // parent master id for slaves; self id for masters
}

function xinput(args: string[], display: string): string {
  return execFileSync("xinput", args, {
    env: { ...process.env, DISPLAY: display },
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listDevices(display: string): { masters: Map<string, number>; slaves: Dev[] } {
  const out = xinput(["--list", "--short"], display);
  const masters = new Map<string, number>();
  const slaves: Dev[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*[⎡⎣⎜│↳ ]*(.+?)\s+id=(\d+)\s+\[(master|slave)\s+(pointer|keyboard)\s*\((\d+)\)/);
    if (!m) continue;
    const name = m[1].trim();
    const id = Number(m[2]);
    if (m[3] === "master") masters.set(name, id);
    else slaves.push({ name, id, kind: m[4] as "pointer" | "keyboard", master: Number(m[5]) });
  }
  return { masters, slaves };
}

function coreMasterIds(display: string): { coreP: number; coreK: number } {
  const { masters } = listDevices(display);
  const coreP = masters.get("Virtual core pointer");
  const coreK = masters.get("Virtual core keyboard");
  if (coreP === undefined || coreK === undefined) throw new Error("core masters not found");
  return { coreP, coreK };
}

/**
 * Create the "CU-Agent" master pair. Nothing is reattached: the core
 * pointer/keyboard keep every physical device.
 */
export function isolateInput(display: string): IsolationHandle {
  // Idempotent: collapse any leftover isolation first.
  restoreStray(display);
  xinput(["--create-master", "CU-Agent"], display);
  const { masters } = listDevices(display);
  const agentPointer = masters.get("CU-Agent pointer");
  const agentKeyboard = masters.get("CU-Agent keyboard");
  if (agentPointer === undefined || agentKeyboard === undefined) throw new Error("CU-Agent masters were not created");
  return { agentPointer, agentKeyboard };
}

/** Drop the CU-Agent master pair. */
export function restoreInput(display: string, h: IsolationHandle): void {
  try { xinput(["--remove-master", String(h.agentKeyboard)], display); } catch { /* pair may already be gone */ }
  try { xinput(["--remove-master", String(h.agentPointer)], display); } catch { /* pair may already be gone */ }
}

/**
 * Recovery path: drop a leftover CU-Agent pair, and collapse a leftover
 * CU-Human pair from the superseded layout (move its slaves home).
 */
export function restoreStray(display: string): void {
  const { masters, slaves } = listDevices(display);
  const agentP = masters.get("CU-Agent pointer");
  const agentK = masters.get("CU-Agent keyboard");
  if (agentK !== undefined) { try { xinput(["--remove-master", String(agentK)], display); } catch { /* */ } }
  if (agentP !== undefined) { try { xinput(["--remove-master", String(agentP)], display); } catch { /* */ } }
  const humanP = masters.get("CU-Human pointer");
  const humanK = masters.get("CU-Human keyboard");
  if (humanP === undefined && humanK === undefined) return;
  const { coreP, coreK } = coreMasterIds(display);
  for (const s of slaves) {
    if (s.kind === "pointer" && humanP !== undefined && s.master === humanP) {
      try { xinput(["--reattach", String(s.id), String(coreP)], display); } catch { /* best effort */ }
    }
    if (s.kind === "keyboard" && humanK !== undefined && s.master === humanK) {
      try { xinput(["--reattach", String(s.id), String(coreK)], display); } catch { /* best effort */ }
    }
  }
  if (humanK !== undefined) { try { xinput(["--remove-master", String(humanK)], display); } catch { /* */ } }
  if (humanP !== undefined) { try { xinput(["--remove-master", String(humanP)], display); } catch { /* */ } }
}
