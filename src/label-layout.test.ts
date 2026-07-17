import { describe, expect, test } from "bun:test";

import { intrinsicWidthAround, layoutLabelsAround } from "./label-layout.ts";

describe("layoutLabelsAround — basic", () => {
  test("empty labels returns spaces of correct width", () => {
    expect(layoutLabelsAround({ width: 10, labels: [] })).toBe(" ".repeat(10));
  });

  test("output length always equals width", () => {
    expect(layoutLabelsAround({ width: 16, labels: ["50%", "2h"] }).length).toBe(16);
  });

  test("no reserved: single label left-aligned after margin", () => {
    const result = layoutLabelsAround({ width: 12, labels: ["50%"], margin: 1 });
    expect(result.length).toBe(12);
    expect(result.startsWith(" 50%")).toBe(true);
  });

  test("no reserved: two labels space-between (first at start, last at end)", () => {
    const result = layoutLabelsAround({ width: 12, labels: ["AAA", "ZZZ"], margin: 1 });
    expect(result.startsWith(" AAA")).toBe(true);
    expect(result.endsWith("ZZZ ")).toBe(true);
  });

  test("margin=0: labels can use all cells including edges", () => {
    const result = layoutLabelsAround({ width: 6, labels: ["AB"], margin: 0 });
    expect(result.startsWith("AB")).toBe(true);
  });
});

describe("layoutLabelsAround — reserved cells", () => {
  test("reserved cell in output is always a space", () => {
    const result = layoutLabelsAround({ width: 12, labels: ["A", "B"], reserved: [6], margin: 1 });
    expect(result[6]).toBe(" ");
    expect(result.length).toBe(12);
  });

  test("label pushed to right run does not straddle reserved cell", () => {
    const result = layoutLabelsAround({ width: 16, labels: ["ABCDE"], reserved: [4], margin: 1 });
    const pos = result.indexOf("ABCDE");
    expect(pos).toBeGreaterThan(4);
    expect(result[4]).toBe(" ");
  });

  test("label that fits in left run does not cross reserved cell", () => {
    const result = layoutLabelsAround({ width: 14, labels: ["AB"], reserved: [6], margin: 1 });
    const pos = result.indexOf("AB");
    expect(pos).toBeGreaterThanOrEqual(1);
    expect(pos + "AB".length - 1).toBeLessThan(6);
  });

  test("reserved at position 0: labels begin at position 1 or later", () => {
    const result = layoutLabelsAround({ width: 10, labels: ["XY"], reserved: [0], margin: 0 });
    expect(result[0]).toBe(" ");
    const pos = result.indexOf("XY");
    expect(pos).toBeGreaterThan(0);
  });

  test("reserved at last position: labels end before it", () => {
    const result = layoutLabelsAround({ width: 10, labels: ["XY"], reserved: [9], margin: 0 });
    expect(result[9]).toBe(" ");
    const pos = result.indexOf("XY");
    expect(pos + "XY".length - 1).toBeLessThan(9);
  });

  test("multiple reserved cells: all are spaces and labels avoid them all", () => {
    const result = layoutLabelsAround({
      width: 20,
      labels: ["AA", "BB"],
      reserved: [5, 12],
      margin: 1,
    });
    expect(result[5]).toBe(" ");
    expect(result[12]).toBe(" ");
    expect(result.length).toBe(20);
    const posA = result.indexOf("AA");
    const posB = result.indexOf("BB");
    expect(posA).not.toBe(-1);
    expect(posB).not.toBe(-1);
    for (const pos of [posA, posA + 1, posB, posB + 1]) {
      expect([5, 12].includes(pos)).toBe(false);
    }
  });
});

describe("layoutLabelsAround — split labels alignment", () => {
  test("last label pushed to right run: right-aligns (41% case)", () => {
    // Pct≈41%: partial block at pos 6, run0=[1-5], run1=[7-14]
    // "41%" doesn't leave room for "38m" in run0, so "38m" is pushed to run1
    const result = layoutLabelsAround({
      width: 16,
      labels: ["41%", "38m"],
      reserved: [6],
      margin: 1,
    });
    expect(result.length).toBe(16);
    expect(result[6]).toBe(" ");
    expect(result.startsWith(" 41%")).toBe(true);
    expect(result.endsWith("38m ")).toBe(true);
  });

  test("last label fits in left run but is placed in right run instead (51% case)", () => {
    // Pct≈51%: partial block at pos 8, run0=[1-7] (7 positions), run1=[9-14] (6 positions)
    // Both "51%" and "29m" fit in run0, but "29m" should be placed in run1
    const result = layoutLabelsAround({
      width: 16,
      labels: ["51%", "29m"],
      reserved: [8],
      margin: 1,
    });
    expect(result.length).toBe(16);
    expect(result[8]).toBe(" ");
    expect(result.startsWith(" 51%")).toBe(true);
    expect(result.endsWith("29m ")).toBe(true);
  });

  test("single label with no prior run: stays left-aligned", () => {
    // Only one run — no split — left-align as before
    const result = layoutLabelsAround({ width: 12, labels: ["50%"], margin: 1 });
    expect(result.startsWith(" 50%")).toBe(true);
  });

  test("two labels single run (no reserved): space-between unchanged", () => {
    const result = layoutLabelsAround({ width: 12, labels: ["AAA", "ZZZ"], margin: 1 });
    expect(result.startsWith(" AAA")).toBe(true);
    expect(result.endsWith("ZZZ ")).toBe(true);
  });
});

describe("intrinsicWidthAround", () => {
  test("no labels, no reserved: just two margin cells", () => {
    expect(intrinsicWidthAround([], [], 1)).toBe(2);
  });

  test("no labels, one reserved: margins + reserved count", () => {
    expect(intrinsicWidthAround([], [3], 1)).toBe(3);
  });

  test("single label: label length + reserved count + margins", () => {
    expect(intrinsicWidthAround(["AB"], [0], 1)).toBe(5);
  });

  test("two labels: label lengths + one separator + reserved count + margins", () => {
    expect(intrinsicWidthAround(["AB", "CD"], [0], 1)).toBe(8);
  });

  test("no reserved: labels + separators + margins", () => {
    expect(intrinsicWidthAround(["X", "Y", "Z"], [], 1)).toBe(7);
  });
});
