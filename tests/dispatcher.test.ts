import { describe, expect, it } from "vitest";
import { AgentDispatcher } from "../src/agents/dispatcher.js";
import { suspendProvider } from "../src/agents/provider-policy.js";
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

  it("falls back to Codex for automated QA while Antigravity requires a PTY runner", async () => {
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

  it("selects Antigravity for Google QA when interactive agents are allowed", async () => {
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

  it("avoids temporarily limited same-day sessions", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });

    await expect(
      new AgentDispatcher(root).decide({
        persona: "qa",
        tags: ["google_ecosystem", "multimodal"],
        allowInteractiveAgents: true,
        availableSessions: [
          { agent: "gemini", status: "usage_limited" },
          { agent: "codex", status: "ready" }
        ]
      })
    ).resolves.toMatchObject({
      agent: "codex",
      reason: expect.stringContaining("session ready")
    });
  });

  it("avoids unhealthy ready sessions until retry backoff expires", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const dispatcher = new AgentDispatcher(root);
    const availableSessions = [
      {
        agent: "codex" as const,
        status: "ready" as const,
        healthStatus: "blocked" as const,
        nextRetryAt: "2026-05-25T02:00:00.000Z"
      },
      { agent: "claude" as const, status: "ready" as const }
    ];

    await expect(
      dispatcher.decide({
        persona: "implementer",
        availableSessions,
        now: new Date("2026-05-25T01:00:00.000Z")
      })
    ).resolves.toMatchObject({ agent: "claude" });

    await expect(
      dispatcher.decide({
        persona: "implementer",
        availableSessions,
        avoidUnhealthyAgents: false,
        now: new Date("2026-05-25T01:00:00.000Z")
      })
    ).resolves.toMatchObject({ agent: "codex" });

    await expect(
      dispatcher.decide({
        persona: "implementer",
        availableSessions,
        now: new Date("2026-05-25T02:00:00.000Z")
      })
    ).resolves.toMatchObject({
      agent: "codex",
      reason: expect.stringContaining("health blocked")
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

  it("falls back when the preferred provider is suspended", async () => {
    const root = await createTempProject();
    await initializeProject({ projectRoot: root });
    const now = new Date("2026-07-16T06:00:00.000Z");
    await suspendProvider(root, {
      agent: "codex",
      reason: "authentication remediation",
      now
    });

    await expect(
      new AgentDispatcher(root).decide({
        persona: "implementer",
        now,
        availableSessions: [
          { agent: "codex", status: "ready" },
          { agent: "claude", status: "ready" }
        ]
      })
    ).resolves.toMatchObject({
      agent: "claude",
      reason: expect.stringContaining("provider ready")
    });
  });
});
