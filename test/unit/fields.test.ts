import { describe, expect, test } from "bun:test";

import {
  buildLine1,
  buildLine2,
  customRefId,
  isCustomRef,
  renderLayoutLine,
  renderSections,
} from "../../src/fields.ts";
import { MS_PER_SEC } from "../../src/constants.ts";
import { renderClockGroup } from "../../src/powerline.ts";
import { adaptClaudeCodeStatus } from "../../src/protocols/claude-code.ts";

const stripAnsi = (str: string): string => Bun.stripANSI(str);

describe("Claude status effort rendering", () => {
  test("extracts effort.level", () => {
    expect(adaptClaudeCodeStatus({ effort: { level: "high" } }).effort).toBe("high");
  });

  test("undefined when absent", () => {
    expect(adaptClaudeCodeStatus({}).effort).toBeUndefined();
  });
});

describe("buildLine1 effort", () => {
  const base = {
    sessionStart: undefined,
    now: 0,
    ttlSecs: undefined,
    lastActivity: undefined,
  } as const;

  test("renders effort after model name", () => {
    const out = stripAnsi(
      buildLine1({
        ...adaptClaudeCodeStatus({
          model: { id: "claude-opus-4-8" },
          effort: { level: "high" },
        }),
        ...base,
      }),
    );
    const modelIdx = out.indexOf("opus-4-8");
    const effortIdx = out.indexOf("high");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(effortIdx).toBeGreaterThan(modelIdx);
  });

  test("omits effort when absent", () => {
    const out = stripAnsi(
      buildLine1({
        ...adaptClaudeCodeStatus({ model: { id: "claude-opus-4-8" } }),
        ...base,
      }),
    );
    expect(out).not.toContain("high");
  });
});

describe("buildLine2", () => {
  test("joins repo, worktree, and drift with single spaces", () => {
    const out = buildLine2({ repoOut: "proj", driftOut: "main ⇡2", worktreeBranch: "wt" });
    expect(stripAnsi(out)).toBe("proj [wt] main ⇡2");
  });

  test("omits empty segments", () => {
    expect(
      stripAnsi(buildLine2({ repoOut: "proj", driftOut: "", worktreeBranch: undefined })),
    ).toBe("proj");
  });
});

describe("renderSections", () => {
  const params = {
    ...adaptClaudeCodeStatus({
      model: { id: "claude-opus-4-8" },
      effort: { level: "high" },
    }),
    sessionStart: undefined,
    now: 0,
    ttlSecs: undefined,
    lastActivity: undefined,
    repoOut: "proj",
    driftOut: "main ⇡2",
    worktreeBranch: "wt",
  };

  test("renders only the requested section", () => {
    expect(stripAnsi(renderSections(params, ["model"]))).toBe("opus-4-8 high");
  });

  test("renders requested sections in order", () => {
    const out = stripAnsi(renderSections(params, ["vcs", "model"]));
    expect(out).toBe("proj [wt] main ⇡2 opus-4-8 high");
  });
});

describe("clock rendering", () => {
  const params = {
    ...adaptClaudeCodeStatus({}),
    sessionStart: undefined,
    ttlSecs: undefined,
    lastActivity: undefined,
    repoOut: "",
    driftOut: "",
    worktreeBranch: undefined,
  };

  test("uses the injected epoch seconds for section and default clocks", () => {
    const now = 1_800_000_000;
    const expected = renderClockGroup(new Date(now * MS_PER_SEC));
    expect(renderSections({ ...params, now }, ["clock"])).toBe(expected);
    expect(buildLine1({ ...params, now })).toEndWith(expected);
    expect(renderSections({ ...params, now: now + 3600 }, ["clock"])).not.toBe(expected);
  });
});

describe("isCustomRef", () => {
  test("accepts cmd: refs with an id", () => {
    expect(isCustomRef("cmd:k8s")).toBe(true);
    expect(customRefId("cmd:k8s")).toBe("k8s");
  });

  test("rejects everything else", () => {
    expect(isCustomRef("cmd:")).toBe(false);
    expect(isCustomRef("cmd")).toBe(false);
    expect(isCustomRef("model")).toBe(false);
    expect(isCustomRef("")).toBe(false);
  });
});

describe("renderLayoutLine", () => {
  const params = {
    ...adaptClaudeCodeStatus({ model: { id: "claude-opus-4-8" } }),
    sessionStart: undefined,
    now: 0,
    ttlSecs: undefined,
    lastActivity: undefined,
    repoOut: "proj",
    driftOut: "",
    worktreeBranch: undefined,
  };

  test("interleaves builtin and custom items in order", () => {
    const custom = new Map([["k8s", "prod"]]);
    expect(stripAnsi(renderLayoutLine(params, custom, ["vcs", "cmd:k8s", "model"]))).toBe(
      "proj prod opus-4-8",
    );
  });

  test("omits custom items with missing or empty output", () => {
    const custom = new Map([["empty", ""]]);
    expect(stripAnsi(renderLayoutLine(params, custom, ["cmd:missing", "cmd:empty", "model"]))).toBe(
      "opus-4-8",
    );
  });

  test("matches renderSections for builtin-only layouts", () => {
    expect(renderLayoutLine(params, new Map(), ["vcs", "model"])).toBe(
      renderSections(params, ["vcs", "model"]),
    );
  });
});
