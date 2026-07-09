import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  formatOperationTestSummary,
  summarizeOperationTestResults
} from "../../operation-test/result-summary.js";
import {
  applyOperationTestPassUpdates,
  createOperationTestUpdateSuggestions,
  formatOperationTestUpdateSuggestions
} from "../../operation-test/test-list-matcher.js";
import { toPosixPath } from "../../core/fs/paths.js";

export type SummarizeOperationTestOptions = {
  resultRoot?: string;
  testList?: string;
  suggest?: boolean;
  json?: boolean;
  patchPreview?: boolean;
  applyPass?: boolean;
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
      throw new Error(
        "Specify --test-list when using --suggest, --patch-preview, or --apply-pass."
      );
    }

    const testListPath = path.resolve(projectRoot, options.testList);
    const testListMarkdown = await readFile(testListPath, "utf8");
    const suggestions = createOperationTestUpdateSuggestions({
      projectRoot,
      testListPath,
      testListMarkdown,
      summary,
      patchPreview: options.patchPreview === true || options.applyPass === true
    });

    if (options.applyPass === true) {
      const applyResult = applyOperationTestPassUpdates({
        testListMarkdown,
        suggestions
      });
      const backupPath =
        applyResult.updated > 0
          ? await backupAndWriteTestList(testListPath, applyResult.markdown)
          : undefined;
      const backupDisplay =
        backupPath === undefined ? "(none)" : toDisplayPath(projectRoot, backupPath);

      if (options.json === true) {
        const { markdown: _markdown, ...jsonApplyResult } = applyResult;
        return JSON.stringify(
          {
            ...suggestions,
            apply_result: {
              ...jsonApplyResult,
              backup: backupDisplay
            }
          },
          null,
          2
        );
      }

      return [
        formatOperationTestUpdateSuggestions(suggestions, {
          patchPreview: true
        }),
        formatPassApplyResult(applyResult, backupDisplay)
      ].join("\n");
    }

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
    options.applyPass === true ||
    options.testList !== undefined
  );
}

async function backupAndWriteTestList(
  testListPath: string,
  markdown: string
): Promise<string> {
  const backupPath = `${testListPath}.bak-${formatTimestamp(new Date())}`;
  await copyFile(testListPath, backupPath);
  await writeFile(testListPath, markdown, "utf8");
  return backupPath;
}

function formatPassApplyResult(
  result: ReturnType<typeof applyOperationTestPassUpdates>,
  backup: string
): string {
  return [
    "Kairon operation test PASS updates applied.",
    `apply_pass.updated=${result.updated}`,
    `apply_pass.backup=${backup}`,
    `apply_pass.skipped_already_pass=${result.skipped_already_pass}`,
    `apply_pass.skipped_non_pass=${result.skipped_non_pass}`,
    ...result.applied.map((item) =>
      `apply_pass.applied id=${item.id} line=${item.line}`
    )
  ].join("\n");
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function toDisplayPath(projectRoot: string, filePath: string): string {
  const relative = path.relative(projectRoot, filePath);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? toPosixPath(filePath)
    : toPosixPath(relative);
}
