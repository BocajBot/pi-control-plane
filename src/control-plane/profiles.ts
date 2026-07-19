/**
 * Tool profiles: named tool loadouts applied through the existing source-toggle
 * machinery. A profile lists the tools that stay ENABLED; every other known
 * tool is toggled off. "all" is a reserved built-in that clears tool toggles.
 *
 * Pure module — validation and toggle computation only. Loading the file and
 * calling Pi's setActiveTools happen in the extension entry.
 */

export const PROFILES_SCHEMA_VERSION = 1;
/** Reserved built-in profile: enables every tool (clears tool toggles). */
export const ALL_PROFILE = "all";

export interface ToolProfile {
  description: string;
  tools: string[];
}

export interface ProfilesConfig {
  schemaVersion: typeof PROFILES_SCHEMA_VERSION;
  profiles: Record<string, ToolProfile>;
  /** Profile applied at the start of fresh sessions; null when unset. */
  defaultProfile: string | null;
}

const TOOL_PREFIX = "tool:";

/** Strict validation. Anything unexpected -> null (profiles unavailable, safety unaffected). */
export function validateProfiles(value: unknown): ProfilesConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PROFILES_SCHEMA_VERSION) return null;
  if (typeof record.profiles !== "object" || record.profiles === null || Array.isArray(record.profiles)) {
    return null;
  }
  const profiles: Record<string, ToolProfile> = {};
  for (const [name, raw] of Object.entries(record.profiles as Record<string, unknown>)) {
    if (name.trim().length === 0 || name === ALL_PROFILE) return null; // "all" is reserved
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const profile = raw as Record<string, unknown>;
    if (typeof profile.description !== "string") return null;
    if (
      !Array.isArray(profile.tools) ||
      !profile.tools.every((t) => typeof t === "string" && t.trim().length > 0)
    ) {
      return null;
    }
    const knownKeys = new Set(["description", "tools"]);
    for (const key of Object.keys(profile)) {
      if (!knownKeys.has(key)) return null;
    }
    profiles[name] = { description: profile.description, tools: [...new Set(profile.tools)] };
  }
  let defaultProfile: string | null = null;
  if (record.defaultProfile !== undefined && record.defaultProfile !== null) {
    if (typeof record.defaultProfile !== "string") return null;
    if (record.defaultProfile !== ALL_PROFILE && profiles[record.defaultProfile] === undefined) {
      return null; // default must reference "all" or a defined profile
    }
    defaultProfile = record.defaultProfile;
  }
  return { schemaVersion: PROFILES_SCHEMA_VERSION, profiles, defaultProfile };
}

export interface ApplyProfileResult {
  /** New complete toggle map (non-tool toggles preserved). */
  toggles: Record<string, boolean>;
  /** Tools that end up enabled. */
  enabled: string[];
  /** Tools that end up disabled. */
  disabled: string[];
  /** Profile tools not present in this session (informational, not an error —
   * different projects load different extensions). */
  missing: string[];
}

export function applyProfile(
  profileTools: string[],
  allTools: string[],
  currentToggles: Record<string, boolean>,
): ApplyProfileResult {
  const want = new Set(profileTools);
  const toggles: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(currentToggles)) {
    if (!key.startsWith(TOOL_PREFIX)) toggles[key] = enabled;
  }
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const tool of [...allTools].sort()) {
    if (want.has(tool)) {
      enabled.push(tool);
    } else {
      toggles[TOOL_PREFIX + tool] = false;
      disabled.push(tool);
    }
  }
  const available = new Set(allTools);
  const missing = profileTools.filter((t) => !available.has(t)).sort();
  return { toggles, enabled, disabled, missing };
}

/** The "all" built-in: remove every tool toggle, keep everything else. */
export function clearToolToggles(currentToggles: Record<string, boolean>): Record<string, boolean> {
  const toggles: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(currentToggles)) {
    if (!key.startsWith(TOOL_PREFIX)) toggles[key] = enabled;
  }
  return toggles;
}

/**
 * Which profile matches the current toggle state, if any. "all" matches when
 * no tool is toggled off. Returns null when the state matches no profile.
 */
export function currentProfileName(
  config: ProfilesConfig | null,
  allTools: string[],
  toggles: Record<string, boolean>,
): string | null {
  const enabledSet = new Set(allTools.filter((t) => toggles[TOOL_PREFIX + t] !== false));
  if (enabledSet.size === allTools.length) return ALL_PROFILE;
  if (config === null) return null;
  for (const [name, profile] of Object.entries(config.profiles)) {
    const want = new Set(profile.tools.filter((t) => allTools.includes(t)));
    if (want.size === enabledSet.size && [...want].every((t) => enabledSet.has(t))) {
      return name;
    }
  }
  return null;
}
