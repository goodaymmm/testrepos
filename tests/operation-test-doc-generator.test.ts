import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateOperationTestDocsCommand } from "../src/cli/commands/test-commands.js";
import {
  buildOperationTestDocs,
  writeOperationTestDocs
} from "../src/operation-test/test-doc-generator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("operation test document generator", () => {
  it("builds operation test list and command documents from a task range", () => {
    const result = buildOperationTestDocs("/repo", {
      range: "T130-T131"
    });

    expect(result.range).toBe("T130-T131");
    expect(result.name_prefix).toBe("t130-t131");
    expect(result.files.map((file) => file.path)).toEqual([
      "docs/t130-t131-operation-test-list-v0.md",
      "docs/t130-t131-operation-test-commands-v0.md"
    ]);

    const testList = result.files.find((file) => file.kind === "test_list")?.content ?? "";
    const commands = result.files.find((file) => file.kind === "command_list")?.content ?? "";

    expect(testList).toContain("# T130-T131 操作テストリスト v0");
    expect(testList).toContain("Push / commit 対象外");
    expect(testList).toContain("| OT-T130-01 | T130 | Operation Test PASS-only Safe Apply | NOT_RUN | pending |");
    expect(testList).toContain("| OT-T131-01-05 | Secret safety |");
    expect(testList).toContain("OT-T130T131-FINAL-03");
    expect(commands).toContain("# T130-T131 操作テスト実行コマンド v0");
    expect(commands).toContain("$KAIRON = \"C:\\Users\\hikar\\Documents\\AutoRunner\"");
    expect(commands).toContain("function Save-ManualEvidence");
    expect(commands).toContain("kairon test summarize `");
    expect(commands).not.toContain("node -e");
    expect(commands).not.toContain("Bearer ");
    expect(commands).not.toContain("SHOULD_NOT_LEAK");
  });

  it("writes generated docs and refuses accidental overwrite", async () => {
    const root = await makeTemporaryProject();
    const first = await writeOperationTestDocs(root, {
      range: "T131",
      namePrefix: "manual-t131"
    });

    expect(first.files.every((file) => file.written)).toBe(true);
    expect(first.files.every((file) => file.overwritten === false)).toBe(true);

    const listPath = path.join(root, "docs", "manual-t131-operation-test-list-v0.md");
    await expect(readFile(listPath, "utf8")).resolves.toContain("# T131 操作テストリスト v0");
    await expect(
      writeOperationTestDocs(root, {
        range: "T131",
        namePrefix: "manual-t131"
      })
    ).rejects.toThrow("Pass --overwrite to replace it");

    const overwritten = await writeOperationTestDocs(root, {
      range: "T131",
      namePrefix: "manual-t131",
      overwrite: true
    });
    expect(overwritten.files.every((file) => file.overwritten)).toBe(true);
  });

  it("supports dry-run without writing files", async () => {
    const root = await makeTemporaryProject();
    const output = await generateOperationTestDocsCommand(root, {
      range: "T132-T133",
      dryRun: true
    });

    expect(output).toContain("Kairon operation test docs generated.");
    expect(output).toContain("range=T132-T133");
    expect(output).toContain("dry_run=true");
    expect(output).toContain("test_list.written=false");
    await expect(
      readFile(path.join(root, "docs", "t132-t133-operation-test-list-v0.md"), "utf8")
    ).rejects.toThrow();
  });

  it("rejects unsafe paths and invalid prefixes", async () => {
    expect(() =>
      buildOperationTestDocs("/repo", {
        range: "T131",
        namePrefix: "../bad"
      })
    ).toThrow("Invalid --name-prefix");

    expect(() =>
      buildOperationTestDocs("/repo", {
        range: "T131",
        outputDir: "../outside"
      })
    ).toThrow("Path must stay inside the project root");
  });
});

async function makeTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kairon-doc-generator-"));
  temporaryDirectories.push(directory);
  return directory;
}
