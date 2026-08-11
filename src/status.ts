export interface StatusSnapshot {
  projectDir: string | undefined;
  modelId: string | undefined;
  effort: string | undefined;
  vimMode: string | undefined;
  transcriptPath: string | undefined;
  worktreeBranch: string | undefined;
  remainingPct: number | undefined;
  cacheRead: number | undefined;
  cacheCreation: number | undefined;
  inputTokens: number | undefined;
  fiveHourPct: number | undefined;
  fiveHourReset: string | number | undefined;
  sevenDayPct: number | undefined;
  sevenDayReset: string | number | undefined;
}

export type StatusAdapter = (input: unknown) => StatusSnapshot;
