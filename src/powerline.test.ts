import { describe, expect, test } from "bun:test";

import { ICON_5H, ICON_7D, ICON_MISS, MISS_CRIT, MISS_WARN } from "./constants.ts";
import {
  BLUE,
  LIGHTBLUE,
  RED,
  type Tone,
  YELLOW,
  computeLimitBurn,
  fractionalBar,
  groupCaps,
  limitFillTone,
  makeTone,
  missPill,
  missTone,
  renderClockGroup,
  renderCtxSegment,
  renderRateLimitsGroup,
} from "./powerline.ts";

// Minimal tones that don't apply ANSI — makes structural assertions easy.
const Fill: Tone = makeTone(
  (str) => `[${str}]`,
  (str) => `|${str}|`,
  (str) => str,
);
const Bg: Tone = makeTone(
  (str) => `{${str}}`,
  (str) => `<${str}>`,
  (str) => str,
);
const Edge: Tone = makeTone(
  (str) => `(${str})`,
  (str) => `!${str}!`,
  (str) => str,
);
const Marker: Tone = makeTone(
  (str) => `*${str}*`,
  (str) => `~${str}~`,
  (str) => str,
);

const strip = (str: string) => str.replace(/[[\]{}|<>()!*~]/g, "");

describe("fractionalBar — layout", () => {
  test("single label renders inside bar", () => {
    const bar = fractionalBar({ pct: 50, labels: ["50%"], fillTone: Fill, bgTone: Bg });
    expect(strip(bar)).toContain("50%");
  });

  test("multiple labels all render inside bar", () => {
    const bar = fractionalBar({ pct: 60, labels: ["60%", "2h"], fillTone: Fill, bgTone: Bg });
    const plain = strip(bar);
    expect(plain).toContain("60%");
    expect(plain).toContain("2h");
  });

  test("bar expands to fit labels longer than minWidth", () => {
    const labels = ["60%", "long label"];
    const bar = fractionalBar({ pct: 60, labels, minWidth: 4, fillTone: Fill, bgTone: Bg });
    const plain = strip(bar);
    expect(plain.length).toBeGreaterThan(4);
    expect(plain).toContain("60%");
    expect(plain).toContain("long label");
  });

  test("bar respects minWidth when labels are short", () => {
    const bar = fractionalBar({
      pct: 50,
      labels: ["50%"],
      minWidth: 12,
      fillTone: Fill,
      bgTone: Bg,
    });
    expect(strip(bar).length).toBe(12);
  });

  test("space-between: first label is at start, last label is at end", () => {
    const bar = fractionalBar({
      pct: 50,
      labels: ["AAA", "ZZZ"],
      minWidth: 20,
      fillTone: Fill,
      bgTone: Bg,
    });
    const plain = strip(bar);
    expect(plain.startsWith("AAA")).toBe(true);
    expect(plain.endsWith("ZZZ")).toBe(true);
  });

  test("three labels: all present with space-between spacing", () => {
    const bar = fractionalBar({
      pct: 50,
      labels: ["A", "B", "C"],
      minWidth: 20,
      fillTone: Fill,
      bgTone: Bg,
    });
    const plain = strip(bar);
    expect(plain).toContain("A");
    expect(plain).toContain("B");
    expect(plain).toContain("C");
    expect(plain.startsWith("A")).toBe(true);
    expect(plain.endsWith("C")).toBe(true);
  });

  test("empty labels array renders at minWidth", () => {
    const bar = fractionalBar({ pct: 75, labels: [], minWidth: 8, fillTone: Fill, bgTone: Bg });
    expect(strip(bar).length).toBe(8);
  });
});

describe("fractionalBar — fractional rendering", () => {
  test("pct=0: entire bar in bg tone (no fill)", () => {
    const bar = fractionalBar({ pct: 0, labels: [], minWidth: 8, fillTone: Fill, bgTone: Bg });
    expect(bar).not.toContain("[");
    expect(bar).not.toContain("]");
    expect(strip(bar).length).toBe(8);
  });

  test("pct=100: entire bar in fill tone (no bg, no partial block)", () => {
    const bar = fractionalBar({ pct: 100, labels: [], minWidth: 8, fillTone: Fill, bgTone: Bg });
    expect(bar).not.toContain("{");
    expect(bar).not.toContain("}");
    expect(strip(bar).length).toBe(8);
  });

  test("fractional pct renders a partial-block char at the boundary", () => {
    const bar = fractionalBar({ pct: 51, labels: [], minWidth: 20, fillTone: Fill, bgTone: Bg });
    expect(strip(bar)).toContain("▎");
    expect(strip(bar).length).toBe(20);
  });

  test("label pushed right does not straddle the boundary cell", () => {
    const bar = fractionalBar({
      pct: 30,
      labels: ["HELLO"],
      minWidth: 14,
      fillTone: Fill,
      bgTone: Bg,
    });
    const plain = strip(bar);
    expect(plain).toContain("HELLO");
    const pos = plain.indexOf("HELLO");
    expect(pos).toBeGreaterThan(4);
  });

  test("label that fits in filled region stays entirely before boundary", () => {
    const bar = fractionalBar({
      pct: 70,
      labels: ["HI"],
      minWidth: 16,
      fillTone: Fill,
      bgTone: Bg,
    });
    const plain = strip(bar);
    const pos = plain.indexOf("HI");
    expect(pos).toBeGreaterThanOrEqual(0);
    expect(pos + "HI".length - 1).toBeLessThan(11);
  });

  test("pct=50 with exact cell boundary produces no partial-block char", () => {
    const bar = fractionalBar({ pct: 50, labels: [], minWidth: 20, fillTone: Fill, bgTone: Bg });
    const plain = strip(bar);
    expect(/[▏▎▍▌▋▊▉]/u.test(plain)).toBe(false);
  });
});

describe("missPill", () => {
  test("contains miss icon and pct", () => {
    expect(missPill(5)).toContain(ICON_MISS);
    expect(missPill(5)).toContain("5%");
  });

  test("below MISS_WARN renders pct correctly", () => {
    expect(missPill(MISS_WARN - 1)).toContain(`${MISS_WARN - 1}%`);
  });

  test("at MISS_WARN renders pct correctly", () => {
    expect(missPill(MISS_WARN)).toContain(`${MISS_WARN}%`);
  });

  test("at MISS_CRIT renders pct correctly", () => {
    expect(missPill(MISS_CRIT)).toContain(`${MISS_CRIT}%`);
  });

  test("clamps to 0-100", () => {
    expect(missPill(-5)).toContain("0%");
    expect(missPill(105)).toContain("100%");
  });
});

describe("groupCaps", () => {
  test("wraps inner with bg tone", () => {
    expect(groupCaps("hello", Fill)).toBe("[hello]");
  });
});

describe("renderRateLimitsGroup", () => {
  const NOW = 1_776_400_000;
  const FIVE_SECS = 18_000;
  const SEVEN_SECS = 604_800;

  test("returns empty string when both pcts are undefined", () => {
    expect(
      renderRateLimitsGroup({
        five: { pct: undefined, resetAt: undefined, windowSecs: FIVE_SECS, now: NOW },
        seven: { pct: undefined, resetAt: undefined, windowSecs: SEVEN_SECS, now: NOW },
      }),
    ).toBe("");
  });

  test("contains both icons when both windows present", () => {
    const result = renderRateLimitsGroup({
      five: { pct: 40, resetAt: NOW + 10_000, windowSecs: FIVE_SECS, now: NOW },
      seven: { pct: 12, resetAt: NOW + 300_000, windowSecs: SEVEN_SECS, now: NOW },
    });
    expect(result).toContain(ICON_5H);
    expect(result).toContain(ICON_7D);
  });

  test("renders without error when only 5h present", () => {
    const result = renderRateLimitsGroup({
      five: { pct: 40, resetAt: NOW + 10_000, windowSecs: FIVE_SECS, now: NOW },
      seven: { pct: undefined, resetAt: undefined, windowSecs: SEVEN_SECS, now: NOW },
    });
    expect(result).toContain(ICON_5H);
    expect(result).not.toContain(ICON_7D);
  });

  test("result is non-empty when any window present", () => {
    const result = renderRateLimitsGroup({
      five: { pct: 50, resetAt: NOW + 9000, windowSecs: FIVE_SECS, now: NOW },
      seven: { pct: 50, resetAt: NOW + 300_000, windowSecs: SEVEN_SECS, now: NOW },
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain(ICON_5H);
  });

  test("time label uses /5h and /7d suffixes instead of standalone icons", () => {
    const result = renderRateLimitsGroup({
      five: { pct: 40, resetAt: NOW + 10_000, windowSecs: FIVE_SECS, now: NOW },
      seven: { pct: 12, resetAt: NOW + 300_000, windowSecs: SEVEN_SECS, now: NOW },
    });
    expect(result).toContain(`/${ICON_5H}`);
    expect(result).toContain(`/${ICON_7D}`);
  });

  test("missing bucket placeholder matches rendered width (no clock drift)", () => {
    const five = { pct: 40, resetAt: undefined, windowSecs: FIVE_SECS, now: NOW };
    const both = renderRateLimitsGroup({
      five,
      seven: { pct: 40, resetAt: undefined, windowSecs: SEVEN_SECS, now: NOW },
    });
    const onlyFive = renderRateLimitsGroup({
      five,
      seven: { pct: undefined, resetAt: undefined, windowSecs: SEVEN_SECS, now: NOW },
    });
    expect(Bun.stripANSI(onlyFive).length).toBe(Bun.stripANSI(both).length);
  });
});

describe("computeLimitBurn", () => {
  const NOW = 1_776_400_000;
  const FIVE_SECS = 18_000;

  test("resetAt undefined → burn and resetSecs are undefined", () => {
    const result = computeLimitBurn(50, {
      pct: 50,
      resetAt: undefined,
      windowSecs: FIVE_SECS,
      now: NOW,
    });
    expect(result.burn).toBeUndefined();
    expect(result.resetSecs).toBeUndefined();
  });

  test("no elapsed time (window just started) → burn undefined", () => {
    // ResetAt = NOW + FIVE_SECS means elapsed = 0
    const result = computeLimitBurn(50, {
      pct: 50,
      resetAt: NOW + FIVE_SECS,
      windowSecs: FIVE_SECS,
      now: NOW,
    });
    expect(result.burn).toBeUndefined();
    expect(result.resetSecs).toBe(FIVE_SECS);
  });

  test("computes burn seconds correctly", () => {
    // Elapsed = 18000 - 10000 = 8000s, pct = 40 → burn = (60/40) * 8000 = 12000
    const result = computeLimitBurn(40, {
      pct: 40,
      resetAt: NOW + 10_000,
      windowSecs: FIVE_SECS,
      now: NOW,
    });
    expect(result.burn).toBe(12_000);
    expect(result.resetSecs).toBe(10_000);
  });
});

describe("renderCtxSegment — cache leaf", () => {
  const NOW = 1_776_400_000;

  test("no cacheMissPct → no leaf in bar", () => {
    const bar = renderCtxSegment({
      used: 50,
      sessionStart: undefined,
      cacheMissPct: undefined,
      now: NOW,
    });
    expect(bar).not.toContain("🌿");
    expect(bar).not.toContain("🍂");
    expect(bar).not.toContain("🔥");
  });

  test("cacheMissPct below MISS_WARN → 🌿", () => {
    const bar = renderCtxSegment({
      used: 50,
      sessionStart: undefined,
      cacheMissPct: MISS_WARN - 1,
      now: NOW,
    });
    expect(bar).toContain("🌿");
  });

  test("cacheMissPct at MISS_WARN → 🍂", () => {
    const bar = renderCtxSegment({
      used: 50,
      sessionStart: undefined,
      cacheMissPct: MISS_WARN,
      now: NOW,
    });
    expect(bar).toContain("🍂");
  });

  test("cacheMissPct at MISS_CRIT → 🔥", () => {
    const bar = renderCtxSegment({
      used: 50,
      sessionStart: undefined,
      cacheMissPct: MISS_CRIT,
      now: NOW,
    });
    expect(bar).toContain("🔥");
  });

  test("leaf is a prefix and miss% appears in the bar", () => {
    const bar = renderCtxSegment({
      used: 50,
      sessionStart: undefined,
      cacheMissPct: 5,
      now: NOW,
    });
    expect(bar.startsWith("🌿")).toBe(true);
    expect(bar).toContain("5%");
    expect(bar).toContain("50%");
  });

  test("miss% appears left of used% in bar", () => {
    const bar = renderCtxSegment({
      used: 60,
      sessionStart: undefined,
      cacheMissPct: 10,
      now: NOW,
    });
    expect(bar.indexOf("10%")).toBeLessThan(bar.indexOf("60%"));
  });
});

describe("renderCtxSegment — cache TTL", () => {
  const NOW = 1_776_400_000;
  const base = {
    used: 50,
    sessionStart: undefined,
    cacheMissPct: 5,
    now: NOW,
  };

  test("live TTL → countdown right of leaf, before the bar", () => {
    const bar = renderCtxSegment({ ...base, ttlSecs: 3600, lastActivity: NOW - 60 });
    expect(bar.startsWith("🌿")).toBe(true);
    expect(bar).toContain("59m");
    expect(bar.indexOf("59m")).toBeLessThan(bar.indexOf("50%"));
  });

  test("five-minute TTL renders minutes remaining", () => {
    const bar = renderCtxSegment({ ...base, ttlSecs: 300, lastActivity: NOW - 120 });
    expect(bar).toContain("3m");
  });

  test("full hour renders as 60m, not 1h", () => {
    const bar = renderCtxSegment({ ...base, ttlSecs: 3600, lastActivity: NOW });
    expect(bar).toContain("60m");
    expect(bar).not.toContain("1h");
  });

  test("sub-minute remainder rounds up to 1m", () => {
    const bar = renderCtxSegment({ ...base, ttlSecs: 300, lastActivity: NOW - 270 });
    expect(bar).toContain("1m");
    expect(bar).not.toContain("0m");
  });

  test("past TTL → wilted leaf, no countdown", () => {
    const bar = renderCtxSegment({ ...base, ttlSecs: 3600, lastActivity: NOW - 4000 });
    expect(bar.startsWith("🥀")).toBe(true);
    expect(bar).not.toContain("🌿");
    expect(bar).not.toContain("59m");
  });

  test("wilt overrides fire leaf", () => {
    const bar = renderCtxSegment({
      ...base,
      cacheMissPct: MISS_CRIT,
      ttlSecs: 3600,
      lastActivity: NOW - 4000,
    });
    expect(bar.startsWith("🥀")).toBe(true);
    expect(bar).not.toContain("🔥");
  });

  test("no TTL info → unchanged leaf, no wilt", () => {
    const bar = renderCtxSegment(base);
    expect(bar.startsWith("🌿")).toBe(true);
    expect(bar).not.toContain("🥀");
  });

  test("no cacheMissPct → no leaf and no countdown", () => {
    const bar = renderCtxSegment({
      ...base,
      cacheMissPct: undefined,
      ttlSecs: 3600,
      lastActivity: NOW - 60,
    });
    expect(bar).not.toContain("🌿");
    expect(bar).not.toContain("59m");
  });
});

describe("renderClockGroup — minute rounding", () => {
  test("second 29 rounds down", () => {
    expect(renderClockGroup(new Date(2026, 6, 14, 13, 5, 29))).toContain("13:05");
  });

  test("second 30 rounds up", () => {
    expect(renderClockGroup(new Date(2026, 6, 14, 13, 5, 30))).toContain("13:06");
  });

  test("rounds across the hour boundary", () => {
    expect(renderClockGroup(new Date(2026, 6, 14, 13, 59, 45))).toContain("14:00");
  });

  test("rounds across midnight", () => {
    expect(renderClockGroup(new Date(2026, 6, 14, 23, 59, 40))).toContain("00:00");
  });
});

describe("limitFillTone", () => {
  test("burn undefined → base", () => {
    expect(limitFillTone(undefined, 5000, LIGHTBLUE)).toBe(LIGHTBLUE);
  });

  test("resetSecs undefined → base", () => {
    expect(limitFillTone(3000, undefined, BLUE)).toBe(BLUE);
  });

  test("burn >= resetSecs (not burning fast) → base", () => {
    expect(limitFillTone(12_000, 10_000, LIGHTBLUE)).toBe(LIGHTBLUE);
  });

  test("burn < resetSecs but above crit threshold → YELLOW", () => {
    // Burn=6000, crit=0.5*10000=5000 → 6000 >= 5000 → warn
    expect(limitFillTone(6000, 10_000, LIGHTBLUE)).toBe(YELLOW);
  });

  test("burn < resetSecs * 0.5 → RED", () => {
    // Burn=4000, crit=5000 → 4000 < 5000 → crit
    expect(limitFillTone(4000, 10_000, LIGHTBLUE)).toBe(RED);
  });

  test("burn = 0 (exhausted) → RED", () => {
    expect(limitFillTone(0, 10_000, BLUE)).toBe(RED);
  });

  test("burn exactly at crit threshold → YELLOW (not yet crit)", () => {
    expect(limitFillTone(5000, 10_000, LIGHTBLUE)).toBe(YELLOW);
  });
});

describe("missTone", () => {
  test("below MISS_CRIT → YELLOW", () => {
    expect(missTone(MISS_CRIT - 1)).toBe(YELLOW);
  });

  test("at MISS_CRIT → RED", () => {
    expect(missTone(MISS_CRIT)).toBe(RED);
  });

  test("above MISS_CRIT → RED", () => {
    expect(missTone(MISS_CRIT + 1)).toBe(RED);
  });
});

describe("fractionalBar — leading edge", () => {
  test("no leadingEdge → no Edge markers", () => {
    const bar = fractionalBar({ pct: 50, labels: [], minWidth: 8, fillTone: Fill, bgTone: Bg });
    expect(bar).not.toContain("(");
    expect(bar).not.toContain("!");
  });

  test("leadingEdge.pct=0 → no edge slice visible", () => {
    const bar = fractionalBar({
      pct: 50,
      labels: [],
      minWidth: 8,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 0, tone: Edge },
    });
    expect(bar).not.toContain("(");
    expect(bar).not.toContain("!");
  });

  test("leadingEdge.pct=100 → entire fill painted in edge tone (no Fill bg)", () => {
    const bar = fractionalBar({
      pct: 50,
      labels: [],
      minWidth: 8,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 100, tone: Edge },
    });
    expect(bar).not.toContain("[");
    expect(bar).toContain("(");
    expect(strip(bar).length).toBe(8);
  });

  test("pct=100, leadingEdge.pct=50 → first half Fill, second half Edge, no bg", () => {
    const bar = fractionalBar({
      pct: 100,
      labels: [],
      minWidth: 8,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 50, tone: Edge },
    });
    expect(bar).not.toContain("{");
    expect(bar).toContain("[");
    expect(bar).toContain("(");
    expect(strip(bar).length).toBe(8);
  });

  test("leadingEdge.pct=100, partial block uses Edge fg", () => {
    const bar = fractionalBar({
      pct: 51,
      labels: [],
      minWidth: 20,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 100, tone: Edge },
    });
    expect(bar).toContain("!▎!");
    expect(strip(bar).length).toBe(20);
  });

  test("sub-cell miss slice is visible (pct=100, leadingEdge.pct=5, minWidth=8)", () => {
    const bar = fractionalBar({
      pct: 100,
      labels: [],
      minWidth: 8,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 5, tone: Edge },
    });
    expect(bar).toContain("(");
    expect(bar).toContain("|▋|");
  });

  test("fill/edge partial block appears when miss misaligns to cell boundary", () => {
    const bar = fractionalBar({
      pct: 100,
      labels: [],
      minWidth: 10,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 41, tone: Edge },
    });
    expect(bar).toContain("(|▉|)");
  });

  test("labels still render when leadingEdge is set", () => {
    const bar = fractionalBar({
      pct: 60,
      labels: ["60%", "10%"],
      minWidth: 16,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 50, tone: Edge },
    });
    expect(strip(bar)).toContain("60%");
    expect(strip(bar)).toContain("10%");
  });

  // Sub-cell edge (edgeEighths < 8) with a fill-boundary partial present:
  // The edge zone is too small to split a boundary cell — it should appear only
  // As the fg color on the fill-boundary partial, not as a yellow-bg cell.

  test("sub-cell edge + fill partial: no edge-bg cell in fill zone", () => {
    // Pct=13 → 17 total eighths, edgeEighths=4 (sub-cell), hasPartial=true
    const bar = fractionalBar({
      pct: 13,
      labels: [],
      minWidth: 16,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 24, tone: Edge },
    });
    expect(bar).not.toContain("("); // No Edge.bg anywhere in fill zone
    expect(strip(bar).length).toBe(16);
  });

  test("sub-cell edge + fill partial: edge visible via tip fg color", () => {
    const bar = fractionalBar({
      pct: 13,
      labels: [],
      minWidth: 16,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 24, tone: Edge },
    });
    expect(bar).toContain("{!▏!}"); // Fill-boundary partial uses Edge fg
  });

  test("fill-boundary and edge-boundary collide in same cell: width preserved", () => {
    // Pct=5 → 6 total eighths, full=0, partial=6 — both boundaries land in cell 0
    const bar = fractionalBar({
      pct: 5,
      labels: [],
      minWidth: 16,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 20, tone: Edge },
    });
    expect(strip(bar).length).toBe(16);
  });

  test("near-full bar with tiny edge: edge visible only as tip fg, no edge bg", () => {
    // Pct=99 → 127 total eighths, edgeEighths=1 (sub-cell), hasPartial → no edge bg cell
    const bar = fractionalBar({
      pct: 99,
      labels: [],
      minWidth: 16,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 1, tone: Edge },
    });
    expect(bar).toContain("{!▉!}"); // Fill-boundary partial carries edge fg
    expect(bar).not.toContain("("); // No Edge.bg cells
    expect(strip(bar).length).toBe(16);
  });

  test("almost-entire edge (99%): boundary cell renders with edge bg", () => {
    // Pct=50 → 64 total eighths, edgeEighths=63, 1 fill eighth at boundary cell
    const bar = fractionalBar({
      pct: 50,
      labels: [],
      minWidth: 16,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 99, tone: Edge },
    });
    expect(bar).toContain("(|▏|)"); // Edge bg wrapping fill fg at boundary
    expect(bar).not.toContain("["); // No pure fill-bg cells
    expect(strip(bar).length).toBe(16);
  });

  test("full bar with full edge: all edge, no fill bg, no bg", () => {
    // Pct=100, edge=100 → 64 eighths, all edge, no fill or bg regions
    const bar = fractionalBar({
      pct: 100,
      labels: [],
      minWidth: 8,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 100, tone: Edge },
    });
    expect(bar).not.toContain("["); // No Fill.bg
    expect(bar).not.toContain("{"); // No Bg.bg
    expect(bar).toContain("("); // Edge.bg present
    expect(strip(bar).length).toBe(8);
  });

  test("empty bar with non-zero edge.pct: no edge codes emitted", () => {
    // Pct=0 → totalEighths=0 → edgeEighths rounds to 0 regardless of edge.pct
    const bar = fractionalBar({
      pct: 0,
      labels: [],
      minWidth: 8,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 50, tone: Edge },
    });
    expect(bar).not.toContain("("); // No Edge.bg
    expect(bar).not.toContain("!"); // No Edge.fg
    expect(strip(bar).length).toBe(8);
  });

  test("edge boundary cell and fill-boundary partial both present", () => {
    // Pct=51, edge=85, width=20 → edgeEighths=70 (>=8), hasPartial → both render
    const bar = fractionalBar({
      pct: 51,
      labels: [],
      minWidth: 20,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 85, tone: Edge },
    });
    expect(bar).toContain("["); // 1 fill-bg cell
    expect(bar).toContain("(|▌|)"); // Edge-bg boundary cell with fill fg
    expect(bar).toContain("{!▎!}"); // Fill-boundary partial with edge fg
    expect(strip(bar).length).toBe(20);
  });

  test("edge aligned with fill partial: no edge bg, edge carried as tip fg", () => {
    // Pct=8, edge=20, width=16 → totalEighths=10, edgeEighths=2, edgeStart=8 (aligned)
    const bar = fractionalBar({
      pct: 8,
      labels: [],
      minWidth: 16,
      fillTone: Fill,
      bgTone: Bg,
      leadingEdge: { pct: 20, tone: Edge },
    });
    expect(bar).toContain("["); // 1 fill-bg cell
    expect(bar).toContain("{!▎!}"); // Partial carries edge fg (EIGHTHS[2])
    expect(bar).not.toContain("("); // No Edge.bg (edgeStart % 8 === 0, sub-cell)
    expect(strip(bar).length).toBe(16);
  });
});

describe("fractionalBar — marker", () => {
  const withMarker = (pct: number, extra: Partial<Parameters<typeof fractionalBar>[0]> = {}) =>
    fractionalBar({
      pct,
      labels: [],
      minWidth: 16,
      fillTone: Fill,
      bgTone: Bg,
      marker: { pctPos: 20, tone: Marker },
      ...extra,
    });

  test("no marker when pct equals pctPos (not exceeded)", () => {
    const bar = withMarker(20);
    expect(bar).not.toContain("│");
    expect(strip(bar).length).toBe(16);
  });

  test("no marker when pct below pctPos", () => {
    expect(withMarker(10)).not.toContain("│");
  });

  test("marker appears once pct exceeds pctPos", () => {
    const bar = withMarker(50);
    expect(bar).toContain("│"); // Slim tick, not a full block
    expect(strip(bar).length).toBe(16);
  });

  test("marker draws one slim tick recolored in the marker fg over the run bg", () => {
    // Marker.fg wraps a single tick → one open + one close tilde; the underlying
    // Fill bg still wraps that one cell (no bg override → slimmer than a block).
    const bar = withMarker(50);
    expect((bar.match(/~/g) ?? []).length).toBe(2);
    expect(bar).toContain("[~│~]"); // Fill.bg wrapping Marker.fg wrapping the tick
  });

  test("marker lands at floor(pctPos% * width)", () => {
    // Width 16, pctPos 20 → cell index 3: exactly three Fill cells precede the tick.
    const bar = withMarker(50);
    expect(strip(bar).slice(0, 4)).toBe("   │");
  });

  test("marker renders even when it lands on the partial-tip cell", () => {
    // Pct 21% → full=3 with a partial tip; the 20% mark (cell 3) is that tip cell.
    const bar = withMarker(21);
    expect(bar).toContain("│");
    expect(strip(bar).length).toBe(16);
  });

  test("marker composes with a leadingEdge", () => {
    const bar = withMarker(60, { leadingEdge: { pct: 30, tone: Edge } });
    expect(bar).toContain("│"); // Marker tick present
    expect(bar).toContain("("); // Edge present
    expect(strip(bar).length).toBe(16);
  });

  test("marker reserves its cell so labels are never displaced", () => {
    const bar = withMarker(50, { labels: ["50%"], minWidth: 16 });
    expect(strip(bar)).toContain("50%");
    expect(bar).toContain("│");
  });
});

describe("renderCtxSegment — 200k marker", () => {
  const NOW = 1_776_400_000;
  const base = { sessionStart: undefined, cacheMissPct: undefined, now: NOW } as const;

  test("no markerPct leaves the segment unchanged", () => {
    expect(renderCtxSegment({ used: 50, ...base })).toBe(
      renderCtxSegment({ used: 50, ...base, markerPct: undefined }),
    );
  });

  test("markerPct with used at the threshold draws no marker", () => {
    expect(renderCtxSegment({ used: 20, ...base, markerPct: 20 })).toBe(
      renderCtxSegment({ used: 20, ...base }),
    );
  });

  test("markerPct with used past the threshold draws a slim red tick", () => {
    const withM = renderCtxSegment({ used: 50, ...base, markerPct: 20 });
    expect(withM).not.toBe(renderCtxSegment({ used: 50, ...base }));
    expect(withM).toContain("│"); // Slim tick, not a full block
    expect(withM).toContain("[31m"); // Red foreground on the fill background
  });
});
