import {
  formatDiagnosticsTriage,
  generateDiagnosticsTriage,
  parseDiagnosticsTriageFormat,
  writeDiagnosticsTriage,
  type DiagnosticsTriageDependencies
} from "../../diagnostics/triage.js";

export type DiagnosticsTriageCommandOptions = {
  format?: string;
  output?: string;
};

export async function diagnosticsTriageCommand(
  projectRoot: string,
  options: DiagnosticsTriageCommandOptions = {},
  dependencies: DiagnosticsTriageDependencies = {}
): Promise<string> {
  const format = parseDiagnosticsTriageFormat(options.format);
  const report = await generateDiagnosticsTriage(projectRoot, dependencies);
  const written =
    options.output === undefined
      ? undefined
      : await writeDiagnosticsTriage(report, options.output);
  const output = formatDiagnosticsTriage(report, format);
  if (written === undefined || format !== "text") {
    return output;
  }
  return [
    output.trimEnd(),
    `json_output=${written.json_path}`,
    `markdown_output=${written.markdown_path}`,
    ""
  ].join("\n");
}
