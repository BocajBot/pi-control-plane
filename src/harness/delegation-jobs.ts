/**
 * Durable lifecycle facts for in-process Pi delegates.
 *
 * A nested AgentSession is not a worker process and cannot survive its
 * parent. These helpers deliberately do not pretend otherwise. They reduce
 * an append-only event stream to the latest state, identify a running record
 * whose owning process is gone, and validate an exact user approval for a
 * blocked read-root request.
 */

import {
  DELEGATION_JOB_STATUSES,
  HARNESS_SCHEMA_VERSION,
  type DelegationJobRecord,
  type DelegationJobStatus,
  type DecisionRecord,
  type DelegationContract,
} from "./types.ts";
import { idKind, nowIso, type Clock } from "./util.ts";

export function makeDelegationJob(
  contract: DelegationContract,
  options: {
    status: DelegationJobStatus;
    detail: string;
    pendingReadRoot?: string | null;
    resumesContract?: string | null;
    approvalDecisionId?: string | null;
    ownerPid?: number;
    repoAnchor?: string | null;
  },
  clock: Clock = () => new Date(),
): DelegationJobRecord {
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: contract.id,
    contractId: contract.id,
    resumesContract: options.resumesContract ?? null,
    approvalDecisionId: options.approvalDecisionId ?? null,
    parentSession: contract.parentSession,
    parentActor: contract.parentActor,
    kind: contract.kind,
    objective: contract.objective,
    readRoots: contract.scope.allowedRoots.slice(),
    autonomy: contract.autonomy,
    approvalPolicy: contract.approvalPolicy,
    capabilities: contract.allowedCapabilities.slice(),
    status: options.status,
    pendingReadRoot: options.pendingReadRoot ?? null,
    detail: options.detail,
    ownerPid: options.ownerPid ?? process.pid,
    at: nowIso(clock),
    repoAnchor: options.repoAnchor ?? null,
  };
}

export function validateDelegationJob(value: unknown): DelegationJobRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Partial<DelegationJobRecord>;
  if (
    v.schemaVersion !== HARNESS_SCHEMA_VERSION ||
    typeof v.id !== "string" || idKind(v.id) !== "delegation" ||
    v.contractId !== v.id ||
    typeof v.parentSession !== "string" || idKind(v.parentSession) !== "session" ||
    !DELEGATION_JOB_STATUSES.includes(v.status as DelegationJobStatus) ||
    !Array.isArray(v.readRoots) || !v.readRoots.every((r) => typeof r === "string") ||
    !Array.isArray(v.capabilities) || !v.capabilities.every((c) => typeof c === "string") ||
    typeof v.ownerPid !== "number" || !Number.isInteger(v.ownerPid) || v.ownerPid <= 0 ||
    typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))
  ) return null;
  // repoAnchor is additive (Phase 4.2 external-evidence): older records lack it.
  // Normalize a missing/non-string anchor to null so the reader's no-faith-join
  // drop path sees null, never undefined.
  return { ...(v as DelegationJobRecord), repoAnchor: typeof v.repoAnchor === "string" ? v.repoAnchor : null };
}

/** Latest append wins for each attempt id; history remains in the file. */
export function latestDelegationJobs(records: DelegationJobRecord[]): DelegationJobRecord[] {
  const latest = new Map<string, DelegationJobRecord>();
  for (const record of records) latest.set(record.id, record);
  return [...latest.values()];
}

export function transitionDelegationJob(
  previous: DelegationJobRecord,
  status: DelegationJobStatus,
  detail: string,
  options: { pendingReadRoot?: string | null; approvalDecisionId?: string | null } = {},
  clock: Clock = () => new Date(),
): DelegationJobRecord {
  return {
    ...previous,
    status,
    detail,
    pendingReadRoot: options.pendingReadRoot === undefined ? previous.pendingReadRoot : options.pendingReadRoot,
    approvalDecisionId: options.approvalDecisionId === undefined
      ? previous.approvalDecisionId
      : options.approvalDecisionId,
    at: nowIso(clock),
  };
}

export function orphanedDelegationJobs(
  records: DelegationJobRecord[],
  pidAlive: (pid: number) => boolean,
): DelegationJobRecord[] {
  return latestDelegationJobs(records).filter((job) => job.status === "running" && !pidAlive(job.ownerPid));
}

export function approvalStatement(contractId: string, canonicalRoot: string): string {
  return `approve delegate ${contractId} read scope: ${canonicalRoot}`;
}

export function matchingUserApproval(
  decisions: DecisionRecord[],
  decisionId: string,
  contractId: string,
  canonicalRoot: string,
): DecisionRecord | null {
  return decisions.find((decision) =>
    decision.id === decisionId &&
    decision.createdBy === "user" &&
    decision.statement === approvalStatement(contractId, canonicalRoot)
  ) ?? null;
}
