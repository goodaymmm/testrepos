import { readdir } from "node:fs/promises";
import { readJsonFile } from "../core/fs/json-file.js";
import { getKaironPaths, resolveInside } from "../core/fs/paths.js";
import { StateApplier } from "../state/state-applier.js";

export type ApprovalAction = "approve" | "reject" | "request_changes" | "snooze";

export type ApprovalRecord = {
  schema_version?: string;
  id: string;
  status: string;
  type?: string;
  title?: string;
  task_id?: string;
  run_id?: string;
  created_at?: string;
  updated_at?: string;
  actions?: ApprovalAction[];
  allowed_actions?: ApprovalAction[];
  [key: string]: unknown;
};

export type ApprovalListOptions = {
  status?: string;
};

export type ApprovalDecisionRequest = {
  approvalId: string;
  action: ApprovalAction;
  reason?: string;
  until?: string;
  actor?: unknown;
};

export type ApprovalDecisionResult = {
  schema_version: string;
  approval_id: string;
  action: ApprovalAction;
  status: string;
  applied_event_ids: string[];
  approval: ApprovalRecord;
};

const defaultActions: ApprovalAction[] = [
  "approve",
  "reject",
  "request_changes",
  "snooze"
];

const secretKeyPattern = /(secret|token|password|api[_-]?key|authorization|cookie)/i;
const omittedKeyPattern = /^(diff|patch|log|stdout|stderr|raw|body)$/i;

export class ApprovalQueue {
  constructor(
    private readonly projectRoot: string,
    private readonly options: { now?: () => Date } = {}
  ) {}

  async list(options: ApprovalListOptions = {}): Promise<ApprovalRecord[]> {
    const status = options.status ?? "pending";
    const approvals = await this.readApprovals();
    return approvals
      .filter((approval) => status === "all" || approval.status === status)
      .sort(compareApprovalRecords);
  }

  async show(approvalId: string): Promise<ApprovalRecord> {
    return this.readApproval(approvalId);
  }

  async decide(request: ApprovalDecisionRequest): Promise<ApprovalDecisionResult> {
    const approval = await this.readApproval(request.approvalId);
    assertApprovalPending(approval);
    assertActionAllowed(approval, request.action);

    const applier = new StateApplier(this.projectRoot);
    const result =
      request.action === "snooze"
        ? await applier.applyCommand({
            type: "approval.snooze",
            approval_id: request.approvalId,
            until: request.until ?? defaultSnoozeUntil(this.now()),
            reason: request.reason,
            actor: request.actor ?? { source: "local-cli" },
            received_at: this.now().toISOString()
          })
        : await applier.applyCommand({
            type: "approval.decide",
            approval_id: request.approvalId,
            decision: request.action,
            reason: request.reason,
            actor: request.actor ?? { source: "local-cli" },
            received_at: this.now().toISOString()
          });
    const updated = await this.readApproval(request.approvalId);

    return {
      schema_version: "0.1",
      approval_id: request.approvalId,
      action: request.action,
      status: updated.status,
      applied_event_ids: result.appliedEventIds,
      approval: updated
    };
  }

  private async readApprovals(): Promise<ApprovalRecord[]> {
    const approvalsDir = getKaironPaths(this.projectRoot).approvalsDir;
    let entries: string[];

    try {
      entries = await readdir(approvalsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }

    const approvals = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readJsonFile<ApprovalRecord>(resolveInside(approvalsDir, entry)))
    );

    return approvals.filter((approval) => typeof approval.id === "string");
  }

  private async readApproval(approvalId: string): Promise<ApprovalRecord> {
    try {
      return await readJsonFile<ApprovalRecord>(
        resolveInside(getKaironPaths(this.projectRoot).approvalsDir, `${approvalId}.json`)
      );
    } catch (error) {
      if (String(error).includes("ENOENT")) {
        throw new ApprovalNotFoundError(approvalId);
      }

      throw error;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export class ApprovalNotFoundError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval not found: ${approvalId}`);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalNotPendingError extends Error {
  constructor(
    readonly approvalId: string,
    readonly status: string
  ) {
    super(`Approval ${approvalId} is not pending or snoozed. Current status: ${status}`);
    this.name = "ApprovalNotPendingError";
  }
}

export class ApprovalActionNotAllowedError extends Error {
  constructor(
    readonly approvalId: string,
    readonly action: ApprovalAction
  ) {
    super(`Approval ${approvalId} does not allow action: ${action}`);
    this.name = "ApprovalActionNotAllowedError";
  }
}

export function formatApprovalList(approvals: ApprovalRecord[]): string {
  if (approvals.length === 0) {
    return "No approvals found.";
  }

  return [
    "Kairon approvals:",
    ...approvals.map((approval) =>
      [
        `id=${approval.id}`,
        `status=${approval.status}`,
        approval.type === undefined ? null : `type=${approval.type}`,
        approval.task_id === undefined ? null : `task=${approval.task_id}`,
        approval.title === undefined ? null : `title=${sanitizeInline(approval.title)}`
      ]
        .filter((part): part is string => part !== null)
        .join(" ")
    )
  ].join("\n");
}

export function formatApprovalDetail(approval: ApprovalRecord): string {
  const safe = sanitizeApprovalForDisplay(approval);
  return [
    "Kairon approval:",
    `id=${approval.id}`,
    `status=${approval.status}`,
    approval.type === undefined ? null : `type=${approval.type}`,
    approval.title === undefined ? null : `title=${sanitizeInline(approval.title)}`,
    approval.task_id === undefined ? null : `task=${approval.task_id}`,
    approval.run_id === undefined ? null : `run=${approval.run_id}`,
    `detail=${JSON.stringify(safe, null, 2)}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function formatApprovalDecision(result: ApprovalDecisionResult): string {
  return [
    "Kairon approval decision applied.",
    `approval_id=${result.approval_id}`,
    `action=${result.action}`,
    `status=${result.status}`,
    `applied_events=${result.applied_event_ids.length}`
  ].join("\n");
}

export function sanitizeApprovalForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeApprovalForDisplay(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, raw]) => {
        if (secretKeyPattern.test(key)) {
          return [key, "[redacted]"];
        }

        if (omittedKeyPattern.test(key)) {
          return [key, "[omitted]"];
        }

        return [key, sanitizeApprovalForDisplay(raw)];
      })
    );
  }

  if (typeof value === "string") {
    return sanitizeInline(value);
  }

  return value;
}

function assertApprovalPending(approval: ApprovalRecord): void {
  if (!["pending", "snoozed"].includes(approval.status)) {
    throw new ApprovalNotPendingError(approval.id, approval.status);
  }
}

function assertActionAllowed(approval: ApprovalRecord, action: ApprovalAction): void {
  const actions = approval.actions ?? approval.allowed_actions ?? defaultActions;
  if (!actions.includes(action)) {
    throw new ApprovalActionNotAllowedError(approval.id, action);
  }
}

function compareApprovalRecords(left: ApprovalRecord, right: ApprovalRecord): number {
  return Date.parse(left.created_at ?? "") - Date.parse(right.created_at ?? "");
}

function defaultSnoozeUntil(now: Date): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
}

function sanitizeInline(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= 240 ? collapsed : `${collapsed.slice(0, 237)}...`;
}
