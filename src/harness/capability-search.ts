/**
 * Capability search matching (section TO1).
 *
 * Split out of the extension so the matching itself is testable without Pi.
 *
 * Two things this fixes over a plain `description.includes(need)`:
 *
 *  1. `need` arrives as a natural-language sentence ("run a command on the
 *     host outside the sandbox, with network access"). A whole-sentence
 *     substring test can only ever match if a tool description contains that
 *     exact sentence, so every realistic need missed and the tool answered
 *     "No capability matches" for capabilities that were present.
 *
 *  2. Some capabilities are not tools at all: they are posture changes only
 *     the user can make. A model that cannot see them concludes the task is
 *     impossible instead of naming the one command that unblocks it.
 */

/** Words carrying no signal for capability matching. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for", "from",
  "how", "i", "in", "into", "is", "it", "its", "me", "my", "need", "of", "on",
  "or", "so", "that", "the", "their", "them", "then", "there", "this", "to",
  "use", "want", "was", "what", "when", "which", "with", "would",
]);

export interface CapabilityCandidate {
  name: string;
  description?: string;
}

export interface CapabilityMatch extends CapabilityCandidate {
  /** Count of distinct need-terms found in the name or description. */
  score: number;
}

/**
 * A posture change that grants an ability, which only the user can perform.
 *
 * These are deliberately data, not tools: surfacing one is not a way for a
 * model to perform it. The command is quoted verbatim so the model can hand
 * the user something copyable rather than describing it approximately.
 */
export interface UserGrant {
  /** Terms that should surface this grant. */
  terms: string[];
  /** What the grant enables, in the model's own vocabulary. */
  ability: string;
  /** The exact command the user runs. */
  command: string;
}

export const USER_GRANTS: readonly UserGrant[] = [
  {
    terms: ["network", "net", "internet", "http", "https", "curl", "localhost", "port", "url", "fetch", "download", "api"],
    ability: "networking inside the sandboxed shell (it is unshared by default, so loopback and the internet are both unreachable)",
    command: "/harness scope network on",
  },
  {
    terms: ["write", "edit", "modify", "create", "mutate", "save", "change", "patch", "delete", "remove"],
    ability: 'writing inside the sandboxed shell (pass mode:"write" to pi_harness_bash; the scope root is read-only otherwise)',
    command: 'pi_harness_bash(mode:"write") — the user confirms the write when prompted',
  },
  {
    terms: ["scope", "outside", "path", "directory", "folder", "root", "elsewhere", "another"],
    ability: "a wider scope root, when the path you need is outside the current one",
    command: "/harness scope approve <path>",
  },
  {
    terms: ["shell", "bash", "builtin", "unsandboxed", "unconfined", "host"],
    ability: "Pi's builtin unsandboxed shell, which the harness removes from the active set",
    command: "/harness capability grant bash <reason>",
  },
];

/** Distinct, meaningful, lowercased terms in a need string. */
export function needTerms(need: string): string[] {
  const terms = need
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
  return [...new Set(terms)];
}

/**
 * Rank tools against a need.
 *
 * A whole-need substring hit still wins outright - it is the strongest signal
 * available and keeps single-word needs ("shell") behaving exactly as before.
 * Otherwise tools are ranked by how many distinct need-terms they carry, and
 * anything matching nothing is dropped.
 */
export function searchCapabilities(need: string, catalog: readonly CapabilityCandidate[]): CapabilityMatch[] {
  const whole = need.toLowerCase().trim();
  const terms = needTerms(need);

  const scored = catalog.map((tool) => {
    const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
    if (whole.length > 0 && haystack.includes(whole)) {
      return { ...tool, score: terms.length + 1 };
    }
    const score = terms.reduce((total, term) => (haystack.includes(term) ? total + 1 : total), 0);
    return { ...tool, score };
  });

  return scored
    .filter((tool) => tool.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

/** User-grantable postures relevant to a need, most relevant first. */
export function matchingUserGrants(need: string): UserGrant[] {
  const terms = needTerms(need);
  if (terms.length === 0) return [];
  return USER_GRANTS.map((grant) => ({
    grant,
    score: grant.terms.reduce((total, term) => (terms.includes(term) ? total + 1 : total), 0),
  }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.grant);
}
