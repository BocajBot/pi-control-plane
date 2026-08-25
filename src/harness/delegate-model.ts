/**
 * Resolving the model a delegate runs on (spec section 26).
 *
 * A delegate inherits the coordinator's model unless one is named. Naming one
 * is what makes "ask the local model, in its own context" expressible: the
 * isolation a subagent already provides is context isolation, and without
 * model selection the only way to reach a different model was to leave the
 * harness entirely and call its HTTP endpoint by hand - which is neither
 * isolated nor auditable.
 *
 * Pure by construction so the matching is testable without Pi: callers pass
 * the candidate list they read from the registry.
 */

export interface ModelCandidate {
  provider: string;
  id: string;
}

export type DelegateModelResolution =
  | { ok: true; model: ModelCandidate }
  | { ok: false; reason: string };

/**
 * Resolve a model spec against the available models.
 *
 * Accepted forms:
 *   "provider/id" - exact, and the only unambiguous form
 *   "id"          - accepted only when exactly one provider offers it
 *
 * An ambiguous bare id is refused rather than guessed: silently picking a
 * provider would route a delegate to a different model (and a different bill)
 * than the caller named.
 */
export function resolveDelegateModel(spec: string, available: readonly ModelCandidate[]): DelegateModelResolution {
  const wanted = spec.trim();
  if (wanted.length === 0) return { ok: false, reason: "model must not be empty" };

  const slash = wanted.indexOf("/");
  if (slash > 0) {
    const provider = wanted.slice(0, slash);
    const id = wanted.slice(slash + 1);
    const exact = available.find((model) => model.provider === provider && model.id === id);
    return exact
      ? { ok: true, model: exact }
      : { ok: false, reason: `no available model "${wanted}". ${describeAvailable(available)}` };
  }

  const matches = available.filter((model) => model.id === wanted);
  if (matches.length === 1) return { ok: true, model: matches[0] };
  if (matches.length === 0) {
    return { ok: false, reason: `no available model "${wanted}". ${describeAvailable(available)}` };
  }
  return {
    ok: false,
    reason:
      `"${wanted}" is offered by ${matches.length} providers ` +
      `(${matches.map((model) => model.provider).join(", ")}); name it as provider/id`,
  };
}

/** Compact list of what the caller could have asked for. */
export function describeAvailable(available: readonly ModelCandidate[]): string {
  if (available.length === 0) return "No models are available.";
  const names = available.map((model) => `${model.provider}/${model.id}`);
  const shown = names.slice(0, 20);
  const rest = names.length - shown.length;
  return `Available: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}.`;
}
