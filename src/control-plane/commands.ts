/**
 * Pure argument parsing for the five control-plane commands. Parsing is
 * separated from execution so invalid-argument handling is unit-testable.
 */

import { normalizePhase, resolveAutonomyInput } from "./state.ts";
import type { Autonomy, Phase } from "./types.ts";

export type ContextCommand =
  | { kind: "summary" }
  | { kind: "diff" }
  | { kind: "full" }
  | { kind: "sources" }
  | { kind: "toggle"; name: string }
  | { kind: "restore" }
  | { kind: "profile"; name: string | null }
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

export type PhaseCommand =
  | { kind: "show" }
  | { kind: "set"; phase: Phase }
  | { kind: "usage"; attempted?: string };

export function parsePhaseArgs(args: string): PhaseCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { kind: "show" };
  const phase = normalizePhase(trimmed);
  return phase !== null ? { kind: "set", phase } : { kind: "usage", attempted: trimmed };
}

export type AutonomyCommand =
  | { kind: "show" }
  | { kind: "set"; autonomy: Autonomy; sandboxAlias: boolean }
  | { kind: "usage"; attempted?: string };

export function parseAutonomyArgs(args: string): AutonomyCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { kind: "show" };
  const resolved = resolveAutonomyInput(trimmed);
  if (resolved === null) return { kind: "usage", attempted: trimmed };
  return { kind: "set", autonomy: resolved.autonomy, sandboxAlias: resolved.sandboxAliasUsed };
}

export type InterpretCommand = { kind: "run"; request: string } | { kind: "usage" };

export function parseInterpretArgs(args: string): InterpretCommand {
  const trimmed = args.trim();
  return trimmed.length > 0 ? { kind: "run", request: trimmed } : { kind: "usage" };
}
