import { describe, expect, it } from "vitest";
import {
  extractOutboxFromStdout,
  hasMatchingStdoutOutbox
} from "../src/agents/stdout-outbox.js";

describe("stdout outbox extraction", () => {
  it("uses the latest valid marker block after stripping terminal control sequences", () => {
    const stdout = [
      "KAIRON_OUTBOX_JSON_START\nnot-json\nKAIRON_OUTBOX_JSON_END\n",
      "\u001b[32mKAIRON_OUTBOX_JSON_START\u001b[0m\n",
      '{"run_id":"RUN-0001","status":"completed"}',
      "\nKAIRON_OUTBOX_JSON_END\n"
    ].join("");

    expect(extractOutboxFromStdout(stdout)).toEqual({
      run_id: "RUN-0001",
      status: "completed"
    });
    expect(hasMatchingStdoutOutbox(stdout, "RUN-0001")).toBe(true);
    expect(hasMatchingStdoutOutbox(stdout, "RUN-OTHER")).toBe(false);
  });

  it("extracts marker blocks nested in JSON stream string fields", () => {
    const fallback = [
      "KAIRON_OUTBOX_JSON_START\n",
      '{"run_id":"RUN-0002","status":"setup_required"}',
      "\nKAIRON_OUTBOX_JSON_END"
    ].join("");
    const stdout = JSON.stringify({ type: "result", result: fallback });

    expect(extractOutboxFromStdout(stdout)).toEqual({
      run_id: "RUN-0002",
      status: "setup_required"
    });
  });
});
