import { describe, expect, it } from "vitest";
import { AgentDispatcher } from "../src/agents/dispatcher.js";
import { initializeProject } from "../src/cli/commands/init.js";
import { createTempProject } from "./test-utils.js";

describe("AgentDispatcher", () => {
  it("selects Codex as the default implementer", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      new AgentDispatcher(root).decide({
        persona: "implementer",
        availableSessions: [
          { agent: "codex", status: "ready" },
          { agent: "claude", status: "ready" },
          { agent: "gemini", status: "ready" }
        ]
      })
    ).resolves.toMatchObject({
      agent: "codex",
      runnerMode: "persistent_terminal_session",
      sessionScope: "daily"
    });
  });

  it("falls back to another persona-compatible ready agent", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      new AgentDispatcher(root).decide({
        persona: "implementer",
        availableSessions: [
          { agent: "codex", status: "busy" },
          { agent: "claude", status: "ready" }
        ]
      })
    ).resolves.toMatchObject({
      agent: "claude"
    });
  });

  it("falls back to Codex for automated QA while Gemini requires a PTY runner", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      new AgentDispatcher(root).decide({
        persona: "qa",
        tags: ["google_ecosystem", "multimodal"],
        availableSessions: [
          { agent: "codex", status: "ready" },
          { agent: "gemini", status: "ready" }
        ]
      })
    ).resolves.toMatchObject({
      agent: "codex"
    });
  });

  it("selects Antigravity/Gemini for Google QA when interactive agents are allowed", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      new AgentDispatcher(root).decide({
        persona: "qa",
        tags: ["google_ecosystem", "multimodal"],
        allowInteractiveAgents: true,
        availableSessions: [
          { agent: "codex", status: "ready" },
          { agent: "gemini", status: "ready" }
        ]
      })
    ).resolves.toMatchObject({
      agent: "gemini"
    });
  });

  it("honors policy, capability, and non-interactive runner constraints", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      new AgentDispatcher(root).decide({
        persona: "reviewer",
        requiredCapabilities: ["multimodal"],
        policy: { allowedAgents: ["codex", "gemini"] },
        availableSessions: [
          { agent: "codex", status: "ready" },
          { agent: "claude", status: "ready" },
          { agent: "gemini", status: "ready" }
        ]
      })
    ).rejects.toThrow("No available agent");
  });
});
