import { describe, expect, test } from "bun:test";

import { adaptClaudeCodeStatus } from "../../../src/protocols/claude-code.ts";

const fixture = async (name: string): Promise<unknown> =>
  Bun.file(new URL(`../../fixtures/protocols/claude-code/${name}.json`, import.meta.url)).json();

describe("Claude Code status adapter", () => {
  test("maps the complete current protocol contract", async () => {
    expect(adaptClaudeCodeStatus(await fixture("full"))).toEqual({
      projectDir: "/workspace/agent-hud",
      modelId: "opus-4-8",
      effort: "high",
      vimMode: "NORMAL",
      transcriptPath: "/state/transcripts/session-from-file.jsonl",
      worktreeBranch: "feature/status-adapter",
      remainingPct: 62,
      cacheRead: 120000,
      cacheCreation: 4000,
      inputTokens: 3000,
      fiveHourPct: 41,
      fiveHourReset: "2026-04-17T19:00:00Z",
      sevenDayPct: 18,
      sevenDayReset: 1776729600,
    });
  });

  test("maps minimal input without using raw session_id", async () => {
    expect(adaptClaudeCodeStatus(await fixture("minimal"))).toEqual({
      projectDir: undefined,
      modelId: "not-claude-sonnet",
      effort: undefined,
      vimMode: undefined,
      transcriptPath: undefined,
      worktreeBranch: undefined,
      remainingPct: undefined,
      cacheRead: undefined,
      cacheCreation: undefined,
      inputTokens: undefined,
      fiveHourPct: undefined,
      fiveHourReset: undefined,
      sevenDayPct: undefined,
      sevenDayReset: undefined,
    });
  });

  test("ignores wrong types without throwing", async () => {
    expect(adaptClaudeCodeStatus(await fixture("wrong-types"))).toEqual({
      projectDir: undefined,
      modelId: undefined,
      effort: undefined,
      vimMode: undefined,
      transcriptPath: undefined,
      worktreeBranch: undefined,
      remainingPct: undefined,
      cacheRead: undefined,
      cacheCreation: undefined,
      inputTokens: undefined,
      fiveHourPct: undefined,
      fiveHourReset: undefined,
      sevenDayPct: undefined,
      sevenDayReset: undefined,
    });
  });

  test("removes only one leading claude- prefix", () => {
    expect(adaptClaudeCodeStatus({ model: { id: "claude-claude-opus" } }).modelId).toBe(
      "claude-opus",
    );
    expect(adaptClaudeCodeStatus({ model: { id: "x-claude-opus" } }).modelId).toBe("x-claude-opus");
  });
});
