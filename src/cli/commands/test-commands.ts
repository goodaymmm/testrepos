import {
  formatOperationTestCommandProfiles,
  resolveOperationTestCommandProfiles
} from "../../operation-test/command-profiles.js";

export type GenerateOperationTestCommandsOptions = {
  profile?: string[];
  range?: string;
  format?: string;
};

export function generateOperationTestCommandsCommand(
  options: GenerateOperationTestCommandsOptions = {}
): string {
  const format = normalizeFormat(options.format);
  const resolution = resolveOperationTestCommandProfiles({
    profiles: options.profile,
    range: options.range,
    format
  });

  return formatOperationTestCommandProfiles(resolution, format);
}

function normalizeFormat(value: string | undefined): "powershell" | "json" {
  if (value === undefined || value.trim().length === 0) {
    return "powershell";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "powershell" || normalized === "json") {
    return normalized;
  }

  throw new Error(`Invalid --format: ${value}. Expected powershell or json.`);
}
