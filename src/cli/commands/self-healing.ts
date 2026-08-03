import {
  executeSelfHealingRunbook,
  formatSelfHealingInspection,
  formatSelfHealingRun,
  inspectSelfHealingRunbook,
  listSelfHealingRuns,
  planSelfHealingRunbook,
  runBoundedSelfHealingTick
} from "../../recovery/runbook.js";

export async function inspectSelfHealingCommand(
  projectRoot: string,
  runbookId: string,
  options: { target?: string } = {}
): Promise<string> {
  return formatSelfHealingInspection(
    await inspectSelfHealingRunbook(projectRoot, runbookId, {
      targetId: options.target
    })
  );
}

export async function planSelfHealingCommand(
  projectRoot: string,
  runbookId: string,
  options: { target?: string } = {}
): Promise<string> {
  return formatSelfHealingRun(
    await planSelfHealingRunbook(projectRoot, runbookId, {
      targetId: options.target
    })
  );
}

export async function executeSelfHealingCommand(
  projectRoot: string,
  runId: string,
  options: { confirm?: string; approvalId?: string }
): Promise<string> {
  if (options.confirm === undefined) {
    throw new Error("Self-healing run requires --confirm <run-id>.");
  }
  return formatSelfHealingRun(
    await executeSelfHealingRunbook(projectRoot, runId, {
      confirm: options.confirm,
      approvalId: options.approvalId
    })
  );
}

export async function listSelfHealingCommand(
  projectRoot: string
): Promise<string> {
  const runs = await listSelfHealingRuns(projectRoot);
  if (runs.length === 0) {
    return "No Kairon self-healing runs found.";
  }
  return [
    "Kairon self-healing runs:",
    ...runs.map(
      (run) =>
        `run_id=${run.run_id} runbook_id=${run.runbook_id} incident_id=${run.incident_id} status=${run.status} attempts=${run.attempts.length}`
    )
  ].join("\n");
}

export async function tickSelfHealingCommand(
  projectRoot: string
): Promise<string> {
  const result = await runBoundedSelfHealingTick(projectRoot);
  return [
    "Kairon bounded self-healing tick completed.",
    `status=${result.status}`,
    `run_id=${result.run_id ?? "none"}`,
    `runbook_id=${result.runbook_id ?? "none"}`,
    `reason=${result.reason ?? "none"}`
  ].join("\n");
}
