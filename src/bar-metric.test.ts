import { describe, expect, test } from "bun:test";

import {
  type Zone,
  currentRendering,
  idealEighths,
  optimalRendering,
  paintedEighths,
  totalError,
} from "./bar-metric.ts";

const currentError = (pct: number, edgePct: number, width: number): number =>
  totalError(
    idealEighths(pct, edgePct, width),
    paintedEighths(currentRendering(pct, edgePct, width)),
  );

const optimalError = (pct: number, edgePct: number, width: number): number =>
  totalError(
    idealEighths(pct, edgePct, width),
    paintedEighths(optimalRendering(pct, edgePct, width)),
  );

const solidF = { bg: "F", fg: "F", kind: "solid", eighths: 0 } as const;
const solidB = { bg: "B", fg: "B", kind: "solid", eighths: 0 } as const;

describe("idealEighths", () => {
  test("50% no edge on 16-cell bar: first half F, second half B", () => {
    const ideal = idealEighths(50, 0, 16);
    expect(ideal.length).toBe(128);
    expect(ideal.slice(0, 64)).toEqual(Array.from({ length: 64 }, (): Zone => "F"));
    expect(ideal.slice(64)).toEqual(Array.from({ length: 64 }, (): Zone => "B"));
  });

  test("49% edge=4% on 16-cell bar", () => {
    const ideal = idealEighths(49, 4, 16);
    expect(ideal.length).toBe(128);
    expect(ideal.slice(0, 60)).toEqual(Array.from({ length: 60 }, (): Zone => "F"));
    expect(ideal.slice(60, 63)).toEqual(Array.from({ length: 3 }, (): Zone => "E"));
    expect(ideal.slice(63)).toEqual(Array.from({ length: 65 }, (): Zone => "B"));
  });

  test("0% no edge: all B", () => {
    expect(idealEighths(0, 0, 16)).toEqual(Array.from({ length: 128 }, (): Zone => "B"));
  });

  test("100% no edge: all F", () => {
    expect(idealEighths(100, 0, 16)).toEqual(Array.from({ length: 128 }, (): Zone => "F"));
  });

  test("100% edge=100%: all E", () => {
    expect(idealEighths(100, 100, 16)).toEqual(Array.from({ length: 128 }, (): Zone => "E"));
  });
});

describe("currentRendering geometry", () => {
  test("49% edge=4%: partial cell carries E fg, then background", () => {
    const cells = currentRendering(49, 4, 16);
    expect(cells.length).toBe(16);
    for (let ci = 0; ci < 7; ci += 1) {
      expect(cells[ci]).toEqual(solidF);
    }
    expect(cells[7]).toEqual({ bg: "B", fg: "E", kind: "leftBlock", eighths: 7 });
    for (let ci = 8; ci < 16; ci += 1) {
      expect(cells[ci]).toEqual(solidB);
    }
  });

  test("50% no edge: clean half-and-half", () => {
    const cells = currentRendering(50, 0, 16);
    expect(cells.length).toBe(16);
    for (let ci = 0; ci < 8; ci += 1) {
      expect(cells[ci]).toEqual(solidF);
    }
    for (let ci = 8; ci < 16; ci += 1) {
      expect(cells[ci]).toEqual(solidB);
    }
  });

  test("13% edge=24%: cell 1 straddles F/E boundary but is painted solid F", () => {
    const cells = currentRendering(13, 24, 16);
    expect(cells.length).toBe(16);
    expect(cells[0]).toEqual(solidF);
    expect(cells[1]).toEqual(solidF);
    expect(cells[2]).toEqual({ bg: "B", fg: "E", kind: "leftBlock", eighths: 1 });
    for (let ci = 3; ci < 16; ci += 1) {
      expect(cells[ci]).toEqual(solidB);
    }
  });
});

describe("visual error: specific cases", () => {
  test("50% no edge: no error (exact cell boundaries)", () => {
    expect(currentError(50, 0, 16)).toBe(0);
    expect(optimalError(50, 0, 16)).toBe(0);
  });

  test("49% edge=4%: current=4, optimal=2", () => {
    expect(currentError(49, 4, 16)).toBe(4);
    expect(optimalError(49, 4, 16)).toBe(2);
  });

  test("13% edge=24%: current=3, optimal=0", () => {
    expect(currentError(13, 24, 16)).toBe(3);
    expect(optimalError(13, 24, 16)).toBe(0);
  });

  test("99% edge=1%: current=6, optimal=1", () => {
    expect(currentError(99, 1, 16)).toBe(6);
    expect(optimalError(99, 1, 16)).toBe(1);
  });

  test("0% no edge: no error", () => {
    expect(currentError(0, 0, 16)).toBe(0);
    expect(optimalError(0, 0, 16)).toBe(0);
  });

  test("100% no edge: no error", () => {
    expect(currentError(100, 0, 16)).toBe(0);
    expect(optimalError(100, 0, 16)).toBe(0);
  });

  test("100% edge=100%: no error (all E)", () => {
    expect(currentError(100, 100, 16)).toBe(0);
    expect(optimalError(100, 100, 16)).toBe(0);
  });

  test("50% edge=12%: no error (edge is exactly one full cell)", () => {
    expect(currentError(50, 12, 16)).toBe(0);
    expect(optimalError(50, 12, 16)).toBe(0);
  });

  test("75% edge=8%: no error (edge is exactly one full cell)", () => {
    expect(currentError(75, 8, 16)).toBe(0);
    expect(optimalError(75, 8, 16)).toBe(0);
  });
});

describe("optimal never worse than current", () => {
  const cases: [number, number, number, string][] = [
    [0, 0, 16, "empty"],
    [13, 24, 16, "low-fill high-edge"],
    [25, 0, 16, "quarter no-edge"],
    [49, 4, 16, "user example"],
    [50, 0, 16, "half no-edge"],
    [50, 12, 16, "half aligned-edge"],
    [75, 8, 16, "three-quarter aligned-edge"],
    [99, 1, 16, "near-full tiny-edge"],
    [100, 0, 16, "full no-edge"],
    [100, 100, 16, "full all-edge"],
    [1, 50, 16, "tiny-fill half-edge"],
    [50, 50, 16, "half half-edge"],
  ];

  for (const [pct, edgePct, width, label] of cases) {
    test(`${label} (pct=${pct} edgePct=${edgePct})`, () => {
      const cur = currentError(pct, edgePct, width);
      const opt = optimalError(pct, edgePct, width);
      expect(opt).toBeLessThanOrEqual(cur);
    });
  }
});
