import { getConfigPath } from "../fs/paths.js";
import { readJsonFile } from "../fs/json-file.js";
import {
  combineValidationResults,
  validateConfigFile,
  type ValidationResult
} from "./validate-config.js";

export const configFileNames = [
  "project.json",
  "runtime.json",
  "schedule.json",
  "agents.json",
  "dispatch.json",
  "policies.json",
  "notifications.json",
  "rag.json"
] as const;

export type ConfigFileName = (typeof configFileNames)[number];
export type LoadedConfigs = Record<ConfigFileName, unknown>;

export async function loadConfigFile<T>(
  projectRoot: string,
  fileName: ConfigFileName
): Promise<T> {
  return readJsonFile<T>(getConfigPath(projectRoot, fileName));
}

export async function loadAllConfigs(projectRoot: string): Promise<LoadedConfigs> {
  const entries = await Promise.all(
    configFileNames.map(async (fileName) => [
      fileName,
      await loadConfigFile(projectRoot, fileName)
    ])
  );

  return Object.fromEntries(entries) as LoadedConfigs;
}

export async function validateAllConfigs(
  projectRoot: string
): Promise<ValidationResult> {
  const configs = await loadAllConfigs(projectRoot);
  return combineValidationResults(
    configFileNames.map((fileName) => validateConfigFile(fileName, configs[fileName]))
  );
}
