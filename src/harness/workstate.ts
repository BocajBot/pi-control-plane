/**
 * Pi Harness - the WORKSTATE.md recovery snapshot (spec section 16).
 *
 * Pure rendering. The file this produces is explicitly *not* authoritative:
 * structured state and the observed environment both outrank it (invariant
 * R2), and it exists for the case where those are damaged or unavailable.
 *
 * That status drives two choices that would otherwise look odd:
 *
 * - It is Markdown for a human, not JSON for the harness. Nothing in the
 *   harness parses it back. A machine-readable recovery file invites a
 *   reader that trusts it, and a trusted WORKSTATE is an R2 violation
 *   waiting to happen.
 *
 * - It states its own subordinate status in the header. Whoever opens this
 *   file is by definition in a bad situation and may not remember the rule.
 */

import { formatAuditEvent } from "./audit.ts";
import type {
  AuditEvent,
  DecisionRecord,
  IncidentRecord,
  SessionState,
  TaskRecord,
} from "./types.ts";
import { describeScope } from "./scope.ts";

export interface WorkstateInput {
  session: SessionState;
  currentTask: TaskRecord | null;
  decisions: DecisionRecord[];
  incidents: IncidentRecord[];
  recentAudit: AuditEvent[];
}

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return `## ${title}\n\n_none_\n`;
  return `## ${title}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`;
}

export function renderWorkstate(input: WorkstateInput): string {
  const { session, currentTask, decisions, incidents, recentAudit } = input;
  const coordinator = session.coordinator
    ? `${session.coordinator.provider}/${session.coordinator.model}${
        session.coordinator.thinkingLevel ? ` (thinking: ${session.coordinator.thinkingLevel})` : ""
      }`
    : "(none recorded)";

  return [
    "# WORKSTATE",
    "",
    "_Recovery snapshot, not the authoritative record._ Structured harness",
    "state and the actual observed environment both outrank this file. Use it",
    "when structured state is damaged or unavailable, and verify anything you",
    "read here against the environment before acting on it.",
    "",
    `Session: \`${session.id}\`  `,
    `Project: \`${session.projectRoot}\`  `,
    `Device: \`${session.deviceId}\`  `,
    `Updated: ${session.updatedAt}  `,
    `Checkpoints: ${session.checkpointCount}`,
    "",
    "## Current task",
    "",
    currentTask
      ? `\`${currentTask.id}\` [${currentTask.status}] ${currentTask.objective}`
      : "_none_",
    "",
    "## Current scope",
    "",
    `\`${describeScope(session.scope)}\`  `,
    `Granted by: ${session.scope.grantedBy}`,
    "",
    "## Mode",
    "",
    `Coordinator: ${coordinator}  `,
    `Reasoning: ${session.reasoningMode}  `,
    `Autonomy: ${session.autonomy}  `,
    `Approval: ${session.approvalPolicy}`,
    "",
    "## Last verified state",
    "",
    session.lastVerifiedState ?? "_nothing verified yet - there is no safe resume point_",
    "",
    section("Important findings", session.findings),
    // Labelled as provisional in the heading itself, per invariant M2. The
    // reader of this file is recovering, and the difference between a
    // finding and an assumption is exactly what they must not lose.
    section("Active assumptions (provisional)", session.assumptions),
    section(
      "Decisions",
      decisions.map((d) => `\`${d.id}\` [${d.kind}] ${d.statement}`),
    ),
    section(
      "Incidents",
      incidents.map((i) => `\`${i.id}\` [${i.severity}/${i.suspectedCause}] ${i.description}`),
    ),
    section("Unresolved questions", session.unresolvedQuestions),
    section("Relevant files", session.relevantFiles.map((f) => `\`${f}\``)),
    "## Next intended action",
    "",
    session.nextAction ?? "_none recorded_",
    "",
    section(
      "Recent audit events",
      recentAudit.map((event) => `\`${formatAuditEvent(event)}\``),
    ),
    "## References",
    "",
    `Session file: ${session.sessionFile ? `\`${session.sessionFile}\`` : "_unknown_"}  `,
    `Decision ids: ${session.decisionIds.length > 0 ? session.decisionIds.join(", ") : "_none_"}  `,
    `Incident ids: ${session.incidentIds.length > 0 ? session.incidentIds.join(", ") : "_none_"}`,
    "",
  ].join("\n");
}
