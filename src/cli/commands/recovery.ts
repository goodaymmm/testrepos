import {
  formatRuntimeRecoveryResult,
  listRuntimeRecoveryTargets,
  runRuntimeRecovery,
  resolveRuntimeRecoveryTarget,
  showRuntimeRecoveryTarget,
  type RuntimeRecoveryResolutionAction
} from "../../recovery/runtime-recovery.js";

export async function runRecovery(
  projectRoot: string,
  options: {
    claimTimeoutMs?: string;
    runnerStaleMs?: string;
    heartbeatStaleMs?: string;
  } = {}
): Promise<string> {
  const result = await runRuntimeRecovery(projectRoot, {
    claimTimeoutMs: parseOptionalNumber(options.claimTimeoutMs),
    runnerStaleMs: parseOptionalNumber(options.runnerStaleMs),
    heartbeatStaleMs: parseOptionalNumber(options.heartbeatStaleMs)
  });

  return formatRuntimeRecoveryResult(result);
}

export async function listRecoveryTargets(projectRoot: string): Promise<string> {
  const targets = await listRuntimeRecoveryTargets(projectRoot);
  if (targets.length === 0) {
    return "No Kairon recovery targets found.";
  }

  return [
    "Kairon recovery targets:",
    ...targets.map((target) =>
      [
        `target_id=${target.target_id}`,
        `kind=${target.kind}`,
        `target_type=${target.target_type}`,
        `severity=${target.severity}`,
        `fingerprint=${target.fingerprint}`
      ].join(" ")
    )
  ].join("\n");
}

export async function showRecoveryTarget(
  projectRoot: string,
  targetIdOrFingerprint: string
): Promise<string> {
  const target = await showRuntimeRecoveryTarget(projectRoot, targetIdOrFingerprint);

  return [
    "Kairon recovery target:",
    `target_id=${target.target_id}`,
    `kind=${target.kind}`,
    `target_type=${target.target_type}`,
    `severity=${target.severity}`,
    `fingerprint=${target.fingerprint}`,
    `detail=${JSON.stringify(target, null, 2)}`
  ].join("\n");
}

export async function resolveRecoveryTarget(
  projectRoot: string,
  targetIdOrFingerprint: string,
  options: { reason?: string }
): Promise<string> {
  return writeRecoveryResolution(projectRoot, targetIdOrFingerprint, "resolved", options);
}

export async function acknowledgeRecoveryTarget(
  projectRoot: string,
  targetIdOrFingerprint: string,
  options: { reason?: string }
): Promise<string> {
  return writeRecoveryResolution(projectRoot, targetIdOrFingerprint, "acknowledged", options);
}

async function writeRecoveryResolution(
  projectRoot: string,
  targetIdOrFingerprint: string,
  action: RuntimeRecoveryResolutionAction,
  options: { reason?: string }
): Promise<string> {
  const result = await resolveRuntimeRecoveryTarget(projectRoot, targetIdOrFingerprint, {
    action,
    reason: options.reason ?? ""
  });
  const verb = action === "resolved" ? "resolved" : "acknowledged";

  return [
    `Kairon recovery target ${verb}.`,
    `target_id=${result.target.target_id}`,
    `kind=${result.target.kind}`,
    `fingerprint=${result.target.fingerprint}`,
    `action=${result.resolution.action}`,
    `resolution=${result.resolution_path}`
  ].join("\n");
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
