import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  spawnCommandRunner,
  type CommandRunner
} from "../agents/command-runner.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/fs/json-file.js";
import {
  defaultScheduledHealthProfile,
  getScheduledHealthPaths,
  type ScheduledHealthAlertThreshold,
  type ScheduledHealthProfile
} from "./scheduled-health.js";

export type ScheduledHealthTaskPlan = {
  schema_version: "0.1";
  plan_id: string;
  created_at: string;
  registry_path: string;
  task_name: string;
  kairon_command: string;
  profile: ScheduledHealthProfile;
};

export type ScheduledHealthTaskStatus = {
  schema_version: "0.1";
  status: "registered" | "missing" | "disabled" | "error" | "unknown";
  task_name: string;
  action: "register" | "verify" | "unregister";
  plan_id?: string;
  reason?: string;
  observed_at: string;
};

export type ScheduledHealthTaskOptions = {
  registryPath: string;
  userDataRoot?: string;
  taskName?: string;
  kaironCommand?: string;
  intervalMinutes?: number;
  projectTimeoutMs?: number;
  concurrency?: number;
  retentionDays?: number;
  alertThreshold?: ScheduledHealthAlertThreshold;
  providerPressureThreshold?: number;
  planId?: string;
  confirm?: string;
  commandRunner?: CommandRunner;
  platform?: NodeJS.Platform;
  powerShellCommand?: string;
  helperPath?: string;
  now?: () => Date;
};

export async function createScheduledHealthTaskPlan(
  options: ScheduledHealthTaskOptions
): Promise<{
  plan: ScheduledHealthTaskPlan;
  plan_path: string;
}> {
  const now = options.now?.() ?? new Date();
  const planId =
    options.planId?.trim() ||
    `supervisor-health-${now.toISOString().replace(/\D/gu, "").slice(0, 17)}`;
  validatePlanId(planId);
  const paths = getScheduledHealthPaths(
    options.registryPath,
    options.userDataRoot
  );
  const plan: ScheduledHealthTaskPlan = {
    schema_version: "0.1",
    plan_id: planId,
    created_at: now.toISOString(),
    registry_path: path.resolve(options.registryPath),
    task_name: options.taskName?.trim() || "Kairon Supervisor Health",
    kairon_command: options.kaironCommand?.trim() || "kairon",
    profile: {
      schema_version: "0.1",
      interval_minutes: positiveInteger(
        options.intervalMinutes ?? defaultScheduledHealthProfile.interval_minutes,
        "intervalMinutes"
      ),
      project_timeout_ms: positiveInteger(
        options.projectTimeoutMs ??
          defaultScheduledHealthProfile.project_timeout_ms,
        "projectTimeoutMs"
      ),
      concurrency: positiveInteger(
        options.concurrency ?? defaultScheduledHealthProfile.concurrency,
        "concurrency"
      ),
      retention_days: positiveInteger(
        options.retentionDays ?? defaultScheduledHealthProfile.retention_days,
        "retentionDays"
      ),
      alert_threshold:
        options.alertThreshold ?? defaultScheduledHealthProfile.alert_threshold,
      provider_pressure_threshold: positiveInteger(
        options.providerPressureThreshold ??
          defaultScheduledHealthProfile.provider_pressure_threshold,
        "providerPressureThreshold"
      )
    }
  };
  const planPath = path.join(paths.plansDir, `${planId}.json`);
  await writeJsonFileAtomic(planPath, plan);
  return { plan, plan_path: planPath };
}

export async function runScheduledHealthTaskAction(
  action: "register" | "verify" | "unregister",
  options: ScheduledHealthTaskOptions
): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return [
      "Kairon scheduled health task setup required.",
      "status=setup_required",
      `action=${action}`,
      `platform=${platform}`,
      "reason=windows_task_scheduler_required"
    ].join("\n");
  }

  const paths = getScheduledHealthPaths(
    options.registryPath,
    options.userDataRoot
  );
  const plan =
    action === "verify"
      ? undefined
      : await loadConfirmedPlan(paths.plansDir, options);
  const taskName =
    plan?.task_name ?? options.taskName?.trim() ?? "Kairon Supervisor Health";
  const helperPath =
    options.helperPath ??
    fileURLToPath(
      new URL("../../scripts/kairon-supervisor-health-task.ps1", import.meta.url)
    );
  const helperAction =
    action === "register"
      ? "Register"
      : action === "unregister"
        ? "Unregister"
        : "Verify";
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
    "-Action",
    helperAction,
    "-TaskName",
    taskName
  ];
  if (plan !== undefined) {
    args.push(
      "-RegistryPath",
      plan.registry_path,
      "-KaironCommand",
      plan.kairon_command,
      "-IntervalMinutes",
      String(plan.profile.interval_minutes),
      "-ProjectTimeoutMs",
      String(plan.profile.project_timeout_ms),
      "-Concurrency",
      String(plan.profile.concurrency),
      "-RetentionDays",
      String(plan.profile.retention_days),
      "-AlertThreshold",
      plan.profile.alert_threshold,
      "-ProviderPressureThreshold",
      String(plan.profile.provider_pressure_threshold)
    );
  }

  const result = await (options.commandRunner ?? spawnCommandRunner)({
    command: options.powerShellCommand ?? "powershell.exe",
    args,
    cwd: path.dirname(path.resolve(options.registryPath)),
    timeoutMs: 120_000
  });
  const output = redactOutput(result.stdout || result.stderr).trim();
  if (result.exitCode !== 0 || result.timedOut) {
    const reason = isPermissionError(output)
      ? "task_scheduler_permission_denied"
      : "task_scheduler_command_failed";
    await writeTaskStatus(paths.taskStatusPath, {
      schema_version: "0.1",
      status: "error",
      task_name: taskName,
      action,
      plan_id: plan?.plan_id,
      reason,
      observed_at: (options.now?.() ?? new Date()).toISOString()
    });
    if (reason === "task_scheduler_permission_denied") {
      return [
        "Kairon scheduled health task setup required.",
        "status=setup_required",
        `action=${action}`,
        `reason=${reason}`,
        "guidance=Run Windows PowerShell as Administrator and retry."
      ].join("\n");
    }
    throw new Error(
      `Kairon scheduled health task ${action} failed${output ? `: ${output}` : "."}`
    );
  }

  const status = taskStatus(action, output);
  await writeTaskStatus(paths.taskStatusPath, {
    schema_version: "0.1",
    status,
    task_name: taskName,
    action,
    plan_id: plan?.plan_id,
    observed_at: (options.now?.() ?? new Date()).toISOString()
  });
  return [
    "Kairon scheduled health task command completed.",
    "status=completed",
    `action=${action}`,
    `task_status=${status}`,
    ...(plan === undefined ? [] : [`plan_id=${plan.plan_id}`]),
    ...(output ? output.split(/\r?\n/u) : [])
  ].join("\n");
}

export async function readScheduledHealthTaskStatus(
  registryPath: string,
  userDataRoot?: string
): Promise<ScheduledHealthTaskStatus | undefined> {
  const statusPath = getScheduledHealthPaths(
    registryPath,
    userDataRoot
  ).taskStatusPath;
  try {
    return await readJsonFile<ScheduledHealthTaskStatus>(statusPath);
  } catch (error) {
    if (String(error).includes("ENOENT")) {
      return undefined;
    }
    return undefined;
  }
}

async function loadConfirmedPlan(
  plansDir: string,
  options: ScheduledHealthTaskOptions
): Promise<ScheduledHealthTaskPlan> {
  const planId = options.planId?.trim();
  if (!planId) {
    throw new Error("plan-id is required.");
  }
  validatePlanId(planId);
  if (options.confirm !== planId) {
    throw new Error(`Confirmation mismatch. Expected --confirm ${planId}`);
  }
  const plan = await readJsonFile<ScheduledHealthTaskPlan>(
    path.join(plansDir, `${planId}.json`)
  );
  if (plan.schema_version !== "0.1" || plan.plan_id !== planId) {
    throw new Error(`Invalid scheduled health task plan: ${planId}`);
  }
  return plan;
}

async function writeTaskStatus(
  filePath: string,
  status: ScheduledHealthTaskStatus
): Promise<void> {
  await writeJsonFileAtomic(filePath, status);
}

function taskStatus(
  action: "register" | "verify" | "unregister",
  output: string
): ScheduledHealthTaskStatus["status"] {
  if (action === "unregister" || output.includes("task.exists=false")) {
    return "missing";
  }
  if (/^task\.state=disabled$/imu.test(output)) {
    return "disabled";
  }
  if (action === "register" || output.includes("task.exists=true")) {
    return "registered";
  }
  return "unknown";
}

function validatePlanId(planId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(planId)) {
    throw new Error(`Invalid plan-id: ${planId}`);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function redactOutput(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s"',}]+/giu,
      "$1=[redacted]"
    )
    .replace(/Bearer\s+[^\s"',}]+/giu, "Bearer [redacted]");
}

function isPermissionError(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    "access denied",
    "access is denied",
    "0x80070005",
    "unauthorizedaccessexception",
    "アクセスが拒否"
  ].some((pattern) => normalized.includes(pattern));
}
