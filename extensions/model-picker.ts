/**
 * Model picker — an isolated, update-surviving replacement for the bundled
 * /model-selector patch (bin/patch-pi-model-page-nav.mjs, retired: it patched
 * minified anchors inside pi's bundle and failed closed on every upstream
 * update). Everything here uses only public extension APIs:
 *
 *   ctx.modelRegistry.getAll()   - list every available model
 *   ctx.ui.custom(...)           - a modal with raw key input
 *   pi.setModel(model)           - switch the session's model
 *   pi.on("model_select")        - usage tracking for frecency ordering
 *
 * Pure logic (frecency, ordering, filtering, page-jump math, key
 * classification, usage IO) lives in ../src/control-plane/model-picker.ts and
 * is unit-tested without pi-tui; this file is wiring only, the same split as
 * control-plane.ts.
 *
 * Surfaces:
 *   - at interactive startup (session_start reason "startup"): the typeahead
 *     picker; escape at launch quits pi (no model chosen, no session).
 *     Disable with "modelPicker": false in ~/.pi/agent/settings.json.
 *   - alt+m / /models (no args, TUI): the same picker on demand.
 *   - /models <query> (any mode): switch directly to the unique match.
 *   - /models (no args, non-TUI): prints the frecency-ordered model list.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  classifyKey,
  keyOf,
  loadUsage,
  MAX_VISIBLE,
  modelPriceLabel,
  pageStep,
  pickerDisabled,
  recordUse,
  resolveModelArgument,
  saveUsage,
  sortModels,
  type UsageFs,
} from "../src/control-plane/model-picker.ts";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const USAGE_FILE = path.join(AGENT_DIR, "model-usage.json");
const SETTINGS_FILE = path.join(AGENT_DIR, "settings.json");
const MODELS_FILE = path.join(AGENT_DIR, "models.json");

const nodeFs: UsageFs = {
  readUtf8: (p) => fs.readFileSync(p, "utf8"),
  writeUtf8: (p, data) => {
    fs.writeFileSync(p, data);
    return undefined;
  },
  rename: (from, to) => {
    fs.renameSync(from, to);
    return undefined;
  },
};

/** A model as the picker sees it. Model<any> is structurally compatible. */
interface PickerModel {
  provider: string;
  id: string;
  cost?: {
    input: number;
    output: number;
    tiers?: readonly unknown[];
  };
}

/** Every provider/id in models.json (for completions, which receive no ctx). */
function listAllModelRefs(): PickerModel[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    const providers = (parsed as { providers?: Record<string, { models?: { id?: unknown }[] }> })
      .providers;
    if (typeof providers !== "object" || providers === null) return [];
    const out: PickerModel[] = [];
    for (const [provider, config] of Object.entries(providers)) {
      for (const model of config?.models ?? []) {
        if (typeof model?.id === "string") out.push({ provider, id: model.id });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function localProviderOf(): string {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const p = (parsed as Record<string, unknown>).defaultProvider;
      if (typeof p === "string" && p.length > 0) return p;
    }
  } catch {
    // unreadable settings: no local boost, harmless
  }
  return "llama-swap";
}

export default async function modelPickerExtension(pi: ExtensionAPI) {
  // pi-tui's SelectList and the theme hook, dynamically imported inside the
  // factory (same posture as control-plane.ts) so the entry also loads under
  // the unit-test harness: null there, and the picker does not register.
  type SelectListItem = { value: string; label: string; description?: string };
  interface SelectListLike {
    onSelect?: (item: SelectListItem) => void;
    onCancel?: () => void;
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
    setSelectedIndex(index: number): void;
    selectedIndex: number;
    filteredItems: SelectListItem[];
  }
  let SelectListCtor: (new (
    items: SelectListItem[],
    maxVisible: number,
    theme?: unknown,
  ) => SelectListLike) | null = null;
  let selectListTheme: unknown;
  try {
    const tui = (await import("@earendil-works/pi-tui")) as unknown as {
      SelectList?: typeof SelectListCtor;
    };
    SelectListCtor = tui.SelectList ?? null;
    if (SelectListCtor !== null) {
      const piPkg = (await import("@earendil-works/pi-coding-agent")) as unknown as {
        getSelectListTheme?: () => unknown;
      };
      selectListTheme = piPkg.getSelectListTheme?.();
    }
  } catch {
    SelectListCtor = null;
    selectListTheme = undefined;
  }

  const hasSelectList = SelectListCtor !== null;

  const modelsOf = (ctx: ExtensionContext): PickerModel[] => {
    const registry = (ctx as unknown as {
      modelRegistry?: { getAll?: () => PickerModel[] };
    }).modelRegistry;
    const all = typeof registry?.getAll === "function" ? registry.getAll() : [];
    return Array.isArray(all) ? all : [];
  };

  const sortedModels = (ctx: ExtensionContext): PickerModel[] =>
    sortModels(modelsOf(ctx), loadUsage(nodeFs, USAGE_FILE), localProviderOf(), Date.now());

  /**
   * Typeahead over a SelectList: printable keys build a filter string,
   * backspace edits it, PageUp/PageDown jump a page (SelectList handles only
   * up/down/enter/escape natively — the gap the retired bundle patch filled),
   * everything else is delegated to the list.
   */
  const makeTypeahead = (
    items: SelectListItem[],
    onPick: (value: string) => void,
    onQuit: () => void,
  ) => {
    let query = "";
    let list = new SelectListCtor!(items, MAX_VISIBLE, selectListTheme);
    list.onSelect = (item) => onPick(item.value);
    list.onCancel = () => onQuit();
    const rebuild = () => {
      const q = query.toLowerCase();
      const matches = q ? items.filter((i) => i.value.toLowerCase().includes(q)) : items;
      list = new SelectListCtor!(matches, MAX_VISIBLE, selectListTheme);
      list.onSelect = (item) => onPick(item.value);
      list.onCancel = () => onQuit();
    };
    return {
      render(width: number): string[] {
        return [
          " Model — type to search · ↑↓ move · PgUp/PgDn page · enter select · esc close",
          ` > ${query}${query ? "" : "(type to search)"}`,
          ...list.render(width),
        ];
      },
      handleInput(data: string): void {
        const key = classifyKey(data);
        if (key.kind === "type") {
          query += key.char;
          rebuild();
          return;
        }
        if (key.kind === "backspace") {
          query = query.slice(0, -1);
          rebuild();
          return;
        }
        if (key.kind === "page-up" || key.kind === "page-down") {
          list.setSelectedIndex(
            pageStep(
              list.selectedIndex,
              key.kind === "page-up" ? -1 : 1,
              list.filteredItems.length,
              MAX_VISIBLE,
            ),
          );
          return;
        }
        list.handleInput(data); // arrows, enter, escape
      },
      invalidate(): void {
        list.invalidate();
      },
    };
  };

  /** Open the typeahead modal. Returns the picked "provider/id", or null. */
  const openPicker = async (ctx: ExtensionContext): Promise<string | null> => {
    if (SelectListCtor === null) return null;
    const sorted = sortedModels(ctx);
    if (sorted.length < 2) return null;
    const current = (ctx as unknown as { model?: PickerModel | undefined }).model;
    const currentKey = current ? keyOf(current.provider, current.id) : null;
    const items = sorted.map((m) => {
      const k = keyOf(m.provider, m.id);
      const details = [k === currentKey ? "current" : null, modelPriceLabel(m)].filter(
        (detail): detail is string => detail !== null,
      );
      return { value: k, label: k, description: details.length > 0 ? details.join(" · ") : undefined };
    });
    const ui = ctx.ui as unknown as {
      custom: <T>(
        factory: (
          tui: { requestRender(force?: boolean): void },
          theme: unknown,
          kb: unknown,
          done: (v: T) => void,
        ) => { render(width: number): string[]; handleInput(data: string): void; invalidate(): void },
      ) => Promise<T>;
    };
    return await ui.custom<string | null>((_tui, _theme, _kb, done) => {
      const typeahead = makeTypeahead(items, (value) => done(value), () => done(null));
      return {
        render: (width: number) => typeahead.render(width),
        handleInput: (data: string) => typeahead.handleInput(data),
        invalidate: () => typeahead.invalidate(),
      };
    });
  };

  const recordUseAndSave = (provider: string, id: string): void => {
    try {
      const usage = recordUse(loadUsage(nodeFs, USAGE_FILE), provider, id, Date.now());
      saveUsage(nodeFs, USAGE_FILE, usage);
    } catch {
      // Usage data is an ordering optimization, never a gate; a failed write
      // only costs frecency accuracy.
    }
  };

  const applyPick = async (
    ctx: ExtensionContext,
    picked: string,
    models: readonly PickerModel[],
  ): Promise<boolean> => {
    const target = models.find((m) => keyOf(m.provider, m.id) === picked);
    if (target === undefined) return false;
    const current = (ctx as unknown as { model?: PickerModel | undefined }).model;
    if (current !== undefined && keyOf(current.provider, current.id) === picked) {
      recordUseAndSave(current.provider, current.id); // no event on a same-model pick
      return true;
    }
    return await pi.setModel(target as never);
  };

  // Keep the frecency data warm on every selection, however it happens.
  pi.on("model_select", (event: { model?: PickerModel | undefined }) => {
    const m = event?.model;
    if (m?.provider && m?.id) recordUseAndSave(m.provider, m.id);
  });

  pi.on("session_start", async (event: { reason?: string }, ctx: ExtensionContext) => {
    // Launch only. session_start also fires on /new, forks, reloads, and
    // session switches (e.g. a delegate sub-session) — reopening the picker
    // there stole the screen, and the process.exit below turned an overlay
    // torn down by the switch into a silent clean exit of all of pi.
    if (event?.reason !== "startup") return;
    if (ctx.mode !== "tui") return; // RPC/print: no modal surface
    if (pickerDisabled(nodeFs, SETTINGS_FILE)) return;
    if (SelectListCtor === null) return;
    const picked = await openPicker(ctx);
    if (picked === null) {
      // Escape at LAUNCH = quit pi: no model chosen, no session. Guarded so
      // only a human answering the picker can quit: an overlay torn down
      // programmatically (isIdle !== false) must not kill the process.
      const idle = (ctx as unknown as { isIdle?: () => boolean }).isIdle;
      if (typeof idle !== "function" || idle() !== false) process.exit(0);
      return;
    }
    const sorted = sortedModels(ctx);
    await applyPick(ctx, picked, sorted);
  });

  pi.registerCommand("models", {
    description: hasSelectList
      ? "Model picker: typeahead with paging (alt+m); /models <query> switches directly"
      : "Switch model by reference (/models <query>)",
    getArgumentCompletions: (prefix: string) => {
      const query = prefix.trim();
      if (query.length === 0) return null;
      const matches = resolveModelArgument(listAllModelRefs(), query);
      if (matches.length === 0) return null;
      return matches
        .slice(0, 20)
        .map((m) => ({ value: keyOf(m.provider, m.id), label: keyOf(m.provider, m.id) }));
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const query = args.trim();
      const models = sortedModels(ctx);
      if (query.length === 0) {
        if (ctx.mode === "tui" && hasSelectList) {
          const picked = await openPicker(ctx);
          if (picked !== null) await applyPick(ctx, picked, models);
          return;
        }
        const current = (ctx as unknown as { model?: PickerModel | undefined }).model;
        const currentKey = current ? keyOf(current.provider, current.id) : null;
        const lines = models.map(
          (m) => `${keyOf(m.provider, m.id) === currentKey ? "* " : "  "}${keyOf(m.provider, m.id)}`,
        );
        ctx.ui.notify(
          ["Model (frecency order; * = current):", ...lines.slice(0, 40)].join("\n"),
          "info",
        );
        return;
      }
      const matches = resolveModelArgument(models, query);
      if (matches.length === 0) {
        ctx.ui.notify(`No model matches "${query}".`, "error");
        return;
      }
      if (matches.length > 1) {
        ctx.ui.notify(
          `"${query}" is ambiguous (${matches.length} matches): ${matches
            .slice(0, 8)
            .map((m) => keyOf(m.provider, m.id))
            .join(", ")}${matches.length > 8 ? ", …" : ""}`,
          "error",
        );
        return;
      }
      const pickedKey = keyOf(matches[0].provider, matches[0].id);
      const ok = await applyPick(ctx, pickedKey, matches);
      ctx.ui.notify(
        ok ? `Model set to ${pickedKey}.` : "Model switch failed (provider auth not configured?).",
        ok ? "info" : "error",
      );
    },
  });

  pi.registerShortcut("alt+m", {
    description: "Model picker: typeahead with paging",
    handler: async (ctx: ExtensionContext) => {
      if (ctx.mode !== "tui" || !hasSelectList) {
        ctx.ui.notify(
          "The model picker needs the interactive TUI. Use /models <query> to switch directly.",
          "warning",
        );
        return;
      }
      const picked = await openPicker(ctx);
      if (picked !== null) {
        const sorted = sortedModels(ctx);
        await applyPick(ctx, picked, sorted);
      }
    },
  });
}
