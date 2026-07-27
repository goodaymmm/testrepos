import {
  evaluateBetaReadiness,
  formatBetaReadinessReport,
  parseBetaReadinessFormat,
  writeBetaReadinessReport
} from "../../readiness/beta-readiness.js";
import { createReadinessEvidenceManifest } from "../../readiness/evidence-manifest.js";
import {
  createRcReadinessManifest,
  evaluateRcReadiness,
  formatRcReadinessResult,
  parseRcReadinessFormat,
  writeRcReadinessResult
} from "../../readiness/rc-readiness.js";
import {
  createStableReadinessManifest,
  evaluateStableReadiness,
  formatStableReadinessResult,
  parseStableReadinessFormat,
  writeStableReadinessResult
} from "../../readiness/stable-readiness.js";

export type ReadinessManifestCommandOptions = {
  evidence?: string[];
  output?: string;
};

export type ReadinessCheckCommandOptions = {
  manifest?: string;
};

export type ReadinessReportCommandOptions = ReadinessCheckCommandOptions & {
  format?: string;
  output?: string;
};

export type RcReadinessManifestCommandOptions = ReadinessManifestCommandOptions;
export type RcReadinessCheckCommandOptions = ReadinessCheckCommandOptions;
export type RcReadinessReportCommandOptions = ReadinessReportCommandOptions;
export type StableReadinessManifestCommandOptions =
  ReadinessManifestCommandOptions;
export type StableReadinessCheckCommandOptions = ReadinessCheckCommandOptions;
export type StableReadinessReportCommandOptions =
  ReadinessReportCommandOptions;

export async function readinessManifestCommand(
  projectRoot: string,
  options: ReadinessManifestCommandOptions
): Promise<string> {
  const result = await createReadinessEvidenceManifest(projectRoot, {
    evidence: options.evidence ?? [],
    output: options.output
  });
  return [
    "Kairon readiness evidence manifest created.",
    `manifest=${result.output_path}`,
    `source_commit=${result.manifest.source_commit}`,
    `evidence=${result.manifest.evidence.length}`,
    ...result.manifest.evidence.map((entry) =>
      `gate=${entry.gate_id} status=${entry.detected_status} path=${entry.path}`
    )
  ].join("\n");
}

export async function readinessCheckCommand(
  projectRoot: string,
  options: ReadinessCheckCommandOptions = {}
): Promise<{ text: string; ready: boolean }> {
  const report = await evaluateBetaReadiness(projectRoot, options);
  return {
    text: [
      "Kairon beta readiness check.",
      `status=${report.status}`,
      `ready=${report.ready}`,
      `source_commit=${report.source_commit}`,
      `manifest=${report.manifest.path}`,
      `manifest_status=${report.manifest.status}`,
      ...report.gates.map((gate) =>
        `gate=${gate.id} required=${gate.required} status=${gate.status} evidence=${gate.evidence.length}`
      )
    ].join("\n"),
    ready: report.ready
  };
}

export async function readinessReportCommand(
  projectRoot: string,
  options: ReadinessReportCommandOptions = {}
): Promise<{ text: string; ready: boolean }> {
  const format = parseBetaReadinessFormat(options.format);
  const report = await evaluateBetaReadiness(projectRoot, options);
  const outputPath = await writeBetaReadinessReport(
    projectRoot,
    report,
    format,
    options.output
  );
  return {
    text: [
      "Kairon beta readiness report created.",
      `status=${report.status}`,
      `ready=${report.ready}`,
      `format=${format}`,
      `output=${outputPath}`,
      `manifest_status=${report.manifest.status}`,
      `secret_scan=${report.secret_scan.status}`,
      format === "json" ? formatBetaReadinessReport(report, "json").trim() : ""
    ].filter((line) => line.length > 0).join("\n"),
    ready: report.ready
  };
}

export async function rcReadinessManifestCommand(
  projectRoot: string,
  options: RcReadinessManifestCommandOptions
): Promise<string> {
  const result = await createRcReadinessManifest(projectRoot, {
    evidence: options.evidence ?? [],
    output: options.output
  });
  return [
    "Kairon RC readiness evidence manifest created.",
    `manifest=${result.output_path}`,
    `source_commit=${result.manifest.source_commit}`,
    `evidence=${result.manifest.evidence.length}`,
    ...result.manifest.evidence.map((entry) =>
      `gate=${entry.gate_id} status=${entry.detected_status} path=${entry.path}`
    )
  ].join("\n");
}

export async function rcReadinessCheckCommand(
  projectRoot: string,
  options: RcReadinessCheckCommandOptions = {}
): Promise<{ text: string; ready: boolean }> {
  const result = await evaluateRcReadiness(projectRoot, options);
  const outputPath = await writeRcReadinessResult(
    projectRoot,
    result,
    "json"
  );
  return {
    text: [
      "Kairon RC readiness check.",
      `status=${result.status}`,
      `rc_ready=${result.rc_ready}`,
      `source_commit=${result.source_commit}`,
      `manifest=${result.manifest.path}`,
      `manifest_status=${result.manifest.status}`,
      `result=${outputPath}`,
      `blockers=${result.blockers.length}`,
      ...result.gates.map((gate) =>
        `gate=${gate.id} class=${gate.classification} status=${gate.status} evidence=${gate.evidence.length}`
      )
    ].join("\n"),
    ready: result.rc_ready
  };
}

export async function rcReadinessReportCommand(
  projectRoot: string,
  options: RcReadinessReportCommandOptions = {}
): Promise<{ text: string; ready: boolean }> {
  const format = parseRcReadinessFormat(options.format);
  const result = await evaluateRcReadiness(projectRoot, options);
  const outputPath = await writeRcReadinessResult(
    projectRoot,
    result,
    format,
    options.output
  );
  return {
    text: [
      "Kairon RC readiness report created.",
      `status=${result.status}`,
      `rc_ready=${result.rc_ready}`,
      `format=${format}`,
      `output=${outputPath}`,
      `manifest_status=${result.manifest.status}`,
      `blockers=${result.blockers.length}`,
      `secret_scan=${result.secret_scan.status}`,
      format === "json"
        ? formatRcReadinessResult(result, "json").trim()
        : ""
    ].filter((line) => line.length > 0).join("\n"),
    ready: result.rc_ready
  };
}

export async function stableReadinessManifestCommand(
  projectRoot: string,
  options: StableReadinessManifestCommandOptions
): Promise<string> {
  const result = await createStableReadinessManifest(projectRoot, {
    evidence: options.evidence ?? [],
    output: options.output
  });
  return [
    "Kairon Stable readiness evidence manifest created.",
    `manifest=${result.output_path}`,
    `source_commit=${result.manifest.source_commit}`,
    `evidence=${result.manifest.evidence.length}`,
    ...result.manifest.evidence.map((entry) =>
      `gate=${entry.gate_id} status=${entry.detected_status} path=${entry.path}`
    )
  ].join("\n");
}

export async function stableReadinessCheckCommand(
  projectRoot: string,
  options: StableReadinessCheckCommandOptions = {}
): Promise<{ text: string; ready: boolean }> {
  const result = await evaluateStableReadiness(projectRoot, options);
  const outputPath = await writeStableReadinessResult(
    projectRoot,
    result,
    "json"
  );
  return {
    text: [
      "Kairon Stable Local Release readiness check.",
      `status=${result.status}`,
      `stable_ready=${result.stable_ready}`,
      `source_commit=${result.source_commit}`,
      `manifest=${result.manifest.path}`,
      `manifest_status=${result.manifest.status}`,
      `result=${outputPath}`,
      `blockers=${result.blockers.length}`,
      `cleanup_status=${result.cleanup.status}`,
      `security_high=${result.security.high}`,
      `security_critical=${result.security.critical}`,
      `secret_exposures=${result.security.secret_exposures}`,
      "promotion_automatic=false",
      ...result.gates.map((gate) =>
        `gate=${gate.id} class=${gate.classification} status=${gate.status} evidence=${gate.evidence.length}`
      )
    ].join("\n"),
    ready: result.stable_ready
  };
}

export async function stableReadinessReportCommand(
  projectRoot: string,
  options: StableReadinessReportCommandOptions = {}
): Promise<{ text: string; ready: boolean }> {
  const format = parseStableReadinessFormat(options.format);
  const result = await evaluateStableReadiness(projectRoot, options);
  const outputPath = await writeStableReadinessResult(
    projectRoot,
    result,
    format,
    options.output
  );
  return {
    text: [
      "Kairon Stable Local Release readiness report created.",
      `status=${result.status}`,
      `stable_ready=${result.stable_ready}`,
      `format=${format}`,
      `output=${outputPath}`,
      `manifest_status=${result.manifest.status}`,
      `blockers=${result.blockers.length}`,
      `cleanup_status=${result.cleanup.status}`,
      `secret_scan=${result.secret_scan.status}`,
      "promotion_automatic=false",
      format === "json"
        ? formatStableReadinessResult(result, "json").trim()
        : ""
    ].filter((line) => line.length > 0).join("\n"),
    ready: result.stable_ready
  };
}
