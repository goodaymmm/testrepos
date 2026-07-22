import {
  createSupportBundle,
  formatSupportBundle,
  formatSupportVerification,
  planSupportBundle,
  verifySupportBundle,
  type SupportBundleDependencies
} from "../../diagnostics/support-bundle.js";

export type SupportBundleCommandOptions = {
  dryRun?: boolean;
  output?: string;
};

export async function supportBundleCommand(
  projectRoot: string,
  options: SupportBundleCommandOptions = {},
  dependencies: SupportBundleDependencies = {}
): Promise<string> {
  const result = options.dryRun === true
    ? await planSupportBundle(projectRoot, { outputDirectory: options.output }, dependencies)
    : await createSupportBundle(projectRoot, { outputDirectory: options.output }, dependencies);
  return formatSupportBundle(result);
}

export async function supportVerifyCommand(bundlePath: string): Promise<string> {
  const result = await verifySupportBundle(bundlePath);
  if (!result.ok) {
    throw new Error(formatSupportVerification(result));
  }
  return formatSupportVerification(result);
}
