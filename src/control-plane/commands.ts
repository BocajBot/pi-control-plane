/**
 * Pure argument parsing for the control-plane commands. Parsing is
 * separated from execution so invalid-argument handling is unit-testable.
 */

import { type Mode, MODES } from "./state.ts";

export type ContextCommand =
  | { kind: "summary" }
  | { kind: "diff" }
  | { kind: "full" }
  | { kind: "sources" }
  | { kind: "toggle"; name: string }
  | { kind: "restore" }
  | { kind: "profile"; name: string | null }
  | { kind: "recount" }
  | { kind: "usage" };

export function parseContextArgs(args: string): ContextCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { kind: "summary" };
  const [sub, ...rest] = trimmed.split(/\s+/);
  switch (sub.toLowerCase()) {
    case "diff":
      return rest.length === 0 ? { kind: "diff" } : { kind: "usage" };
    case "full":
      return rest.length === 0 ? { kind: "full" } : { kind: "usage" };
    case "sources":
      return rest.length === 0 ? { kind: "sources" } : { kind: "usage" };
    case "toggle":
      return rest.length > 0 ? { kind: "toggle", name: rest.join(" ") } : { kind: "usage" };
    case "restore":
      return rest.length === 0 ? { kind: "restore" } : { kind: "usage" };
    case "profile":
      if (rest.length === 0) return { kind: "profile", name: null };
      return rest.length === 1 ? { kind: "profile", name: rest[0] } : { kind: "usage" };
    case "recount":
      return rest.length === 0 ? { kind: "recount" } : { kind: "usage" };
    default:
      return { kind: "usage" };
  }
}

export type ModeCommand =
  | { kind: "show" }
  | { kind: "set"; mode: Mode; sandboxAlias: boolean }
  | { kind: "usage"; attempted?: string };

export function parseModeArgs(args: string): ModeCommand {
  const trimmed = args.trim().toLowerCase();
  if (trimmed.length === 0) return { kind: "show" };
  // Back-compat aliases: the seven-mode vocabulary collapsed to four
  // (plan/manual/accept/auto), so old names keep working. NOTE the collision:
  // bare "auto" is now the NEW canonical full-autonomy mode (execute +
  // unattended), NOT the old accept-edits level - that level is "accept"
  // (aliases: accept-edits, execute-auto, auto-accept).
  if (trimmed === "discuss" || trimmed === "verify") {
    return { kind: "set", mode: "plan", sandboxAlias: false };
  }
  if (
    trimmed === "execute" ||
    trimmed === "execute-attended" ||
    trimmed === "attended" ||
    trimmed === "restricted" ||
    trimmed === "execute-restricted"
  ) {
    return { kind: "set", mode: "manual", sandboxAlias: false };
  }
  // "sandboxed" kept its honesty warning; the restricted mode it once selected
  // is gone. It degrades to the SAFEST mode (Plan / read-only), never to an
  // edit mode - a request to lock down must never escalate into edit power.
  if (trimmed === "sandboxed" || trimmed === "execute-sandboxed") {
    return { kind: "set", mode: "plan", sandboxAlias: true };
  }
  if (trimmed === "execute-auto" || trimmed === "accept-edits" || trimmed === "auto-accept") {
    return { kind: "set", mode: "accept", sandboxAlias: false };
  }
  if (trimmed === "unattended" || trimmed === "execute-unattended") {
    return { kind: "set", mode: "auto", sandboxAlias: false };
  }
  if ((MODES as readonly string[]).includes(trimmed)) {
    return { kind: "set", mode: trimmed as Mode, sandboxAlias: false };
  }
  return { kind: "usage", attempted: args.trim() };
}

export type ScratchpadCommand =
  | { kind: "show" }
  | { kind: "add"; text: string }
  | { kind: "remove"; id: string }
  | { kind: "clear"; force: boolean }
  | { kind: "usage" };

export function parseScratchpadArgs(args: string): ScratchpadCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { kind: "show" };
  const [sub, ...rest] = trimmed.split(/\s+/);
  switch (sub.toLowerCase()) {
    case "add": {
      const text = trimmed.slice(sub.length).trim();
      return text.length > 0 ? { kind: "add", text } : { kind: "usage" };
    }
    case "remove":
      return rest.length === 1 ? { kind: "remove", id: rest[0] } : { kind: "usage" };
    case "clear":
      if (rest.length === 0) return { kind: "clear", force: false };
      if (rest.length === 1 && rest[0].toLowerCase() === "force") return { kind: "clear", force: true };
      return { kind: "usage" };
    default:
      return { kind: "usage" };
  }
}

export type TaskCommand = { kind: "add"; text: string } | { kind: "usage" };

export function parseTaskArgs(args: string): TaskCommand {
  const match = /^add\s+([\s\S]+)$/i.exec(args.trim());
  return match && match[1].trim()
    ? { kind: "add", text: match[1].trim() }
    : { kind: "usage" };
}

export type BwrapCommand =
  | { kind: "status" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "network"; on: boolean }
  | { kind: "usage" };

export function parseBwrapArgs(args: string): BwrapCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { kind: "status" };
  const parts = trimmed.split(/\s+/);
  const [sub, ...rest] = parts;
  switch (sub.toLowerCase()) {
    case "status":
      return rest.length === 0 ? { kind: "status" } : { kind: "usage" };
    case "on":
      return rest.length === 0 ? { kind: "on" } : { kind: "usage" };
    case "off":
      return rest.length === 0 ? { kind: "off" } : { kind: "usage" };
    case "network":
      if (rest.length === 1 && rest[0].toLowerCase() === "on") return { kind: "network", on: true };
      if (rest.length === 1 && rest[0].toLowerCase() === "off") return { kind: "network", on: false };
      return { kind: "usage" };
    default:
      return { kind: "usage" };
  }
}
