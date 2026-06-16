import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("PR and release documentation", () => {
  it("exposes stable machine-readable anchors for PR template checks", async () => {
    const template = await readUtf8(".github/pull_request_template.md");

    expect(template).toContain("<!-- kairon:purpose -->");
    expect(template).toContain("<!-- kairon:changes -->");
    expect(template).toContain("<!-- kairon:tests -->");
    expect(template).toContain("<!-- kairon:manual-operation-test -->");
    expect(template).toContain("<!-- kairon:readme-update -->");
    expect(template).toContain("<!-- kairon:evidence -->");
    expect(template).toContain("<!-- kairon:follow-up -->");
  });

  it("exposes stable anchors for manual result and generated artifact policy checks", async () => {
    const manualResults = await readUtf8("docs/manual-test-results-v0.md");
    const checklist = await readUtf8("docs/pr-release-checklist-v0.md");

    expect(manualResults).toContain("<!-- kairon:pr-body-policy -->");
    expect(manualResults).toContain("<!-- kairon:generated-artifact-policy -->");
    expect(checklist).toContain("<!-- kairon:pr-body-policy -->");
    expect(checklist).toContain("<!-- kairon:readme-update -->");
    expect(checklist).toContain("<!-- kairon:generated-artifact-policy -->");
    expect(checklist).toContain("-Encoding UTF8");
  });

  it("keeps README links to the operation test and release documents", async () => {
    const readme = await readUtf8("README.md");

    expect(readme).toContain("docs/operation-test-harness-v0.md");
    expect(readme).toContain("docs/manual-test-results-v0.md");
    expect(readme).toContain("docs/pr-release-checklist-v0.md");
    expect(readme).toContain("docs/release-checklist-v0.md");
    expect(readme).toContain("docs/release-notes-v0.md");
  });

  it("documents release readiness and versioning policy", async () => {
    const checklist = await readUtf8("docs/release-checklist-v0.md");
    const notes = await readUtf8("docs/release-notes-v0.md");
    const prChecklist = await readUtf8("docs/pr-release-checklist-v0.md");

    expect(checklist).toContain("<!-- kairon:release-readiness -->");
    expect(checklist).toContain("<!-- kairon:versioning-policy -->");
    expect(checklist).toContain("<!-- kairon:release-evidence -->");
    expect(checklist).toContain("npm run build");
    expect(checklist).toContain("npm test");
    expect(notes).toContain("<!-- kairon:release-notes-unreleased -->");
    expect(notes).toContain("<!-- kairon:versioning-policy -->");
    expect(prChecklist).toContain("docs/release-checklist-v0.md");
    expect(prChecklist).toContain("docs/release-notes-v0.md");
  });

  it("keeps package and CLI versions synchronized", async () => {
    const packageJson = JSON.parse(await readUtf8("package.json")) as {
      version: string;
    };
    const index = await readUtf8("src/index.ts");

    expect(index).toContain(`KAIRON_VERSION = "${packageJson.version}"`);
  });
});

async function readUtf8(relativePath: string): Promise<string> {
  return readFile(path.resolve(relativePath), "utf8");
}
