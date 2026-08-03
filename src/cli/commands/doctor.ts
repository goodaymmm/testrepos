import { formatDoctorResult, runDoctor } from "../../diagnostics/doctor.js";

export type DoctorCommandOptions = {
  format?: string;
};

export async function runDoctorCommand(
  projectRoot: string,
  options: DoctorCommandOptions = {}
): Promise<string> {
  const format = parseDoctorOutputFormat(options.format);
  const result = await runDoctor({ projectRoot });
  return formatDoctorResult(result, { format });
}

function parseDoctorOutputFormat(value: string | undefined): "text" | "json" {
  if (value === undefined || value === "text") {
    return "text";
  }
  if (value === "json") {
    return "json";
  }

  throw new Error(`Invalid doctor output format: ${value}`);
}
