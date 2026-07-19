/**
 * Pure argument parsing for the five control-plane commands. Parsing is
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

export type TaskCommand =
  | { kind: "show" }
  | { kind: "set"; text: string }
  | { kind: "clear"; force: boolean }
  | { kind: "accept" }
  | { kind: "reject" }
  | { kind: "usage" };

export function parseTaskArgs(args: string): TaskCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { kind: "show" };
  const [sub, ...rest] = trimmed.split(/\s+/);
  switch (sub.toLowerCase()) {
    case "set": {
      const text = trimmed.slice(sub.length).trim();
      return text.length > 0 ? { kind: "set", text } : { kind: "usage" };
    }
    case "clear":
      if (rest.length === 0) return { kind: "clear", force: false };
      if (rest.length === 1 && rest[0].toLowerCase() === "force") return { kind: "clear", force: true };
      return { kind: "usage" };
    case "accept":
      return rest.length === 0 ? { kind: "accept" } : { kind: "usage" };
    case "reject":
      return rest.length === 0 ? { kind: "reject" } : { kind: "usage" };
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
  // Aliases: attended is the plain "execute"; "restricted" alone means
  // execute-restricted; "sandboxed" keeps its honesty warning.
  if (trimmed === "execute-attended" || trimmed === "attended") {
    return { kind: "set", mode: "execute", sandboxAlias: false };
  }
  if (trimmed === "restricted") {
    return { kind: "set", mode: "execute-restricted", sandboxAlias: false };
  }
  if (trimmed === "sandboxed" || trimmed === "execute-sandboxed") {
    return { kind: "set", mode: "execute-restricted", sandboxAlias: true };
  }
  if ((MODES as readonly string[]).includes(trimmed)) {
    return { kind: "set", mode: trimmed as Mode, sandboxAlias: false };
  }
  return { kind: "usage", attempted: args.trim() };
}

export type InterpretCommand = { kind: "run"; request: string } | { kind: "usage" };

export function parseInterpretArgs(args: string): InterpretCommand {
  const trimmed = args.trim();
  return trimmed.length > 0 ? { kind: "run", request: trimmed } : { kind: "usage" };
}
