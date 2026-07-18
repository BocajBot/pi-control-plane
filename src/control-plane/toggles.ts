/**
 * Source toggles: verified excision of prompt components from the assembled
 * system prompt.
 *
 * Honesty rule: a toggle only counts as applied when the excision verifiably
 * removed the content. When verification fails, the caller must report the
 * source as still enabled — never display a source as disabled while it still
 * reaches the provider.
 */

export interface ExcisionResult {
  prompt: string;
  /** Toggle names whose excision could not be verified. */
  failed: string[];
}

/**
 * Remove all occurrences of `block` from `prompt`, then verify absence.
 * Returns null when the block was not found or is still present afterwards.
 */
export function exciseExact(prompt: string, block: string): string | null {
  if (block.length === 0) return null;
  if (!prompt.includes(block)) return null;
  const result = prompt.split(block).join("");
  if (result.includes(block)) return null;
  return result;
}

export interface ContextFileLike {
  path: string;
  content: string;
}

/** Toggle-name helpers shared between snapshot building and toggle handling. */
export const toggleName = {
  contextFile: (path: string) => `file:${path}`,
  skill: (name: string) => `skill:${name}`,
  tool: (name: string) => `tool:${name}`,
  template: (name: string) => `template:${name}`,
};

/**
 * Apply context-file toggles by excising each disabled file's content from the
 * assembled system prompt. Files whose content cannot be verifiably removed
 * are reported in `failed` and must be treated as still enabled.
 */
export function applyContextFileToggles(
  systemPrompt: string,
  contextFiles: ContextFileLike[],
  toggles: Record<string, boolean>,
): ExcisionResult {
  let prompt = systemPrompt;
  const failed: string[] = [];
  for (const file of contextFiles) {
    const name = toggleName.contextFile(file.path);
    if (toggles[name] !== false) continue; // enabled (default) — nothing to do
    if (file.content.trim().length === 0) {
      // Nothing to excise; an empty file contributes nothing. Treat as applied.
      continue;
    }
    const excised = exciseExact(prompt, file.content);
    if (excised === null) {
      failed.push(name);
    } else {
      prompt = excised;
    }
  }
  return { prompt, failed };
}

/**
 * Replace the full skills block with a filtered one. Both blocks must be
 * produced by the same formatter (Pi's formatSkillsForPrompt). Returns null
 * when the original block cannot be found or the replacement failed
 * verification, in which case skill toggles must be reported as not applied.
 */
export function replaceSkillsBlock(
  systemPrompt: string,
  fullBlock: string,
  filteredBlock: string,
): string | null {
  if (fullBlock.length === 0 || !systemPrompt.includes(fullBlock)) return null;
  const result = systemPrompt.split(fullBlock).join(filteredBlock);
  // Verify: the unfiltered block must be gone (unless the filtered block
  // contains it, which only happens when nothing was filtered).
  if (filteredBlock !== fullBlock && result.includes(fullBlock)) return null;
  return result;
}
