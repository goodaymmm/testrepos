import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CliInvocation,
  CommandRunResult
} from "../src/agents/command-runner.js";
import { writeJsonFileAtomic } from "../src/core/fs/json-file.js";
import {
  collectReleaseCheck,
  createReleaseNotesDraft,
  formatReleaseBump,
  formatReleaseCheck,
  formatReleaseNotes,
  formatReleaseValidation,
  planReleaseBump,
  releasePatchPlanCommand,
  validateRelease
} from "../src/cli/commands/release.js";
import { createTempProject } from "./test-utils.js";

describe("release commands", () => {
  it("reports release readiness inputs without mutating files", async () => {
    const root = await createReleaseProject("0.1.0");

    const result = await collectReleaseCheck(root);

    expect(result).toMatchObject({
      package_version: "0.1.0",
      cli_version: "0.1.0",
      version_sync: true,
      docs: {
        release_checklist: true,
        release_notes: true
      }
    });
    expect(result.recommended_commands).toContain("npm run build");
    expect(result.recommended_commands).toContain("kairon release validate");
    expect(result.recommended_commands).toContain("kairon readiness check");
    expect(formatReleaseCheck(result)).toContain("version.sync=true");
  });

  it("validates synchronized semantic versions and release documentation", async () => {
    const root = await createReleaseProject("0.1.0");

    const result = await validateRelease(root);

    expect(result).toMatchObject({
      ok: true,
      target_version: "0.1.0",
      package_version: "0.1.0",
      cli_version: "0.1.0"
    });
    expect(result.checks).toHaveLength(7);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    expect(formatReleaseValidation(result)).toContain("validation.ok=true");
    expect(formatReleaseValidation(result)).toContain("summary.fail=0");
  });

  it("validates the current source release contract", async () => {
    const currentVersion = await readPackageVersion(path.resolve("."));
    const result = await validateRelease(path.resolve("."));

    expect(result).toMatchObject({
      ok: true,
      target_version: currentVersion,
      package_version: currentVersion,
      cli_version: currentVersion
    });
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("reports version and release documentation validation failures together", async () => {
    const root = await createReleaseProject("01.0.0", "0.2.0");
    await writeFile(path.join(root, "docs", "release-checklist-v0.md"), "# Checklist\n", "utf8");
    await writeFile(path.join(root, "docs", "release-notes-v0.md"), "# Notes\n", "utf8");

    const result = await validateRelease(root);

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "package_version_semver", status: "fail" }),
        expect.objectContaining({ id: "version_sync", status: "fail" }),
        expect.objectContaining({ id: "release_checklist", status: "fail" }),
        expect.objectContaining({ id: "release_notes_unreleased", status: "fail" }),
        expect.objectContaining({ id: "release_notes_target_version", status: "fail" })
      ])
    );
    expect(formatReleaseValidation(result)).toContain("validation.ok=false");
  });

  it("plans a dry-run patch version bump by default", async () => {
    const root = await createReleaseProject("0.1.0");

    const result = await planReleaseBump(root, { type: "patch" });

    expect(result).toMatchObject({
      type: "patch",
      current_version: "0.1.0",
      next_version: "0.1.1",
      dry_run: true,
      write: false,
      files: [
        {
          path: "package.json",
          current: "0.1.0",
          next: "0.1.1",
          action: "would_update"
        },
        {
          path: "src/index.ts",
          current: "0.1.0",
          next: "0.1.1",
          action: "would_update"
        }
      ]
    });
    expect(formatReleaseBump(result)).toContain("Kairon release bump dry run.");
    await expect(readPackageVersion(root)).resolves.toBe("0.1.0");
    await expect(readFile(path.join(root, "src", "index.ts"), "utf8")).resolves.toContain(
      'KAIRON_VERSION = "0.1.0"'
    );
  });

  it("exposes an expiring patch plan through the release command boundary", async () => {
    const root = await createReleaseProject("0.1.0");
    const output = await releasePatchPlanCommand(root, {
      version: "0.1.1",
      commandRunner: async (invocation) =>
        invocation.args[0] === "rev-parse"
          ? commandResult(invocation, { stdout: `${"a".repeat(40)}\n` })
          : commandResult(invocation),
      now: () => new Date("2026-07-30T00:00:00.000Z")
    });

    expect(output).toContain("Kairon patch release plan created.");
    expect(output).toContain("base_version=0.1.0");
    expect(output).toContain("target_version=0.1.1");
    expect(output).toContain("external_publish_performed=false");
    expect(output).toContain("next_command=kairon release patch prepare");
  });

  it("plans an explicit dry-run version bump without mutating files", async () => {
    const root = await createReleaseProject("0.1.0");

    const result = await planReleaseBump(root, { version: "0.2.0" });

    expect(result).toMatchObject({
      type: "explicit",
      current_version: "0.1.0",
      next_version: "0.2.0",
      dry_run: true,
      write: false,
      files: [
        {
          path: "package.json",
          action: "would_update"
        },
        {
          path: "src/index.ts",
          action: "would_update"
        }
      ]
    });
    expect(formatReleaseBump(result)).toContain("diff.preview:");
    await expect(readPackageVersion(root)).resolves.toBe("0.1.0");
  });

  it("applies a version bump only when write is explicit", async () => {
    const root = await createReleaseProject("0.1.0");

    const result = await planReleaseBump(root, {
      type: "minor",
      write: true,
      commandRunner: cleanGitStatusRunner,
      now: () => new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      type: "minor",
      current_version: "0.1.0",
      next_version: "0.2.0",
      dry_run: false,
      write: true,
      files: [
        {
          path: "package.json",
          action: "updated"
        },
        {
          path: "src/index.ts",
          action: "updated"
        }
      ]
    });
    expect(result.backup_artifact).toBe(
      ".kairon/release/backups/2026-07-01T00-00-00-000Z"
    );
    await expect(readPackageVersion(root)).resolves.toBe("0.2.0");
    await expect(readFile(path.join(root, "src", "index.ts"), "utf8")).resolves.toContain(
      'KAIRON_VERSION = "0.2.0"'
    );
    await expect(
      readFile(
        path.join(root, result.backup_artifact ?? "", "package.json"),
        "utf8"
      )
    ).resolves.toContain('"version": "0.1.0"');
  });

  it("keeps package-lock.json synchronized when applying a version bump", async () => {
    const root = await createReleaseProject("0.1.0");
    await writeJsonFileAtomic(path.join(root, "package-lock.json"), {
      name: "kairon-test",
      version: "0.1.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "kairon-test",
          version: "0.1.0"
        }
      }
    });

    const result = await planReleaseBump(root, {
      version: "0.2.0",
      write: true,
      commandRunner: cleanGitStatusRunner
    });
    const packageLock = JSON.parse(
      await readFile(path.join(root, "package-lock.json"), "utf8")
    ) as { version: string; packages: { "": { version: string } } };

    expect(result.files).toContainEqual({
      path: "package-lock.json",
      current: "0.1.0",
      next: "0.2.0",
      action: "updated"
    });
    expect(packageLock.version).toBe("0.2.0");
    expect(packageLock.packages[""].version).toBe("0.2.0");
  });

  it("rejects release writes when tracked files are dirty", async () => {
    const root = await createReleaseProject("0.1.0");

    await expect(
      planReleaseBump(root, {
        version: "0.2.0",
        write: true,
        commandRunner: async (invocation) =>
          commandResult(invocation, {
            stdout: " M package.json\n"
          })
      })
    ).rejects.toThrow("clean tracked worktree");
  });

  it("drafts release notes from git commit summaries", async () => {
    const root = await createReleaseProject("0.1.0");
    const invocations: CliInvocation[] = [];

    const result = await createReleaseNotesDraft(root, {
      since: "v0.1.0",
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return commandResult(invocation, {
          stdout: "feat: add release helper\nfix: stabilize release docs\n"
        });
      }
    });

    expect(result).toMatchObject({
      since: "v0.1.0",
      commit_count: 2,
      commits: [
        "feat: add release helper",
        "fix: stabilize release docs"
      ]
    });
    expect(invocations[0]?.args).toEqual([
      "log",
      "--no-merges",
      "--pretty=format:%s",
      "v0.1.0..HEAD"
    ]);
    const formatted = formatReleaseNotes(result);
    expect(formatted).toContain("## Release Notes Draft");
    expect(formatted).toContain("- feat: add release helper");
    expect(formatted).toContain("- `npm test`");
  });

  it("appends release notes under the Unreleased marker only when write is explicit", async () => {
    const root = await createReleaseProject("0.1.0");

    const result = await createReleaseNotesDraft(root, {
      since: "v0.1.0",
      write: true,
      now: () => new Date("2026-07-01T00:00:00.000Z"),
      commandRunner: async (invocation) => {
        if (invocation.args[0] === "status") {
          return commandResult(invocation);
        }
        return commandResult(invocation, {
          stdout: "feat: add release helper\nfix: token=SHOULD_NOT_LEAK\n"
        });
      }
    });

    expect(result).toMatchObject({
      write: true,
      dry_run: false,
      action: "appended",
      backup_artifact: ".kairon/release/backups/2026-07-01T00-00-00-000Z"
    });
    expect(result.commits).toEqual([
      "feat: add release helper",
      "fix: token=[redacted]"
    ]);
    const notes = await readFile(path.join(root, "docs", "release-notes-v0.md"), "utf8");
    expect(notes.indexOf("<!-- kairon:release-notes-unreleased -->")).toBeLessThan(
      notes.indexOf("### Release Notes Draft 2026-07-01T00:00:00.000Z")
    );
    expect(notes).toContain("- feat: add release helper");
    expect(notes).toContain("- fix: token=[redacted]");
    expect(notes).not.toContain("SHOULD_NOT_LEAK");
  });

  it("rejects inconsistent package and CLI versions before bumping", async () => {
    const root = await createReleaseProject("0.1.0", "0.2.0");

    await expect(planReleaseBump(root, { type: "patch" })).rejects.toThrow(
      "Version mismatch"
    );
  });

  it("rejects non-core semantic versions before planning a bump", async () => {
    const root = await createReleaseProject("0.1.0");

    await expect(planReleaseBump(root, { version: "01.2.3" })).rejects.toThrow(
      "unsupported version format"
    );
  });
});

async function createReleaseProject(
  packageVersion: string,
  cliVersion = packageVersion
): Promise<string> {
  const root = await createTempProject();
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeJsonFileAtomic(path.join(root, "package.json"), {
    name: "kairon-test",
    version: packageVersion,
    private: true
  });
  await writeFile(
    path.join(root, "src", "index.ts"),
    `export const KAIRON_VERSION = "${cliVersion}";\n`,
    "utf8"
  );
  await writeFile(
    path.join(root, "docs", "release-checklist-v0.md"),
    [
      "# Checklist",
      "",
      "<!-- kairon:release-readiness -->",
      "<!-- kairon:release-evidence -->",
      "<!-- kairon:versioning-policy -->",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "docs", "release-notes-v0.md"),
    [
      "# Notes",
      "",
      "## Unreleased",
      "",
      "<!-- kairon:release-notes-unreleased -->",
      "Existing notes.",
      "",
      `## ${packageVersion} - baseline`,
      ""
    ].join("\n"),
    "utf8"
  );
  return root;
}

async function readPackageVersion(root: string): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8")
  ) as { version: string };
  return packageJson.version;
}

function commandResult(
  invocation: CliInvocation,
  options: Partial<CommandRunResult> = {}
): CommandRunResult {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    pid: 1234,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:00:01.000Z",
    timedOut: false,
    ...options
  };
}

const cleanGitStatusRunner = async (
  invocation: CliInvocation
): Promise<CommandRunResult> => commandResult(invocation);
