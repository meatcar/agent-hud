import { EIGHTHS_PER_CELL, PERCENT } from "./constants.ts";

export type Zone = "F" | "E" | "B";
export type BlockKind = "solid" | "leftBlock" | "rightBlock";

export interface CellSpec {
  bg: Zone;
  fg: Zone;
  kind: BlockKind;
  eighths: number;
}

export type Weights = Record<Zone, Record<Zone, number>>;

const DEFAULT_WEIGHTS: Weights = {
  F: { F: 0, E: 1, B: 2 },
  E: { F: 1, E: 0, B: 2 },
  B: { F: 2, E: 2, B: 0 },
};

const ZONES: Zone[] = ["F", "E", "B"];

export const idealEighths = (pct: number, edgePct: number, width: number): Zone[] => {
  const totalEighths = Math.round((pct * width * EIGHTHS_PER_CELL) / PERCENT);
  const edgeEighths = edgePct > 0 ? Math.round((edgePct * totalEighths) / PERCENT) : 0;
  const edgeStart = totalEighths - edgeEighths;
  return Array.from({ length: width * EIGHTHS_PER_CELL }, (__unused, ii): Zone => {
    if (ii < edgeStart) {
      return "F";
    }
    if (ii < totalEighths) {
      return "E";
    }
    return "B";
  });
};

const cellPaintedEighths = ({ bg, fg, kind, eighths }: CellSpec): Zone[] => {
  if (kind === "solid") {
    return Array.from({ length: EIGHTHS_PER_CELL }, (): Zone => bg);
  }
  const fgRun = Array.from({ length: eighths }, (): Zone => fg);
  const bgRun = Array.from({ length: EIGHTHS_PER_CELL - eighths }, (): Zone => bg);
  return kind === "leftBlock" ? [...fgRun, ...bgRun] : [...bgRun, ...fgRun];
};

export const paintedEighths = (cells: CellSpec[]): Zone[] => cells.flatMap(cellPaintedEighths);

export const totalError = (
  ideal: Zone[],
  painted: Zone[],
  weights: Weights = DEFAULT_WEIGHTS,
): number => {
  let sum = 0;
  for (let ii = 0; ii < ideal.length && ii < painted.length; ii += 1) {
    sum += weights[ideal[ii] ?? "B"][painted[ii] ?? "B"];
  }
  return sum;
};

const BLOCK_ORDER: Record<BlockKind, number> = {
  solid: 0,
  leftBlock: EIGHTHS_PER_CELL,
  rightBlock: EIGHTHS_PER_CELL * EIGHTHS_PER_CELL,
};

const specOrder = (spec: CellSpec): number => BLOCK_ORDER[spec.kind] + spec.eighths;

const tryAllCandidates = (trySpec: (spec: CellSpec) => void): void => {
  for (const zone of ZONES) {
    trySpec({ bg: zone, fg: zone, kind: "solid", eighths: 0 });
  }
  for (const kind of ["leftBlock", "rightBlock"] as BlockKind[]) {
    for (const fg of ZONES) {
      for (const bg of ZONES) {
        if (fg === bg) {
          continue;
        }
        for (let ke = 1; ke < EIGHTHS_PER_CELL; ke += 1) {
          trySpec({ bg, fg, kind, eighths: ke });
        }
      }
    }
  }
};

const optimalCell = (idealCell: Zone[], weights: Weights = DEFAULT_WEIGHTS): CellSpec => {
  let bestSpec: CellSpec = { bg: "B", fg: "B", kind: "solid", eighths: 0 };
  let bestError = Infinity;

  tryAllCandidates((spec) => {
    const painted = cellPaintedEighths(spec);
    let err = 0;
    for (let ii = 0; ii < EIGHTHS_PER_CELL; ii += 1) {
      err += weights[idealCell[ii] ?? "B"][painted[ii] ?? "B"];
    }
    if (err < bestError || (err === bestError && specOrder(spec) < specOrder(bestSpec))) {
      bestError = err;
      bestSpec = spec;
    }
  });

  return bestSpec;
};

export const optimalRendering = (
  pct: number,
  edgePct: number,
  width: number,
  weights: Weights = DEFAULT_WEIGHTS,
): CellSpec[] => {
  const ideal = idealEighths(pct, edgePct, width);
  return Array.from({ length: width }, (__unused, ci) =>
    optimalCell(ideal.slice(ci * EIGHTHS_PER_CELL, (ci + 1) * EIGHTHS_PER_CELL), weights),
  );
};

const computeEdgeSolidStart = (
  edgeBoundaryCell: number,
  edgeEighths: number,
  hasPartial: boolean,
  edgeStart: number,
  full: number,
): number => {
  if (edgeBoundaryCell >= 0) {
    return edgeBoundaryCell + 1;
  }
  if (edgeEighths >= EIGHTHS_PER_CELL || !hasPartial) {
    return Math.floor(edgeStart / EIGHTHS_PER_CELL);
  }
  return full;
};

export const currentRendering = (pct: number, edgePct: number, width: number): CellSpec[] => {
  const totalEighths = Math.round((pct * width * EIGHTHS_PER_CELL) / PERCENT);
  const full = Math.floor(totalEighths / EIGHTHS_PER_CELL);
  const partial = totalEighths % EIGHTHS_PER_CELL;
  const hasPartial = partial > 0 && full < width;
  const hasEdge = edgePct > 0;
  const edgeEighths = hasEdge ? Math.round((edgePct * totalEighths) / PERCENT) : 0;
  const edgeStart = totalEighths - edgeEighths;

  const edgeBoundaryCell =
    hasEdge &&
    edgeEighths > 0 &&
    edgeStart % EIGHTHS_PER_CELL !== 0 &&
    (edgeEighths >= EIGHTHS_PER_CELL || !hasPartial)
      ? Math.floor(edgeStart / EIGHTHS_PER_CELL)
      : -1;

  const edgeSolidStart = computeEdgeSolidStart(
    edgeBoundaryCell,
    edgeEighths,
    hasPartial,
    edgeStart,
    full,
  );
  const fillEnd = edgeBoundaryCell >= 0 ? edgeBoundaryCell : edgeSolidStart;
  const cells: CellSpec[] = [];

  for (let ci = 0; ci < fillEnd; ci += 1) {
    cells.push({ bg: "F", fg: "F", kind: "solid", eighths: 0 });
  }

  if (edgeBoundaryCell >= 0) {
    cells.push({ bg: "E", fg: "F", kind: "leftBlock", eighths: edgeStart % EIGHTHS_PER_CELL });
  }

  for (let ci = edgeSolidStart; ci < full; ci += 1) {
    cells.push({ bg: "E", fg: "E", kind: "solid", eighths: 0 });
  }

  if (hasPartial) {
    const fg: Zone = hasEdge && edgeEighths > 0 ? "E" : "F";
    cells.push({ bg: "B", fg, kind: "leftBlock", eighths: partial });
  }

  for (let ci = full + (hasPartial ? 1 : 0); ci < width; ci += 1) {
    cells.push({ bg: "B", fg: "B", kind: "solid", eighths: 0 });
  }

  return cells;
};
