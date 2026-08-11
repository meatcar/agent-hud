import { describe, expect, test } from "bun:test";

import {
  contentFingerprint,
  deriveSession,
  flattenRateLimits,
  parseSectionArgs,
  parseStatusJson,
  selectOutput,
} from "../../src/core.ts";
import { adaptClaudeCodeStatus } from "../../src/protocols/claude-code.ts";
import type { AgentHudConfig } from "../../src/config.ts";
import type { RateLimitsV1 } from "../../src/rate-limits.ts";
import type { StatusSnapshot } from "../../src/status.ts";

const emptyStatus = (): StatusSnapshot => ({
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

describe("parseStatusJson", () => {
  test("parses JSON strings", () => {
    expect(parseStatusJson('{"model":{"id":"claude-opus"}}')).toEqual({
      model: { id: "claude-opus" },
    });
  });

  test("uses the statusline parse error", () => {
    expect(() => parseStatusJson("not-json")).toThrow("Invalid statusline JSON");
  });
});

describe("parseSectionArgs", () => {
  test("distinguishes default layout from an explicit section list", () => {
    expect(parseSectionArgs([])).toBeUndefined();
    expect(parseSectionArgs(["vcs", "model"])).toEqual(["vcs", "model"]);
  });

  test("rejects unknown and custom command sections", () => {
    expect(() => parseSectionArgs(["weather"])).toThrow("Unknown section: weather");
    expect(() => parseSectionArgs(["cmd:build"])).toThrow("Unknown section: cmd:build");
  });
});

describe("session and activity derivation", () => {
  test("uses the transcript basename and exact token-counter fingerprint", () => {
    const status = adaptClaudeCodeStatus({
      session_id: "ignored",
      transcript_path: "/tmp/transcripts/abc.jsonl",
      context_window: {
        current_usage: {
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 20,
          input_tokens: 30,
        },
      },
    });
    expect(deriveSession(status)).toEqual({
      sessionId: "abc",
      session: { sessionId: "abc", fingerprint: "10:20:30" },
    });
  });

  test("does not track activity without a transcript or computable hit ratio", () => {
    expect(deriveSession(emptyStatus())).toEqual({ sessionId: undefined, session: undefined });
    expect(deriveSession({ ...emptyStatus(), transcriptPath: "/tmp/abc.jsonl" })).toEqual({
      sessionId: "abc",
      session: undefined,
    });
  });
});

describe("flattenRateLimits", () => {
  test("flattens the two current windows without generalizing them", () => {
    const limits: RateLimitsV1 = {
      version: 1,
      fiveHour: { pct: 41, resetsAt: 1000 },
      sevenDay: { pct: 18, resetsAt: 2000 },
    };
    expect(flattenRateLimits(limits)).toEqual({
      fiveHourPct: 41,
      fiveHourReset: 1000,
      sevenDayPct: 18,
      sevenDayReset: 2000,
    });
  });
});

describe("contentFingerprint", () => {
  const status: StatusSnapshot = {
    projectDir: "/workspace/project",
    modelId: "opus-4-8",
    effort: "high",
    vimMode: "NORMAL",
    transcriptPath: "/state/session.jsonl",
    worktreeBranch: "feature",
    remainingPct: 61,
    cacheRead: 120,
    cacheCreation: 30,
    inputTokens: 10,
    fiveHourPct: 41,
    fiveHourReset: "2027-01-15T09:00:00Z",
    sevenDayPct: 18,
    sevenDayReset: 1_800_086_400,
  };
  const changedStatus: StatusSnapshot = {
    projectDir: "/workspace/other",
    modelId: "sonnet-4-6",
    effort: "low",
    vimMode: "INSERT",
    transcriptPath: "/state/other.jsonl",
    worktreeBranch: "other",
    remainingPct: 60,
    cacheRead: 121,
    cacheCreation: 31,
    inputTokens: 11,
    fiveHourPct: 42,
    fiveHourReset: "2027-01-15T10:00:00Z",
    sevenDayPct: 19,
    sevenDayReset: 1_800_086_401,
  };
  const config: AgentHudConfig = {
    layout: [
      ["model", "context"],
      ["vcs", "cmd:build"],
    ],
    commands: new Map(),
  };
  const customEntries = [
    ["build", "green"],
    ["deploy", "prod"],
  ] as const;
  const statusKeys = [
    "projectDir",
    "modelId",
    "effort",
    "vimMode",
    "transcriptPath",
    "worktreeBranch",
    "remainingPct",
    "cacheRead",
    "cacheCreation",
    "inputTokens",
    "fiveHourPct",
    "fiveHourReset",
    "sevenDayPct",
    "sevenDayReset",
  ] as const satisfies readonly (keyof StatusSnapshot)[];

  test("uses a fully populated explicit ordered projection", () => {
    expect(contentFingerprint(status, "repo main", config, new Map(customEntries))).toBe(
      JSON.stringify({
        fields: status,
        line2: "repo main",
        configuredLayout: config.layout,
        custom: ["green", "prod"],
      }),
    );
  });

  test("changes for every projected status field", () => {
    const baseline = contentFingerprint(status, "repo main", config, new Map(customEntries));
    for (const key of statusKeys) {
      const mutated = { ...status, [key]: changedStatus[key] };
      expect(contentFingerprint(mutated, "repo main", config, new Map(customEntries))).not.toBe(
        baseline,
      );
    }
  });

  test("changes for layout, line 2, and each ordered custom output", () => {
    const baseline = contentFingerprint(status, "repo main", config, new Map(customEntries));
    const changedLayout: AgentHudConfig = {
      ...config,
      layout: [
        ["context", "model"],
        ["vcs", "cmd:build"],
      ],
    };
    expect(contentFingerprint(status, "repo main", changedLayout, new Map(customEntries))).not.toBe(
      baseline,
    );
    expect(contentFingerprint(status, "repo other", config, new Map(customEntries))).not.toBe(
      baseline,
    );
    for (let index = 0; index < customEntries.length; index += 1) {
      const changed = customEntries.map(
        ([key, value], entryIndex) =>
          [key, entryIndex === index ? `${value}-changed` : value] as const,
      );
      expect(contentFingerprint(status, "repo main", config, new Map(changed))).not.toBe(baseline);
    }
    expect(
      contentFingerprint(status, "repo main", config, new Map([...customEntries].toReversed())),
    ).not.toBe(baseline);
  });

  test("excludes render-time values that are outside its input contract", () => {
    const baseline = contentFingerprint(status, "repo main", config, new Map(customEntries));
    const withRenderTimes = {
      ...status,
      now: 1_800_000_000,
      sessionStart: 1_799_999_000,
      ttlSecs: 3600,
      lastActivity: 1_799_999_900,
    };
    const withOtherRenderTimes = {
      ...withRenderTimes,
      now: 1_900_000_000,
      sessionStart: undefined,
      ttlSecs: undefined,
      lastActivity: undefined,
    };
    expect(contentFingerprint(withRenderTimes, "repo main", config, new Map(customEntries))).toBe(
      baseline,
    );
    expect(
      contentFingerprint(withOtherRenderTimes, "repo main", config, new Map(customEntries)),
    ).toBe(baseline);
  });
});

describe("selectOutput", () => {
  const status = { ...emptyStatus(), modelId: "opus" };
  const params = {
    ...status,
    sessionStart: undefined,
    now: 0,
    ttlSecs: undefined,
    lastActivity: undefined,
    repoOut: "repo",
    driftOut: "",
  };
  const config = { layout: [["vcs" as const]], commands: new Map() };

  test("CLI sections override config and config overrides the built-in output", () => {
    expect(Bun.stripANSI(selectOutput(params, ["model"], config, new Map(), "DEFAULT"))).toBe(
      "opus",
    );
    expect(Bun.stripANSI(selectOutput(params, undefined, config, new Map(), "DEFAULT"))).toBe(
      "repo",
    );
    expect(selectOutput(params, undefined, undefined, new Map(), "DEFAULT")).toBe("DEFAULT");
  });

  test("composes fixed status, limits, VCS, custom text, and epoch deterministically", () => {
    const now = 1_800_000_000;
    const fixedStatus = adaptClaudeCodeStatus({
      model: { id: "claude-opus-4-8" },
      effort: { level: "high" },
      vim: { mode: "NORMAL" },
      context_window: {
        remaining_percentage: 50,
        current_usage: {
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          input_tokens: 5,
        },
      },
    });
    const fixedParams = {
      ...fixedStatus,
      ...flattenRateLimits({
        version: 1,
        fiveHour: { pct: 41, resetsAt: now + 3600 },
        sevenDay: { pct: 18, resetsAt: now + 86400 },
      }),
      sessionStart: now - 300,
      now,
      ttlSecs: 3600,
      lastActivity: now - 60,
      repoOut: "repo",
      driftOut: "main ⇡2",
      worktreeBranch: "wt",
    };
    const fixedConfig: AgentHudConfig = {
      layout: [
        ["model", "context", "rate-limits", "clock"],
        ["vcs", "cmd:build"],
      ],
      commands: new Map(),
    };
    const output = Bun.stripANSI(
      selectOutput(fixedParams, undefined, fixedConfig, new Map([["build", "green"]]), "DEFAULT"),
    );
    expect(output).toBe(
      "N opus-4-8 high 🔥 59m  50%    50%    5m 41%   ▌    1h00m/5h   ▉18%        1d/7d    08:00 \nrepo [wt] main ⇡2 green",
    );
  });
});
