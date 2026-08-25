/**
 * Remembered decisions (soft-policy rules).
 *
 * A user can turn a one-off "Allow <tool>?" approval into a standing rule so
 * the same prompt never recurs. Rules are:
 *   - soft policy: they only convert an attended CONFIRM into an allow. They
 *     are checked after hard rules have already resolved (read-before-edit and
 *     scope-write denials produce a block, not a confirm; sensitive-read
 *     confirms are excluded at the call site), so a rule can never loosen a
 *     hard boundary.
 *   - scope-bound: a rule applies only while the project root it was created in
 *     is in force.
 *   - user-actor: only a human's explicit choice creates one; the model cannot.
 *
 * Persisted and restored exactly like the scratchpad and control-plane state
 * (append-a-custom-entry, walk-backward-take-newest-valid), so rules survive a
 * /compact and a session restore.
 */

import { RULES_SCHEMA_VERSION, type RememberedRule, type RememberedRulesState } from "./types.ts";

export const MAX_RULES = 200;

export function emptyRules(now: string = new Date().toISOString()): RememberedRulesState {
  return { schemaVersion: RULES_SCHEMA_VERSION, rules: [], updatedAt: now };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRule(value: unknown): RememberedRule | null {
  if (!isRecord(value)) return null;
  if (!isString(value.id) || value.id.trim().length === 0) return null;
  if (!isString(value.tool) || value.tool.trim().length === 0) return null;
  if (!isString(value.target) || value.target.trim().length === 0) return null;
  if (!isString(value.scopeRoot) || value.scopeRoot.trim().length === 0) return null;
  if (!isString(value.createdAt)) return null;
  return { id: value.id, tool: value.tool, target: value.target, scopeRoot: value.scopeRoot, createdAt: value.createdAt };
}

/** Strict validation, same posture as validateScratchpad: anything unexpected
 * -> null -> caller falls back to empty rules, never a repaired guess. */
export function validateRules(value: unknown): RememberedRulesState | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== RULES_SCHEMA_VERSION) return null;
  if (!isString(value.updatedAt)) return null;
  if (!Array.isArray(value.rules)) return null;
  const rules: RememberedRule[] = [];
  for (const raw of value.rules) {
    const rule = validateRule(raw);
    if (rule === null) return null;
    rules.push(rule);
  }
  if (value.applyWithoutUi !== undefined && typeof value.applyWithoutUi !== "boolean") return null;
  return {
    schemaVersion: RULES_SCHEMA_VERSION,
    rules,
    updatedAt: value.updatedAt,
    // Absent stays absent rather than becoming an explicit false: an older
    // entry carries no opinion, and the read side treats both as off.
    ...(value.applyWithoutUi === undefined ? {} : { applyWithoutUi: value.applyWithoutUi }),
  };
}

export interface RulesEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

export function restoreRulesFromEntries(
  entries: RulesEntryLike[],
  entryType: string,
  now: string = new Date().toISOString(),
): { rules: RememberedRulesState; restored: boolean; ignoredMalformed: number } {
  let ignoredMalformed = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== entryType) continue;
    const validated = validateRules(entry.data);
    if (validated !== null) {
      return { rules: validated, restored: true, ignoredMalformed };
    }
    ignoredMalformed++;
  }
  return { rules: emptyRules(now), restored: false, ignoredMalformed };
}

/** Small deterministic id from a rule's identity + creation time. No random or
 * clock use here (createdAt is supplied by the caller), so a workflow replay is
 * reproducible. */
export function makeRuleId(tool: string, target: string, scopeRoot: string, createdAt: string): string {
  let hash = 5381;
  const material = `${tool} ${target} ${scopeRoot} ${createdAt}`;
  for (let i = 0; i < material.length; i++) {
    hash = ((hash << 5) + hash + material.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 8);
}

/** Add a rule, de-duplicating by (tool, target, scopeRoot). Returns the new
 * state (or the same reference when the rule already exists or the cap is hit). */
export function addRule(
  state: RememberedRulesState,
  fields: { tool: string; target: string; scopeRoot: string },
  now: string = new Date().toISOString(),
): { state: RememberedRulesState; rule: RememberedRule | null; duplicate: boolean } {
  const existing = state.rules.find(
    (r) => r.tool === fields.tool && r.target === fields.target && r.scopeRoot === fields.scopeRoot,
  );
  if (existing) return { state, rule: existing, duplicate: true };
  if (state.rules.length >= MAX_RULES) return { state, rule: null, duplicate: false };
  const rule: RememberedRule = {
    id: makeRuleId(fields.tool, fields.target, fields.scopeRoot, now),
    tool: fields.tool,
    target: fields.target,
    scopeRoot: fields.scopeRoot,
    createdAt: now,
  };
  return {
    state: { schemaVersion: RULES_SCHEMA_VERSION, rules: [...state.rules, rule], updatedAt: now },
    rule,
    duplicate: false,
  };
}

export function removeRule(
  state: RememberedRulesState,
  id: string,
  now: string = new Date().toISOString(),
): { state: RememberedRulesState; removed: RememberedRule | null } {
  const removed = state.rules.find((r) => r.id === id) ?? null;
  if (removed === null) return { state, removed: null };
  return {
    state: { schemaVersion: RULES_SCHEMA_VERSION, rules: state.rules.filter((r) => r.id !== id), updatedAt: now },
    removed,
  };
}

/**
 * The rule allowing (tool, target) within scopeRoot, or null. Matching is exact
 * on all three: the narrowest, safest interpretation of "remember this
 * decision" - it suppresses the prompt for this exact file in this exact
 * project, nothing broader.
 */
export function matchRule(
  state: RememberedRulesState,
  tool: string,
  target: string,
  scopeRoot: string,
): RememberedRule | null {
  return (
    state.rules.find((r) => r.tool === tool && r.target === target && r.scopeRoot === scopeRoot) ?? null
  );
}

export function renderRulesList(state: RememberedRulesState): string[] {
  if (state.rules.length === 0) return ["No remembered rules."];
  return [
    `${state.rules.length} remembered rule(s):`,
    ...state.rules.map((r) => `  ${r.id}  allow ${r.tool}  ${r.target}  (scope ${r.scopeRoot})`),
  ];
}
