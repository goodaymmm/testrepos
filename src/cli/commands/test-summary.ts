import {
  formatOperationTestSummary,
  summarizeOperationTestResults
} from "../../operation-test/result-summary.js";

export type SummarizeOperationTestOptions = {
  resultRoot?: string;
};

export async function summarizeOperationTestsCommand(
  projectRoot: string,
  logFile: string | undefined,
  options: SummarizeOperationTestOptions = {}
): Promise<string> {
  const summary = await summarizeOperationTestResults({
    projectRoot,
    logFile,
    resultRoot: options.resultRoot
  });

  return formatOperationTestSummary(summary);
}
