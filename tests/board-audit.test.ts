import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  auditBoardAccess,
  boardAccessAuditPath,
  hashBoardIdentity
} from "../src/board/access-audit.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { createTempProject } from "./test-utils.js";

describe("remote Board access audit", () => {
  it("records classified metadata without request credentials", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const identity = "operator@example.test";
    const token = "SHOULD-NOT-BE-IN-AUDIT";
    await auditBoardAccess(
      root,
      {
        outcome: "allowed",
        method: "GET",
        route: "index",
        http_status: 200,
        auth_status: "accepted",
        access_id: "BOARD-ACCESS-T154-AUDIT",
        identity_hash: hashBoardIdentity(identity),
        proxy_status: "accepted",
        origin_status: "accepted",
        rate_limited: false,
        user_agent_present: true,
        recorded_at: "2026-07-16T00:00:00.000Z"
      },
      "remote-readonly"
    );

    const auditPath = boardAccessAuditPath(root, "remote-readonly");
    expect(auditPath.replaceAll("\\", "/")).toContain(
      "/.kairon/audit/board-access.jsonl"
    );
    const text = await readFile(auditPath, "utf8");
    expect(text).toContain('"client":"remote"');
    expect(text).toContain(hashBoardIdentity(identity));
    expect(text).not.toContain(identity);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/authorization|cookie/i);
  });
});
