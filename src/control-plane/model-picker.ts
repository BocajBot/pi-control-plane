/**
 * Model-picker logic, extracted pure from the old standalone picker extension
 * so it is unit-testable without pi-tui and survives pi updates (the bundled
 * /model selector patch it replaces did not — it failed closed on every
 * upstream anchor change).
 *
 * What lives here: usage-frequency math, model ordering, query filtering,
 * page-jump index math, key classification, and usage-file IO (fs injected).
 * What does not: SelectList rendering, the modal, the session hooks — that is
 * extensions/model-picker.ts (wiring only, same split as control-plane.ts).
 *
 * Usage history format (~/.pi/agent/model-usage.json) is unchanged from the
 * standalone picker, so existing frecency data keeps working.
 */

export const MAX_VISIBLE = 15;

/** Page jump size for PageUp/PageDown in the picker list. */
export const PAGE_JUMP = MAX_VISIBLE;

export interface UsageEntry {
  count: number;
  lastUsed: number;
}

export type Usage = Record<string, UsageEntry>;

/** The minimal model shape the ordering needs; the wiring maps real models. */
export interface ModelLike {
  provider: string;
  id: string;
}

export interface PricedModelLike extends ModelLike {
  cost?: {
    input: number;
    output: number;
    tiers?: readonly unknown[];
  };
}

export function keyOf(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/** Match Pi's native OpenRouter price badge: input/output dollars per million
 * tokens, with `+` when request-size tiers may change the shown base rate. */
export function modelPriceLabel(model: PricedModelLike): string | null {
  if (model.provider !== "openrouter" || model.cost === undefined) return null;
  const formatRate = (rate: number): string => {
    if (!Number.isFinite(rate)) return "?";
    if (rate === 0) return "0";
    return String(Number.parseFloat(rate.toPrecision(3)));
  };
  const tierMark = model.cost.tiers?.length ? "+" : "";
  return `$${formatRate(model.cost.input)}/$${formatRate(model.cost.output)}${tierMark} per Mtok`;
}

/**
 * Use count decayed by recency: a model used often but long ago ranks below
 * one used a little but today. Half-life of roughly a week.
 */
export function frecency(entry: UsageEntry | undefined, now: number): number {
  if (!entry) return 0;
  const days = Math.max(0, (now - entry.lastUsed) / 86_400_000);
  return entry.count * Math.pow(0.5, days / 7);
}

/**
 * Order models for the picker: frecency first (most recently-used at top),
 * then the local provider (cold-history tiebreak so local models lead before
 * any usage exists), then a stable name order.
 */
export function sortModels<T extends ModelLike>(models: readonly T[], usage: Usage, localProvider: string, now: number): T[] {
  const score = (m: ModelLike): number => frecency(usage[keyOf(m.provider, m.id)], now);
  return [...models].sort((a, b) => {
    const fa = score(a);
    const fb = score(b);
    if (fb !== fa) return fb - fa;
    const la = a.provider === localProvider ? 1 : 0;
    const lb = b.provider === localProvider ? 1 : 0;
    if (lb !== la) return lb - la;
    return keyOf(a.provider, a.id).localeCompare(keyOf(b.provider, b.id));
  });
}

/** One recorded use of a model: count +1, lastUsed = now. */
export function recordUse(usage: Usage, provider: string, id: string, now: number): Usage {
  const k = keyOf(provider, id);
  const e = usage[k] ?? { count: 0, lastUsed: 0 };
  return { ...usage, [k]: { count: e.count + 1, lastUsed: now } };
}

/** Injectable filesystem so usage IO is unit-testable. */
export interface UsageFs {
  readUtf8(path: string): string;
  writeUtf8(path: string, data: string): string | undefined;
  rename(from: string, to: string): string | undefined;
}

/** Load usage history; any read/parse failure yields empty history (not an error). */
export function loadUsage(fs: UsageFs, usageFile: string): Usage {
  try {
    const parsed: unknown = JSON.parse(fs.readUtf8(usageFile));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Usage = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).count === "number" &&
        typeof (value as Record<string, unknown>).lastUsed === "number"
      ) {
        out[key] = value as UsageEntry;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Save atomically: tmp file + rename, so a crash mid-write never truncates
 * the history. Rethrows so the caller can decide (the wiring logs and moves
 * on — usage data is an optimization, never a gate).
 */
export function saveUsage(fs: UsageFs, usageFile: string, usage: Usage): void {
  const tmp = `${usageFile}.tmp`;
  fs.writeUtf8(tmp, JSON.stringify(usage, null, 2) + "\n");
  fs.rename(tmp, usageFile);
}

/** Substring filter (SelectList's own setFilter is prefix-only on the value). */
export function filterModels<T extends ModelLike>(models: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...models];
  return models.filter((m) => keyOf(m.provider, m.id).toLowerCase().includes(q));
}

/** One page step in the list: ±PAGE_JUMP, clamped to [0, count-1]. */
export function pageStep(selectedIndex: number, direction: -1 | 1, count: number, pageSize: number = PAGE_JUMP): number {
  if (count <= 0) return 0;
  const next = selectedIndex + direction * pageSize;
  return Math.max(0, Math.min(count - 1, next));
}

/** What a raw key press means to the picker. */
export type PickerKey =
  | { kind: "type"; char: string }
  | { kind: "backspace" }
  | { kind: "page-up" }
  | { kind: "page-down" }
  | { kind: "other"; data: string };

/**
 * Classify a raw terminal key. Printable text (no control chars, no escape
 * sequences) types into the filter; backspace edits it; PageUp/PageDown page
 * the list (\x1b[5~ / \x1b[6~, plus the parameterized modifier variants
 * \x1b[5;<n>~); everything else is "other" and goes to SelectList (arrows,
 * enter, escape).
 */
export function classifyKey(data: string): PickerKey {
  if (data === "\x7f" || data === "\b") return { kind: "backspace" };
  if (data.length > 0 && !/[\x00-\x1f]/.test(data)) return { kind: "type", char: data };
  if (/^\x1b\[5(?:;[0-9]+)?~$/.test(data)) return { kind: "page-up" };
  if (/^\x1b\[6(?:;[0-9]+)?~$/.test(data)) return { kind: "page-down" };
  return { kind: "other", data };
}

/** settings.json reader for the `modelPicker: false` opt-out (fs injected). */
export function pickerDisabled(fs: UsageFs, settingsFile: string): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readUtf8(settingsFile));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    return (parsed as Record<string, unknown>).modelPicker === false;
  } catch {
    return false;
  }
}

/** Resolve a /models <query> argument to zero or more candidate models. */
export function resolveModelArgument<T extends ModelLike>(models: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const exact = models.filter((m) => keyOf(m.provider, m.id).toLowerCase() === q);
  if (exact.length > 0) return exact;
  return filterModels(models, q);
}
