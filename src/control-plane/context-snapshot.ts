/**
 * Context snapshots: a normalized, content-free description of the effective
 * context (names, paths, counts, lengths, and hashes — never raw content).
 *
 * Normalization is deterministic: all lists are sorted so that two snapshots
 * of identical state compare equal and hash-stable.
 */

import { createHash } from "node:crypto";
import {
  type Autonomy,
  type ContextSnapshot,
  type Phase,
  SNAPSHOT_SCHEMA_VERSION,
  type SnapshotItem,
} from "./types.ts";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface SnapshotInputs {
  timestamp: string;
  provider: string | null;
  model: string | null;
  contextWindow: number | null;
  tokens: number | null;
  percent: number | null;
  messageCount: number | null;
  messagesByRole: Record<string, number>;
  sources: SnapshotItem[];
  tools: string[];
  /** Already-redacted system prompt, or null when unavailable. */
  redactedSystemPrompt: string | null;
  /** Metadata of the last observed provider payload (redacted), if any. */
  providerPayload: { length: number; hash: string } | null;
  phase: Phase;
  autonomy: Autonomy;
  hasAcceptedTask: boolean;
}

export function buildSnapshot(inputs: SnapshotInputs): ContextSnapshot {
  const sources = [...inputs.sources].sort((a, b) => a.name.localeCompare(b.name));
  const tools = [...inputs.tools].sort((a, b) => a.localeCompare(b));
  const messagesByRole: Record<string, number> = {};
  for (const role of Object.keys(inputs.messagesByRole).sort()) {
    messagesByRole[role] = inputs.messagesByRole[role];
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    timestamp: inputs.timestamp,
    provider: inputs.provider,
    model: inputs.model,
    contextWindow: inputs.contextWindow,
    tokens: inputs.tokens,
    percent: inputs.percent,
    messageCount: inputs.messageCount,
    messagesByRole,
    sources,
    tools,
    systemPromptLength: inputs.redactedSystemPrompt?.length ?? null,
    systemPromptHash: inputs.redactedSystemPrompt !== null ? sha256(inputs.redactedSystemPrompt) : null,
    providerPayloadLength: inputs.providerPayload?.length ?? null,
    providerPayloadHash: inputs.providerPayload?.hash ?? null,
    phase: inputs.phase,
    autonomy: inputs.autonomy,
    hasAcceptedTask: inputs.hasAcceptedTask,
  };
}
