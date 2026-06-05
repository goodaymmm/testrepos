import {
  formatRuntimeRecoveryResult,
  runRuntimeRecovery
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

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
