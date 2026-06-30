import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  formatOperationTestSummary,
  summarizeOperationTestResults
} from "../../operation-test/result-summary.js";
import {
  createOperationTestUpdateSuggestions,
  formatOperationTestUpdateSuggestions
} from "../../operation-test/test-list-matcher.js";

export type SummarizeOperationTestOptions = {
  resultRoot?: string;
  testList?: string;
  suggest?: boolean;
  json?: boolean;
  patchPreview?: boolean;
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

  if (shouldSuggestUpdates(options)) {
    if (options.testList === undefined) {
      throw new Error("Specify --test-list when using --suggest or --patch-preview.");
    }

    const testListPath = path.resolve(projectRoot, options.testList);
    const testListMarkdown = await readFile(testListPath, "utf8");
    const suggestions = createOperationTestUpdateSuggestions({
      projectRoot,
      testListPath,
      testListMarkdown,
      summary,
      patchPreview: options.patchPreview
    });

    return options.json === true
      ? JSON.stringify(suggestions, null, 2)
      : formatOperationTestUpdateSuggestions(suggestions, {
          patchPreview: options.patchPreview
        });
  }

  if (options.json === true) {
    return JSON.stringify(summary, null, 2);
  }

  return formatOperationTestSummary(summary);
}

function shouldSuggestUpdates(options: SummarizeOperationTestOptions): boolean {
  return (
    options.suggest === true ||
    options.patchPreview === true ||
    options.testList !== undefined
  );
}
