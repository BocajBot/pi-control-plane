/**
 * Completion-criteria verification pass.
 *
 * Pure module: given the accepted task brief, the files actually written, and
 * the audit entries recorded during the run (plus an injected fs existence
 * check), reports which deliverables and completion criteria are observable
 * as satisfied. It never invents evidence — a deliverable is satisfied only
 * when a recorded write/edit matches it or the file exists on disk; a
 * criterion is satisfied only when a recorded audit entry or written file
 * mentions it.
 *
 * Read-only: this module only observes and compares; it never gates or
 * mutates. It backs the /verify command and the Verify-mode closing step.
 */

import type { TaskBrief } from "./types.ts";

/** A loose view of one audit entry recorded during the run. */
export interface VerifyAuditEntry {
  kind?: string;
  toolName?: string;
  targetPath?: string;
  command?: string;
}

export interface VerifyInput {
  brief: TaskBrief;
  /** Paths recorded as written/edited during the run (as captured from tool input). */
  writtenFiles: string[];
  auditEntries: VerifyAuditEntry[];
  /** Injected fs existence check so the module stays pure and testable. */
  fileExists: (path: string) => boolean;
}

export interface DeliverableCheck {
  deliverable: string;
  satisfied: boolean;
  /** Human-readable, observable evidence (a written file or on-disk existence). */
  evidence: string;
}

export interface CriterionCheck {
  criterion: string;
  satisfied: boolean;
  evidence: string;
}

export interface VerificationReport {
  deliverables: DeliverableCheck[];
  completionCriteria: CriterionCheck[];
  satisfiedDeliverables: number;
  totalDeliverables: number;
  satisfiedCriteria: number;
  totalCriteria: number;
  /** ISO timestamp of the check. */
  at: string;
}

/**
 * Normalize a path to forward slashes without leading/trailing separators.
 * Pure — no node `path` import needed.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * A written path satisfies a deliverable when it IS the deliverable, or when
 * the deliverable ends with it at a path-separator boundary. This rejects the
 * basename-only fallback: "tmp/report.md" must NOT satisfy "docs/report.md",
 * but "src/foo.ts" does satisfy "/abs/src/foo.ts".
 */
function isDeliverableMatch(written: string, deliverable: string): boolean {
  const w = normalizePath(written);
  const d = normalizePath(deliverable);
  if (w === d) return true;
  if (w === "") return false;
  return d.endsWith(w) && d[d.length - w.length - 1] === "/";
}

/**
 * Compare the brief's deliverables / completion criteria against the recorded
 * written files and audit entries. Never a model-judged verdict — only what
 * is observable.
 */
export function verifyCompletion(input: VerifyInput): VerificationReport {
  const { brief, writtenFiles, auditEntries, fileExists } = input;

  const deliverables = brief.deliverables.map((d) => {
    const written = writtenFiles.some((wf) => isDeliverableMatch(wf, d));
    if (written) {
      return { deliverable: d, satisfied: true, evidence: `written (${d})` };
    }
    if (fileExists(d)) {
      return { deliverable: d, satisfied: true, evidence: `exists on disk (${d})` };
    }
    return { deliverable: d, satisfied: false, evidence: `not written and not found (${d})` };
  });

  const criteria = brief.completionCriteria.map((c) => {
    const needle = c.toLowerCase();
    const inAudit = auditEntries.some((e) =>
      [e.toolName ?? "", e.targetPath ?? "", e.command ?? ""].some(
        (s) => s.toLowerCase().includes(needle),
      ),
    );
    const inWritten = writtenFiles.some((wf) => wf.toLowerCase().includes(needle));
    const satisfied = inAudit || inWritten;
    return {
      criterion: c,
      satisfied,
      evidence: satisfied ? `observed (${c})` : `no recorded evidence (${c})`,
    };
  });

  return {
    deliverables,
    completionCriteria: criteria,
    satisfiedDeliverables: deliverables.filter((d) => d.satisfied).length,
    totalDeliverables: deliverables.length,
    satisfiedCriteria: criteria.filter((c) => c.satisfied).length,
    totalCriteria: criteria.length,
    at: new Date().toISOString(),
  };
}
