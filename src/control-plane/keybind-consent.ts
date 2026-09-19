/**
 * Consent-gated keybinding claims — pure logic, no pi-tui / no Pi imports.
 *
 * Why this exists: the control-plane wants `shift+tab` for mode cycling
 * (Claude Code-style), but Pi reserves that key for `app.thinking.cycle` and
 * silently SKIPS any extension shortcut that collides with a reserved builtin
 * unless the user unbinds it in ~/.pi/agent/keybindings.json. Historically the
 * README claimed that unbind was pre-configured; it never was, so the claim
 * silently failed with a startup warning. The user's rule now: nothing about
 * the user's keymap changes without explicit consent.
 *
 * Flow implemented here (wiring lives in extensions/control-plane.ts):
 *   1. On first interactive session with no consent recorded, Pi asks:
 *      Claude-style keybinds / record your own key / keep Pi defaults.
 *   2. "claude" unbinds `app.thinking.cycle` in keybindings.json and claims
 *      shift+tab. Thinking level stays reachable via /effort.
 *   3. "custom" records a key combo, checks it against Pi's effective
 *      bindings AND this extension's own shortcuts, unbinds any reserved
 *      builtin it collides with (each unbind confirmed), and claims it.
 *   4. "keep-pi-defaults" claims nothing; alt+p keeps cycling modes.
 * The decision is stored in <agentDir>/control-plane-keys.json so the prompt
 * is asked exactly once. /control-keys re-opens the flow at any time.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Consent state (user-global, lives in the Pi agent dir)
// ---------------------------------------------------------------------------

export type KeybindDecision = "claude" | "custom" | "keep-pi-defaults";

export interface KeybindConsent {
  version: 1;
  decision: KeybindDecision;
  /** decision === "custom": the recorded Pi key id, e.g. "ctrl+shift+m". */
  customKey?: string;
  /** Built-in actions this consent wrote as unbound ([] in keybindings.json),
   *  kept so startup can detect drift (user re-bound one of them). */
  unboundActions?: string[];
  decidedAt: string;
}

export const CONSENT_FILE = "control-plane-keys.json";
export const KEYBINDINGS_FILE = "keybindings.json";

/** Pi's config-dir resolution: PI_CODING_AGENT_DIR overrides ~/.pi/agent. */
export function agentConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export interface ConsentReadResult {
  consent: KeybindConsent | null;
  /** The file exists but is not a valid consent record. Never overwritten
   *  silently; the wiring reports it and treats it as "no consent yet". */
  malformed: boolean;
}

export function readConsent(dir: string): ConsentReadResult {
  const file = path.join(dir, CONSENT_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { consent: null, malformed: false };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<KeybindConsent> | null;
    const decision = parsed?.decision;
    if (
      parsed?.version === 1 &&
      (decision === "claude" || decision === "custom" || decision === "keep-pi-defaults") &&
      typeof parsed.decidedAt === "string" &&
      (decision !== "custom" || (typeof parsed.customKey === "string" && parsed.customKey.length > 0))
    ) {
      return {
        consent: {
          version: 1,
          decision,
          customKey: parsed.customKey,
          unboundActions: parsed.unboundActions,
          decidedAt: parsed.decidedAt,
        },
        malformed: false,
      };
    }
  } catch {
    // fall through to malformed
  }
  return { consent: null, malformed: true };
}

/** Atomic write (tmp + rename in the same directory). */
export function writeConsent(dir: string, consent: KeybindConsent): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, CONSENT_FILE);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(consent, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------
// Recorded-key validation (Pi KeyId grammar, see pi-tui keys.ts)
// ---------------------------------------------------------------------------

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SPECIAL_KEYS = new Set([
  "escape", "enter", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
]);
const BASE_KEY_RE = /^[a-z0-9`\-=\[\]\\;'",./!@#$%^&*()_+|~{}:<>?]$/;

/** Canonical Pi key id from raw recorder input, or null if unrecognizable.
 *  Lowercases, aliases esc→escape and return→enter, orders nothing else
 *  (modifier order is preserved so the user sees what they pressed). */
export function canonicalizeKeyId(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  const parts = cleaned.split("+");
  const base = parts[parts.length - 1] ?? "";
  const modifiers = parts.slice(0, -1);
  if (modifiers.some((m) => !MODIFIERS.has(m) || modifiers.indexOf(m) !== modifiers.lastIndexOf(m))) {
    return null;
  }
  const isSpecial = SPECIAL_KEYS.has(base) || base === "esc" || base === "return";
  const isFunction = /^f([1-9]|1[0-2])$/.test(base);
  const isBase = base.length === 1 && BASE_KEY_RE.test(base);
  if (!isSpecial && !isFunction && !isBase) return null;
  // "esc"/"return" are accepted aliases in Pi keybindings; canonicalize.
  const canonicalBase = base === "esc" ? "escape" : base === "return" ? "enter" : base;
  return [...modifiers, canonicalBase].join("+");
}

export type RecordedKeyCheck =
  | { ok: true; key: string }
  | { ok: false; reason: string };

/** Rules for a recordable mode-cycle key. Bare typing keys, navigation, tab,
 *  space, enter and escape are refused outright — they would break the editor
 *  or submit/cancel semantics everywhere. shift+tab is refused for the custom
 *  path because that is exactly what the "claude" preset already offers. */
export function validateRecordedKey(raw: string): RecordedKeyCheck {
  const key = canonicalizeKeyId(raw);
  if (key === null) {
    return { ok: false, reason: `"${raw.trim()}" is not a recognizable key combo. Use modifier+key (e.g. ctrl+shift+m), or f1-f12.` };
  }
  if (/^f([1-9]|1[0-2])$/.test(key)) return { ok: true, key };
  const tokens = key.split("+");
  const modifiers = tokens.slice(0, -1);
  const base = tokens[tokens.length - 1];
  if (!modifiers.some((m) => m === "ctrl" || m === "alt" || m === "super")) {
    if (key === "shift+tab") {
      return { ok: false, reason: "shift+tab is the Claude-style preset — choose that option instead of recording it." };
    }
    return { ok: false, reason: `"${key}" needs ctrl, alt or super (or an f1-f12 key) — unmodified keys would break normal editing.` };
  }
  if (base === "space" && modifiers.length === 1 && modifiers[0] === "shift") {
    return { ok: false, reason: "shift+space is not reliably reported by terminals; pick another combo." };
  }
  return { ok: true, key };
}

/** Shortcuts this extension package itself registers (both entry points).
 *  A recorded key may not shadow our own live shortcuts. */
export const OWN_EXTENSION_SHORTCUTS: readonly string[] = [
  "alt+c", "alt+e", "alt+s", "alt+h", "alt+i", "alt+p", "alt+m",
  "ctrl+alt+r", "ctrl+alt+t",
];

// ---------------------------------------------------------------------------
// Conflict detection against Pi's effective bindings
// ---------------------------------------------------------------------------

/**
 * Pi's RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS: extension shortcuts for
 * these actions are skipped outright unless the user unbinds the action in
 * keybindings.json. Copied from the installed Pi 0.85.1 bundle; verified by
 * tests/keybind-consent-runtime.test.ts against the real loader.
 */
export const RESERVED_ACTIONS: readonly string[] = [
  "app.interrupt", "app.clear", "app.exit", "app.suspend", "app.thinking.cycle",
  "app.model.cycleForward", "app.model.cycleBackward", "app.model.select",
  "app.tools.expand", "app.thinking.toggle", "app.editor.external",
  "app.message.copy", "app.message.followUp",
  "tui.input.submit", "tui.select.confirm", "tui.select.cancel",
  "tui.input.copy", "tui.editor.deleteToLineEnd",
];

/** Defaults for the reserved actions (macOS/Linux variants; the Windows
 *  variants differ but this table only needs to identify likely occupants —
 *  Pi's own loader diagnostics remain the final authority). */
export const RESERVED_DEFAULT_KEYS: Readonly<Record<string, readonly string[]>> = {
  "app.interrupt": ["escape"],
  "app.clear": ["ctrl+c"],
  "app.exit": ["ctrl+d"],
  "app.suspend": ["ctrl+z"],
  "app.thinking.cycle": ["shift+tab"],
  "app.model.cycleForward": ["ctrl+p"],
  "app.model.cycleBackward": ["shift+ctrl+p"],
  "app.model.select": ["ctrl+l"],
  "app.tools.expand": ["ctrl+o"],
  "app.thinking.toggle": ["ctrl+t"],
  "app.editor.external": ["ctrl+g"],
  "app.message.copy": ["ctrl+x"],
  "app.message.followUp": ["alt+enter"],
  "tui.input.submit": ["enter"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape", "ctrl+c"],
  "tui.input.copy": ["ctrl+c"],
  "tui.editor.deleteToLineEnd": ["ctrl+k"],
};

export type KeybindingsConfigLike = Record<string, readonly string[] | string | undefined>;

function keysOf(config: KeybindingsConfigLike, action: string): readonly string[] {
  const value = config[action];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function sameKey(a: string, b: string): boolean {
  const normalize = (key: string) => key.trim().toLowerCase().replace(/^esc$/, "escape").replace(/^return$/, "enter");
  return normalize(a) === normalize(b);
}

/** Effective bindings = defaults overridden by the user's keybindings.json. */
export function effectiveBindings(
  userConfig: KeybindingsConfigLike | null,
  defaults: Readonly<Record<string, readonly string[]>> = RESERVED_DEFAULT_KEYS,
): Record<string, readonly string[]> {
  const merged: Record<string, readonly string[]> = {};
  for (const [action, keys] of Object.entries(defaults)) merged[action] = keys;
  for (const [action, value] of Object.entries(userConfig ?? {})) {
    if (value === undefined) continue;
    merged[action] = Array.isArray(value) ? value : [value];
  }
  return merged;
}

/** Actions currently bound to `key` in the effective map. */
export function findOccupantActions(key: string, resolved: KeybindingsConfigLike): string[] {
  return Object.entries(resolved)
    .filter(([, keys]) => keys !== undefined && (Array.isArray(keys) ? keys : [keys]).some((k) => sameKey(k, key)))
    .map(([action]) => action);
}

/** Reserved occupants must be written as [] for the extension claim to win. */
export function planUnbinds(occupants: readonly string[]): string[] {
  return occupants.filter((action) => RESERVED_ACTIONS.includes(action));
}

/** Merge unbinds into a parsed keybindings.json, preserving every unrelated
 *  key verbatim. Missing action entries are added; existing ones become []. */
export function applyUnbinds(
  rawUserConfig: unknown,
  actions: readonly string[],
): Record<string, readonly string[] | string | undefined> {
  const merged: Record<string, unknown> =
    rawUserConfig !== null && typeof rawUserConfig === "object" && !Array.isArray(rawUserConfig)
      ? { ...(rawUserConfig as Record<string, unknown>) }
      : {};
  for (const action of actions) merged[action] = [];
  return merged as Record<string, readonly string[] | string | undefined>;
}

/** Actions that must be [] in keybindings.json for a stored consent to hold. */
export function expectedUnboundActions(consent: KeybindConsent): readonly string[] {
  if (consent.decision === "claude") return consent.unboundActions ?? ["app.thinking.cycle"];
  if (consent.decision === "custom") return consent.unboundActions ?? [];
  return [];
}

/** True when the user's keybindings.json no longer matches the recorded
 *  consent (e.g. the user re-bound a key we unbound). Drift is reported,
 *  never auto-repaired: re-binding is the user's prerogative. */
export function consentDrift(
  consent: KeybindConsent,
  rawUserConfig: unknown,
): string[] {
  const drifted: string[] = [];
  for (const action of expectedUnboundActions(consent)) {
    const value = rawUserConfig !== null && typeof rawUserConfig === "object" && !Array.isArray(rawUserConfig)
      ? (rawUserConfig as Record<string, unknown>)[action]
      : undefined;
    const unbound = value === undefined ? false : Array.isArray(value) ? value.length === 0 : false;
    // Absent action = Pi default still bound -> the reserved claim is skipped.
    if (!unbound) drifted.push(action);
  }
  return drifted;
}

// ---------------------------------------------------------------------------
// keybindings.json IO (fail-closed: never clobber a malformed user file)
// ---------------------------------------------------------------------------

export function readKeybindingsConfig(dir: string): { config: unknown; exists: boolean; malformed: boolean } {
  const file = path.join(dir, KEYBINDINGS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { config: undefined, exists: false, malformed: false };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { config: undefined, exists: true, malformed: true };
    }
    return { config: parsed, exists: true, malformed: false };
  } catch {
    return { config: undefined, exists: true, malformed: true };
  }
}

/** Atomic write of the merged config. Returns an error message or null. */
export function writeKeybindingsConfig(dir: string, config: unknown): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, KEYBINDINGS_FILE);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
