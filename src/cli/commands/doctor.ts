import { formatDoctorResult, runDoctor } from "../../diagnostics/doctor.js";

export async function runDoctorCommand(projectRoot: string): Promise<string> {
  const result = await runDoctor({ projectRoot });
  return formatDoctorResult(result);
}
