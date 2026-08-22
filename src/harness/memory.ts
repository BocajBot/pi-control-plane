/**
 * Pi Harness - memory writes, promotion, and supersession
 * (spec section 10; invariants M1-M6).
 *
 * Pure: builds and transforms entries; store.ts appends them.
 *
 * The whole point of this module is one refusal. The active coordinator can
 * write session notes all day (state.ts), but it cannot move any of them
 * into durable global memory - only the user, by direction, or a
 * retrospective reviewer, by promotion with citations. `promote()` enforces
 * that by actor, not by asking nicely, because M1 is the invariant most
 * likely to erode: a model that has just learned something genuinely useful
 * is exactly the model that will argue it should be remembered.
 *
 * Supersession never deletes (M4). `supersede()` returns *both* records -
 * the new entry and the retired old one - so a caller physically cannot
 * write the replacement without also writing the tombstone.
 *
 * v0.2 adds scope (spec section 32). A durable memory is either global or
 * bound to one project, and retrieval outside that project does not return
 * it. This is a correctness rule, not a ranking one: "run codegen before the
 * build" is not a weakly relevant result in an unrelated repository, it is a
 * false statement about it, and a coordinator reading it back has no way to
 * tell which repository it came from.
 */

import {
  HARNESS_SCHEMA_VERSION,
  MEMORY_SCOPES,
  type Actor,
  type MemoryEntry,
  type MemoryEpistemicType,
  type MemoryScope,
  type MemoryStatus,
} from "./types.ts";
import { makeId, nowIso, type Clock, type RandomSource } from "./util.ts";

/** Actors permitted to create durable memory (invariant M1). */
const PROMOTION_ACTORS: ReadonlySet<Actor> = new Set<Actor>(["user", "reviewer"]);

function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value);
}

/**
 * A project root is present only if it is a non-empty string.
 *
 * `""` and `"   "` are treated as absent rather than as a project named
 * nothing, because an empty root is what a caller produces when it *has* no
 * project - and an entry bound to the empty root would be retrievable in
 * exactly one place: nowhere, silently.
 */
function normalizeProjectRoot(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The scope a draft or entry that predates v0.2 is read as.
 *
 * Global, always. v0.1 kept one undifferentiated memory file and returned
 * every entry everywhere, so reading an unscoped record as global preserves
 * the behaviour that was actually in force when it was written. Reading it as
 * project-scoped would retroactively invent a binding nobody recorded, and
 * would quietly delete the entry from every retrieval that is not in the
 * project we guessed.
 */
function scopeOf(value: unknown): MemoryScope {
  return isMemoryScope(value) ? value : "global";
}

export interface MemoryDraft {
  category: string;
  subcategory?: string | null;
  epistemicType: MemoryEpistemicType;
  content: string;
  /** Session-entry or audit-event ids. Required for a reviewer promotion
   * (M5): a reviewer's reading of history is only trustworthy if the
   * history it read can be found again. */
  sourceReferences?: string[];
  /** Where the claim applies (spec section 32). Optional at runtime only so
   * that v0.1-shaped callers keep working; they are read as global, see
   * `scopeOf`. */
  scope: MemoryScope;
  /** Project root for a project-scoped draft; null or absent for a global
   * one. The canonical root, not the hashed project key, so memory.jsonl
   * stays readable by a human. */
  project?: string | null;
}

export type PromotionOutcome =
  | { ok: true; entry: MemoryEntry }
  | { ok: false; reason: string; rule: string };

/**
 * Promote a draft into durable memory.
 *
 * Two refusals, both by rule rather than by judgment:
 *
 * - a non-promoting actor is refused outright (M1). There is no override
 *   parameter; the caller that wants one is the caller M1 exists to stop.
 * - a reviewer promotion with no source references is refused (M5). The user
 *   may promote without citations - a user's direction is itself the source
 *   - but a reviewer's conclusion without evidence is speculation being
 *   converted into fact, which section 20 forbids explicitly.
 *
 * Two more come from section 32, and both refuse a *combination* rather than
 * a missing field:
 *
 * - project scope with no project root has nowhere to apply. Storing it
 *   anyway would produce an entry that retrieval can never return, which is
 *   indistinguishable from having silently dropped the promotion.
 * - global scope carrying a project root is a category error, not a harmless
 *   extra field: the two halves disagree about where the claim holds, and
 *   whichever half a later reader trusts, the other one was a lie. Refusing
 *   here is cheaper than deciding later which half to believe.
 */
/**
 * What the caller is authorized to write.
 *
 * `permittedProject` is required for a project-scoped promotion and is the
 * project the *caller* has authority over - not the one the draft asks for.
 * The two being separate parameters is the whole point: a draft is data,
 * potentially shaped by a model's output, and a memory that fires in a
 * project the promoting session had nothing to do with is a cross-project
 * write dressed up as a note. Making it a required argument means a new call
 * site cannot forget to state its authority; it can only state it wrongly,
 * which is visible at the call site.
 */
export interface PromotionAuthority {
  permittedProject: string | null;
}

export function promote(
  actor: Actor,
  draft: MemoryDraft,
  clock: Clock = () => new Date(),
  random?: RandomSource,
  authority?: PromotionAuthority,
): PromotionOutcome {
  if (!PROMOTION_ACTORS.has(actor)) {
    return {
      ok: false,
      reason: `actor "${actor}" cannot write durable memory; record it as a session note or a reviewer proposal instead`,
      rule: "M1",
    };
  }
  const content = draft.content.trim();
  if (content.length === 0) {
    return { ok: false, reason: "empty memory content", rule: "M3" };
  }
  const sources = draft.sourceReferences ?? [];
  if (actor === "reviewer" && sources.length === 0) {
    return {
      ok: false,
      reason: "a reviewer promotion must cite the session entries it was derived from",
      rule: "M5",
    };
  }
  // An unrecognised scope is refused rather than coerced. `scopeOf` reads a
  // *missing* scope as global because that is what v0.1 meant; a scope that
  // is present but not one we know means the caller intended something this
  // build does not implement, and guessing at it is how a project memory ends
  // up global.
  if (draft.scope !== undefined && !isMemoryScope(draft.scope)) {
    return {
      ok: false,
      reason: `unknown memory scope ${JSON.stringify(draft.scope)}; expected "global" or "project"`,
      rule: "section 32",
    };
  }
  const scope = scopeOf(draft.scope);
  const project = normalizeProjectRoot(draft.project);
  if (scope === "project" && project === null) {
    return {
      ok: false,
      reason: "a project-scoped memory needs the project root it applies to",
      rule: "section 32",
    };
  }
  if (scope === "global" && project !== null) {
    return {
      ok: false,
      reason: `a global memory cannot also belong to project ${project}; promote it as project-scoped or drop the project`,
      rule: "section 32",
    };
  }
  if (scope === "project") {
    // Deny-by-default: an unstated authority is refused, not assumed to be
    // whatever the draft asked for.
    const permitted = normalizeProjectRoot(authority?.permittedProject ?? null);
    if (permitted === null) {
      return {
        ok: false,
        reason:
          "a project-scoped promotion must state the project the caller is authorized to write (pass PromotionAuthority)",
        rule: "A2 / section 32",
      };
    }
    if (permitted !== project) {
      return {
        ok: false,
        reason: `caller is authorized for ${permitted} but the memory claims ${project}; a retrospective on one project cannot plant memory in another`,
        rule: "A2 / section 32",
      };
    }
  }
  return {
    ok: true,
    entry: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      id: makeId("memory", random),
      category: draft.category,
      subcategory: draft.subcategory ?? null,
      epistemicType: draft.epistemicType,
      content,
      sourceReferences: sources,
      createdBy: actor,
      createdAt: nowIso(clock),
      status: "active",
      supersedes: null,
      scope,
      project,
    },
  };
}

export type SupersedeOutcome =
  | { ok: true; entry: MemoryEntry; retired: MemoryEntry }
  | { ok: false; reason: string; rule: string };

/**
 * Replace an existing entry with a newer one.
 *
 * Returns the pair. The old entry comes back with `status: "superseded"` and
 * its content untouched - what used to be true remains readable, and may
 * itself be evidence later (spec section 10.7). The new entry points back
 * via `supersedes`, so the chain is walkable in both directions.
 *
 * Scope is carried forward from the entry being replaced, and a draft that
 * disagrees is refused rather than honoured (section 32). Supersession is an
 * *update to a claim*, not a re-scoping of it: letting a global replacement
 * retire a project memory would widen where the claim applies without anyone
 * deciding to widen it, and the widening would be invisible afterwards
 * because the retired entry looks like a normal supersession. The same goes
 * for moving a memory between projects. Re-scoping is available - promote the
 * new entry at the scope you want and retire the old one deliberately - it
 * just cannot happen as a side effect of an edit.
 */
export function supersede(
  actor: Actor,
  old: MemoryEntry,
  draft: MemoryDraft,
  clock: Clock = () => new Date(),
  random?: RandomSource,
  authority?: PromotionAuthority,
): SupersedeOutcome {
  if (!PROMOTION_ACTORS.has(actor)) {
    return { ok: false, reason: `actor "${actor}" cannot supersede durable memory`, rule: "M1" };
  }
  if (old.status !== "active") {
    return {
      ok: false,
      reason: `entry ${old.id} is already ${old.status}; supersede the entry that replaced it`,
      rule: "M4",
    };
  }
  const oldScope = scopeOf(old.scope);
  const oldProject = normalizeProjectRoot(old.project);
  if (draft.scope !== undefined && scopeOf(draft.scope) !== oldScope) {
    return {
      ok: false,
      reason: `entry ${old.id} is ${oldScope}-scoped and cannot be superseded by a ${String(draft.scope)}-scoped memory; promote the new scope as its own entry`,
      rule: "section 32",
    };
  }
  // `undefined` means "the draft did not say", which inherits. An explicit
  // null on a project-scoped entry is the draft saying "no project", which is
  // a disagreement and is refused like any other.
  const draftProject = draft.project === undefined ? oldProject : normalizeProjectRoot(draft.project);
  if (draftProject !== oldProject) {
    return {
      ok: false,
      reason: `entry ${old.id} belongs to ${oldProject ?? "no project"} and cannot be superseded by a memory belonging to ${draftProject ?? "no project"}`,
      rule: "section 32",
    };
  }
  // Authority is threaded, not derived from the entry being replaced.
  // `oldProject` is already pinned above, so the *new* entry cannot move
  // projects - but retiring project B's memory while authorized only for
  // project A is still a cross-project write, and it is the caller's
  // authority that decides it, not the record's.
  const created = promote(actor, { ...draft, scope: oldScope, project: oldProject }, clock, random, authority);
  if (!created.ok) return created;
  return {
    ok: true,
    entry: { ...created.entry, supersedes: old.id },
    retired: { ...old, status: "superseded" as MemoryStatus },
  };
}

/**
 * Collapse an append-only memory log into the currently active view.
 *
 * The file holds every version ever written, including the pre-supersession
 * copies of entries that were later replaced. Later lines win, and anything
 * a later entry supersedes is dropped from the active view - but only from
 * the *view*. The log itself is untouched (M4, M6).
 */
export function activeMemory(entries: MemoryEntry[]): MemoryEntry[] {
  const latest = new Map<string, MemoryEntry>();
  for (const entry of entries) latest.set(entry.id, entry);
  const superseded = new Set<string>();
  for (const entry of latest.values()) {
    if (entry.supersedes) superseded.add(entry.supersedes);
  }
  return [...latest.values()].filter(
    (entry) => entry.status === "active" && !superseded.has(entry.id),
  );
}

/**
 * Fill in the scope fields a v0.1 entry does not have.
 *
 * Global, project null. v0.1 stored one undifferentiated memory file and
 * returned every entry in every project, so "global" is not a default chosen
 * for convenience - it is the scope those entries actually had in practice,
 * and recording it preserves the behaviour that was in force when they were
 * written. Defaulting to project would be worse than wrong: there is no
 * project root on the record to bind to, so it would retroactively invent a
 * binding nobody recorded and hide the entry from every retrieval.
 *
 * Entries that already carry a scope are returned unchanged, by reference, so
 * this is safe to run over a whole log on read.
 */
export function upgradeMemoryEntry(entry: MemoryEntry): MemoryEntry {
  if (isMemoryScope(entry.scope) && entry.project !== undefined) return entry;
  if (isMemoryScope(entry.scope)) return { ...entry, project: entry.project ?? null };
  return { ...entry, scope: "global", project: null };
}

/**
 * The entries a coordinator working in `projectRoot` is allowed to see.
 *
 * Global entries, plus the project's own. A project memory from an unrelated
 * project is excluded rather than deranked - see the module header: it is not
 * a weak match, it is a claim about a different repository, and nothing in
 * the retrieved text says so.
 *
 * `projectRoot` of null means "not in a project", and that excludes every
 * project memory. A later cross-project relationship mechanism (spec section
 * 13) is the only thing that may widen this, and it has to ask for the
 * entries explicitly rather than getting them by default.
 */
export function retrievableMemory(entries: MemoryEntry[], projectRoot: string | null): MemoryEntry[] {
  const root = normalizeProjectRoot(projectRoot);
  return activeMemory(entries).filter((entry) => {
    if (scopeOf(entry.scope) === "global") return true;
    const project = normalizeProjectRoot(entry.project);
    // A project-scoped entry with no root is unusable, and the conservative
    // direction for an unusable entry is invisible: it cannot be shown to a
    // project it may have nothing to do with. It stays in the log either way.
    return project !== null && project === root;
  });
}

/** Walk the supersession chain backwards from `id`, newest first. Used to
 * answer "what did we used to believe, and why did that change". */
export function historyOf(entries: MemoryEntry[], id: string): MemoryEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain: MemoryEntry[] = [];
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.supersedes ? byId.get(current.supersedes) : undefined;
  }
  return chain;
}

/**
 * Substring search across the active view, with the epistemic type kept in
 * the rendering so a retrieved opinion never reads as a retrieved fact.
 *
 * `projectRoot` is trailing and optional so v0.1 callers keep their exact
 * behaviour. The three states are deliberately distinct: omitted searches
 * everything active and is the unscoped legacy path, `null` searches as
 * someone outside any project (global entries only), and a root searches
 * global plus that project. Omitted and null are not the same request, so
 * they must not collapse into one.
 */
export function searchMemory(
  entries: MemoryEntry[],
  query: string,
  limit = 20,
  projectRoot?: string | null,
): MemoryEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const pool =
    projectRoot === undefined ? activeMemory(entries) : retrievableMemory(entries, projectRoot);
  return pool
    .filter(
      (entry) =>
        entry.content.toLowerCase().includes(needle) ||
        entry.category.toLowerCase().includes(needle) ||
        (entry.subcategory ?? "").toLowerCase().includes(needle),
    )
    .slice(0, limit);
}

/**
 * One line per entry. The scope is rendered for the same reason the epistemic
 * type is: a project memory read out loud without its project is a claim that
 * has quietly lost the thing that bounds it, and the reader cannot recover
 * that bound from the text.
 */
export function formatMemoryEntry(entry: MemoryEntry): string {
  const path = entry.subcategory ? `${entry.category}/${entry.subcategory}` : entry.category;
  const sources = entry.sourceReferences.length > 0 ? ` [${entry.sourceReferences.join(", ")}]` : "";
  const project = normalizeProjectRoot(entry.project);
  const scope = scopeOf(entry.scope) === "project" ? `project ${project ?? "(unbound)"}` : "global";
  return `${entry.id} (${entry.epistemicType}) <${scope}> ${path}: ${entry.content}${sources}`;
}
