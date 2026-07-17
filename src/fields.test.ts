import { describe, expect, test } from "bun:test";

import { buildLine1, buildLine2, extractFields } from "./fields.ts";

const stripAnsi = (str: string): string => Bun.stripANSI(str);

describe("extractFields effort", () => {
  test("extracts effort.level", () => {
    expect(extractFields({ effort: { level: "high" } }).effort).toBe("high");
  });

  test("undefined when absent", () => {
    expect(extractFields({}).effort).toBeUndefined();
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
        ...extractFields({ model: { id: "claude-opus-4-8" }, effort: { level: "high" } }),
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
      buildLine1({ ...extractFields({ model: { id: "claude-opus-4-8" } }), ...base }),
    );
    expect(out).not.toContain("high");
  });
});

describe("buildLine2", () => {
  test("joins repo, worktree, and drift with single spaces", () => {
    const out = buildLine2({ repoOut: "proj", driftOut: "main ⇡2", worktreeBranch: "wt" });
    expect(stripAnsi(out)).toBe("\tproj [wt] main ⇡2");
  });

  test("omits empty segments", () => {
    expect(
      stripAnsi(buildLine2({ repoOut: "proj", driftOut: "", worktreeBranch: undefined })),
    ).toBe("\tproj");
  });
});
