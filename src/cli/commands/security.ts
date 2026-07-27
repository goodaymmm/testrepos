import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { resolveInside, toPosixPath } from "../../core/fs/paths.js";
import {
  formatSecurityBaselineReport,
  runSecurityBaseline,
  type SecurityBaselineArtifact
} from "../../security/baseline.js";

export type SecurityCheckCommandOptions = {
  npmAudit?: string;
  artifact?: string[];
  output?: string;
  sourceCommit?: string;
};

export type SecurityReportCommandOptions = {
  output?: string;
};

export async function securityCheckCommand(
  projectRoot: string,
  options: SecurityCheckCommandOptions = {}
): Promise<{ text: string; passed: boolean }> {
  const result = await runSecurityBaseline(projectRoot, {
    npmAuditPath: options.npmAudit,
    artifactPaths: options.artifact,
    output: options.output,
    sourceCommit: options.sourceCommit
  });
  return {
    text: [
      "Kairon stable security baseline completed.",
      `status=${result.artifact.status}`,
      `offline_status=${result.artifact.offline_status}`,
      `source_commit=${result.artifact.source_commit}`,
      `checks=${result.artifact.summary.total}`,
      `high=${result.artifact.summary.high}`,
      `critical=${result.artifact.summary.critical}`,
      `secret_exposures=${result.artifact.summary.secret_exposures}`,
      `npm_audit=${result.artifact.dependency.external_audit.status}`,
      `output=${result.output_path}`
    ].join("\n"),
    passed: result.artifact.status === "PASS"
  };
}

export async function securityReportCommand(
  projectRoot: string,
  artifactPath: string,
  options: SecurityReportCommandOptions = {}
): Promise<string> {
  const absoluteArtifact = resolveInside(projectRoot, artifactPath);
  const artifact = parseSecurityArtifact(
    await readFile(absoluteArtifact, "utf8")
  );
  const output = resolveInside(
    projectRoot,
    options.output ??
      `.kairon/security/${path.basename(
        artifactPath,
        path.extname(artifactPath)
      )}.md`
  );
  await writeTextFileAtomic(output, formatSecurityBaselineReport(artifact));
  return [
    "Kairon stable security report created.",
    `status=${artifact.status}`,
    `artifact=${toPosixPath(path.relative(projectRoot, absoluteArtifact))}`,
    `output=${toPosixPath(path.relative(projectRoot, output))}`
  ].join("\n");
}

async function writeTextFileAtomic(
  output: string,
  content: string
): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function parseSecurityArtifact(text: string): SecurityBaselineArtifact {
  const parsed = JSON.parse(text) as Partial<SecurityBaselineArtifact>;
  if (
    parsed.schema_version !== "0.1" ||
    parsed.artifact_kind !== "security_baseline_result" ||
    !["PASS", "UNPASSED", "SETUP_REQUIRED"].includes(
      String(parsed.status)
    ) ||
    !Array.isArray(parsed.checks) ||
    !Array.isArray(parsed.findings)
  ) {
    throw new Error("Security baseline artifact schema is invalid.");
  }
  return parsed as SecurityBaselineArtifact;
}
