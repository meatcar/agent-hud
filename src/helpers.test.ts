import { describe, expect, test } from "bun:test";

import {
  burnSeconds,
  cacheHitPct,
  computeUsed,
  formatDuration,
  msToNextMinute,
  toEpoch,
} from "./helpers.ts";

describe("msToNextMinute", () => {
  test("mid-minute returns remainder to boundary", () => {
    expect(msToNextMinute(37_000)).toBe(23_000);
    expect(msToNextMinute(90_500)).toBe(29_500);
  });

  test("exact boundary returns 0", () => {
    expect(msToNextMinute(0)).toBe(0);
    expect(msToNextMinute(120_000)).toBe(0);
  });

  test("1ms before boundary returns 1", () => {
    expect(msToNextMinute(119_999)).toBe(1);
  });
});

describe("formatDuration", () => {
  test("undefined inputs", () => {
    expect(formatDuration(undefined)).toBeUndefined();
    expect(formatDuration(Number.NaN)).toBeUndefined();
  });

  test("<1min returns 'now'", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(59)).toBe("now");
  });

  test("minute boundaries", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(119)).toBe("1m");
    expect(formatDuration(3599)).toBe("59m");
  });

  test("hour boundaries zero-pad minutes", () => {
    expect(formatDuration(3600)).toBe("1h00m");
    expect(formatDuration(3660)).toBe("1h01m");
    expect(formatDuration(3600 + 59 * 60)).toBe("1h59m");
  });

  test("day rollover", () => {
    expect(formatDuration(86_400)).toBe("1d");
    expect(formatDuration(86_400 + 3600)).toBe("1d");
    expect(formatDuration(86_400 * 40)).toBe("40d");
  });
});

describe("burnSeconds", () => {
  test("zero/negative inputs return undefined", () => {
    expect(burnSeconds(0, 100)).toBeUndefined();
    expect(burnSeconds(-1, 100)).toBeUndefined();
    expect(burnSeconds(50, 0)).toBeUndefined();
    expect(burnSeconds(undefined, 100)).toBeUndefined();
  });

  test("linear extrapolation", () => {
    expect(burnSeconds(50, 100)).toBe(100);
    expect(burnSeconds(25, 100)).toBe(300);
    expect(burnSeconds(10, 100)).toBe(900);
  });

  test("clamps to 0 once full", () => {
    expect(burnSeconds(100, 500)).toBe(0);
    expect(burnSeconds(150, 500)).toBe(0);
  });
});

describe("toEpoch", () => {
  test("undefined/empty", () => {
    expect(toEpoch(undefined)).toBeUndefined();
    expect(toEpoch("")).toBeUndefined();
  });

  test("numeric and numeric-string pass through", () => {
    expect(toEpoch(1_713_369_600)).toBe(1_713_369_600);
    expect(toEpoch("1713369600")).toBe(1_713_369_600);
  });

  test("ISO string parses", () => {
    expect(toEpoch("2026-04-17T00:00:00Z")).toBe(1_776_384_000);
  });

  test("garbage returns undefined", () => {
    expect(toEpoch("not-a-date")).toBeUndefined();
  });
});

describe("computeUsed", () => {
  test("falls back to remaining_percentage", () => {
    expect(computeUsed(62, "sonnet-4-6", undefined)).toBe(38);
    expect(computeUsed(0, "sonnet-4-6", undefined)).toBe(100);
  });

  test("undefined remaining returns undefined when no 1m path", () => {
    expect(computeUsed(undefined, "sonnet-4-6", undefined)).toBeUndefined();
  });

  test("[1m] scales tokens against the full 1M window", () => {
    // 200k tokens = 20% of the 1M window (the marked threshold)
    const tokens = { cacheRead: 100_000, cacheCreation: 50_000, input: 50_000 };
    expect(computeUsed(0, "sonnet-4-6[1m]", tokens)).toBe(20);
  });

  test("[1m] caps at 100% when tokens reach 1M", () => {
    const tokens = { cacheRead: 600_000, cacheCreation: 200_000, input: 200_000 };
    expect(computeUsed(0, "sonnet-4-6[1m]", tokens)).toBe(100);
  });

  test("[1m] clamps above 1M", () => {
    const tokens = { cacheRead: 1_000_000, cacheCreation: 200_000, input: 0 };
    expect(computeUsed(0, "sonnet-4-6[1m]", tokens)).toBe(100);
  });

  test("[1m] computes from tokens, not remaining", () => {
    // 100k tokens = 10% of 1M, ignoring remaining_percentage
    const tokens = { cacheRead: 50_000, cacheCreation: 10_000, input: 40_000 };
    expect(computeUsed(90, "sonnet-4-6[1m]", tokens)).toBe(10);
  });

  test("[1m] without token data falls back to remaining", () => {
    expect(computeUsed(70, "sonnet-4-6[1m]", undefined)).toBe(30);
  });
});

describe("cacheHitPct", () => {
  test("rounds read / total", () => {
    expect(cacheHitPct(940, 30, 30)).toBe(94);
    expect(cacheHitPct(0, 0, 0)).toBeUndefined();
  });

  test("any undefined component returns undefined", () => {
    expect(cacheHitPct(undefined, 10, 10)).toBeUndefined();
    expect(cacheHitPct(10, undefined, 10)).toBeUndefined();
  });
});
