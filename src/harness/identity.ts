/**
 * Pi Harness - identity state (spec sections 1, 2.1, 17).
 *
 * "Pi presents the same personality and baseline behavior across devices and
 * sessions. Pi's identity is not the currently loaded model." This module is
 * the durable side of that claim: three plain lists that outlive any session
 * and any coordinator, and that get injected into every session's prompt.
 *
 * Pure. store.ts persists it.
 *
 * One rule does all the work here, and it is the same shape as M1 in
 * memory.ts: **only the user writes identity.** A coordinator that could
 * append to its own operating principles could rewrite what it is, one
 * plausible sentence at a time, and every later session would inherit the
 * drift as though the user had asked for it. A reviewer that concludes
 * identity should change records that as a memory proposal for a human to
 * promote; it does not edit this file.
 *
 * That is deliberately stricter than memory promotion, which reviewers may
 * do. Memory is what Pi knows. Identity is what Pi is.
 */

import { HARNESS_SCHEMA_VERSION, type Actor, type IdentityState } from "./types.ts";
import { nowIso, type Clock } from "./util.ts";

export type IdentityField = "principle" | "preference" | "behavior";

export function emptyIdentity(clock: Clock = () => new Date()): IdentityState {
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    principles: [],
    preferences: [],
    behaviors: [],
    updatedAt: nowIso(clock),
    updatedBy: "user",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/** Strict validation; anything unexpected yields null and the caller falls
 * back to `emptyIdentity()`. A half-understood identity file is worse than
 * none: it would silently drop principles while appearing to load. */
export function validateIdentity(value: unknown): IdentityState | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== HARNESS_SCHEMA_VERSION) return null;
  const principles = stringArray(value.principles);
  const preferences = stringArray(value.preferences);
  const behaviors = stringArray(value.behaviors);
  if (principles === null || preferences === null || behaviors === null) return null;
  if (typeof value.updatedAt !== "string") return null;
  if (typeof value.updatedBy !== "string") return null;
  const known = new Set([
    "schemaVersion",
    "principles",
    "preferences",
    "behaviors",
    "updatedAt",
    "updatedBy",
  ]);
  for (const key of Object.keys(value)) if (!known.has(key)) return null;
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    principles,
    preferences,
    behaviors,
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy as Actor,
  };
}

export type IdentityOutcome =
  | { ok: true; identity: IdentityState }
  | { ok: false; reason: string; rule: string };

/**
 * Add one line to identity.
 *
 * Refuses every actor except the user. The message names the alternative
 * rather than just denying, because the actor most likely to hit this is a
 * reviewer with a genuinely good observation.
 */
export function addIdentityLine(
  identity: IdentityState,
  actor: Actor,
  field: IdentityField,
  text: string,
  clock: Clock = () => new Date(),
): IdentityOutcome {
  if (actor !== "user") {
    return {
      ok: false,
      reason: `actor "${actor}" cannot write identity; propose it as durable memory for the user to promote instead`,
      rule: "section 17 / A1",
    };
  }
  const value = text.trim();
  if (value.length === 0) return { ok: false, reason: "empty identity line", rule: "section 17" };

  const next: IdentityState = {
    ...identity,
    principles: [...identity.principles],
    preferences: [...identity.preferences],
    behaviors: [...identity.behaviors],
    updatedAt: nowIso(clock),
    updatedBy: actor,
  };
  const list =
    field === "principle" ? next.principles : field === "preference" ? next.preferences : next.behaviors;
  if (!list.includes(value)) list.push(value);
  return { ok: true, identity: next };
}

export function removeIdentityLine(
  identity: IdentityState,
  actor: Actor,
  field: IdentityField,
  text: string,
  clock: Clock = () => new Date(),
): IdentityOutcome {
  if (actor !== "user") {
    return { ok: false, reason: `actor "${actor}" cannot edit identity`, rule: "section 17 / A1" };
  }
  const drop = (list: string[]) => list.filter((line) => line !== text.trim());
  return {
    ok: true,
    identity: {
      ...identity,
      principles: field === "principle" ? drop(identity.principles) : identity.principles,
      preferences: field === "preference" ? drop(identity.preferences) : identity.preferences,
      behaviors: field === "behavior" ? drop(identity.behaviors) : identity.behaviors,
      updatedAt: nowIso(clock),
      updatedBy: actor,
    },
  };
}

export function isEmptyIdentity(identity: IdentityState): boolean {
  return (
    identity.principles.length === 0 &&
    identity.preferences.length === 0 &&
    identity.behaviors.length === 0
  );
}

/**
 * The block appended to the system prompt each turn (spec section 25,
 * "load baseline identity").
 *
 * Returns "" when identity is empty, so an unconfigured harness adds nothing
 * to the prompt rather than a heading with nothing under it - the same
 * empty-renders-nothing rule the control plane's scratchpad follows.
 */
export function renderIdentityBlock(identity: IdentityState): string {
  if (isEmptyIdentity(identity)) return "";
  const section = (title: string, lines: string[]) =>
    lines.length > 0 ? [`${title}:`, ...lines.map((line) => `- ${line}`), ""] : [];
  return [
    "## Pi identity",
    "",
    "This is who you are across sessions and models. It is set by the user and",
    "does not change because a task would be easier if it did.",
    "",
    ...section("Operating principles", identity.principles),
    ...section("User preferences", identity.preferences),
    ...section("Baseline behavior", identity.behaviors),
  ]
    .join("\n")
    .trimEnd();
}
