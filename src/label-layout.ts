export interface LabelLayoutOpts {
  width: number;
  labels: string[];
  reserved?: number[];
  margin?: number;
}

export const intrinsicWidthAround = (labels: string[], reserved: number[], margin = 1): number => {
  const totalChars = labels.reduce((sum, lbl) => sum + lbl.length, 0);
  return margin + margin + reserved.length + totalChars + Math.max(0, labels.length - 1);
};

const distributeGaps = (slack: number, count: number): number[] => {
  if (count === 0) {
    return [slack];
  }
  return Array.from(
    { length: count },
    (__unused, idx) => Math.floor(slack / count) + (idx < slack % count ? 1 : 0),
  );
};

const buildTakenSet = (reserved: number[], margin: number, width: number): Set<number> => {
  const taken = new Set<number>(reserved.filter((pos) => pos >= 0 && pos < width));
  for (let ii = 0; ii < margin && ii < width; ii += 1) {
    taken.add(ii);
    taken.add(width - 1 - ii);
  }
  return taken;
};

const buildRuns = (width: number, taken: Set<number>): number[][] => {
  const runs: number[][] = [];
  let run: number[] = [];
  // Iterate one past width to flush a trailing run
  for (let ii = 0; ii <= width; ii += 1) {
    if (!taken.has(ii) && ii < width) {
      run.push(ii);
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  return runs;
};

const packLabelAtRun = (
  label: string,
  positions: number[] | undefined,
  current: string[] | undefined,
): boolean => {
  if (positions === undefined || current === undefined) {
    return false;
  }
  const usedLen = current.reduce((sum, lbl) => sum + lbl.length + 1, 0);
  if (usedLen + label.length > positions.length) {
    return false;
  }
  current.push(label);
  return true;
};

const packGreedy = (labels: string[], runs: number[][], runLabels: string[][]): void => {
  let ri = 0;
  for (const label of labels) {
    while (ri < runs.length && !packLabelAtRun(label, runs[ri], runLabels[ri])) {
      ri += 1;
    }
  }
};

const packLastRight = (label: string, runs: number[][], runLabels: string[][]): void => {
  for (let li = runs.length - 1; li >= 0; li -= 1) {
    if (packLabelAtRun(label, runs[li] ?? [], runLabels[li] ?? [])) {
      break;
    }
  }
};

const packLabelsIntoRuns = (labels: string[], runs: number[][]): string[][] => {
  const runLabels: string[][] = runs.map(() => []);
  if (labels.length === 0 || runs.length === 0) {
    return runLabels;
  }
  if (labels.length === 1 || runs.length === 1) {
    packGreedy(labels, runs, runLabels);
    return runLabels;
  }
  packGreedy(labels.slice(0, -1), runs, runLabels);
  packLastRight(labels[labels.length - 1] ?? "", runs, runLabels);
  return runLabels;
};

const buildRunContent = (lbls: string[], runLen: number, rightAlign = false): string => {
  if (lbls.length === 0) {
    return " ".repeat(runLen);
  }
  const totalLen = lbls.reduce((sum, lbl) => sum + lbl.length, 0);
  const slack = runLen - totalLen;
  if (rightAlign && lbls.length === 1) {
    return " ".repeat(slack) + (lbls[0] ?? "");
  }
  const gaps = distributeGaps(slack, lbls.length - 1);
  return lbls.map((lbl, ii) => lbl + " ".repeat(gaps[ii] ?? 0)).join("");
};

const placeCharsInCells = (content: string, positions: number[], cells: string[]): void => {
  for (let ci = 0; ci < content.length && ci < positions.length; ci += 1) {
    const pos = positions[ci];
    const ch = content[ci];
    if (pos !== undefined && ch !== undefined) {
      cells[pos] = ch;
    }
  }
};

const lastFilledRun = (runLabels: string[][]): number => {
  for (let ii = runLabels.length - 1; ii >= 0; ii -= 1) {
    if ((runLabels[ii]?.length ?? 0) > 0) {
      return ii;
    }
  }
  return -1;
};

const renderRunsToString = (runLabels: string[][], runs: number[][], width: number): string => {
  const cells = Array<string>(width).fill(" ");
  const lastFilled = lastFilledRun(runLabels);
  for (let rr = 0; rr < runs.length; rr += 1) {
    const lbls = runLabels[rr];
    const positions = runs[rr];
    if (lbls === undefined || positions === undefined || lbls.length === 0) {
      continue;
    }
    const hasPrior = runLabels.slice(0, rr).some((ls) => ls.length > 0);
    placeCharsInCells(
      buildRunContent(lbls, positions.length, rr === lastFilled && hasPrior),
      positions,
      cells,
    );
  }
  return cells.join("");
};

export const layoutLabelsAround = ({
  width,
  labels,
  reserved = [],
  margin = 1,
}: LabelLayoutOpts): string => {
  if (labels.length === 0) {
    return " ".repeat(width);
  }
  const taken = buildTakenSet(reserved, margin, width);
  const runs = buildRuns(width, taken);
  const runLabels = packLabelsIntoRuns(labels, runs);
  return renderRunsToString(runLabels, runs, width);
};
