import { basename } from "node:path";

import type { AgentHudConfig } from "./config.ts";
import {
  type RenderSectionsParams,
  type SectionName,
  isSectionName,
  renderLayoutLine,
  renderSections,
} from "./fields.ts";
import { cacheHitPct } from "./helpers.ts";
import type { RateLimitsV1, SessionInfo } from "./rate-limits.ts";
import type { StatusSnapshot } from "./status.ts";

export const parseStatusJson = (input: string): unknown => {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error("Invalid statusline JSON");
  }
};

export const parseSectionArgs = (args: readonly string[]): SectionName[] | undefined => {
  if (args.length === 0) return undefined;
  const unknown = args.find((arg) => !isSectionName(arg));
  if (unknown !== undefined) throw new Error(`Unknown section: ${unknown}`);
  return args.filter(isSectionName);
};

export interface DerivedSession {
  sessionId: string | undefined;
  session: SessionInfo | undefined;
}

export const deriveSession = (status: StatusSnapshot): DerivedSession => {
  const sessionId = status.transcriptPath ? basename(status.transcriptPath, ".jsonl") : undefined;
  const hitPct = cacheHitPct(status.cacheRead, status.cacheCreation, status.inputTokens);
  const fingerprint = `${status.cacheRead}:${status.cacheCreation}:${status.inputTokens}`;
  const session =
    sessionId !== undefined && hitPct !== undefined ? { sessionId, fingerprint } : undefined;
  return { sessionId, session };
};

export const flattenRateLimits = (
  rateLimits: RateLimitsV1,
): Pick<StatusSnapshot, "fiveHourPct" | "fiveHourReset" | "sevenDayPct" | "sevenDayReset"> => ({
  fiveHourPct: rateLimits.fiveHour?.pct,
  fiveHourReset: rateLimits.fiveHour?.resetsAt,
  sevenDayPct: rateLimits.sevenDay?.pct,
  sevenDayReset: rateLimits.sevenDay?.resetsAt,
});

const fingerprintStatus = (status: StatusSnapshot): StatusSnapshot => ({
  projectDir: status.projectDir,
  modelId: status.modelId,
  effort: status.effort,
  vimMode: status.vimMode,
  transcriptPath: status.transcriptPath,
  worktreeBranch: status.worktreeBranch,
  remainingPct: status.remainingPct,
  cacheRead: status.cacheRead,
  cacheCreation: status.cacheCreation,
  inputTokens: status.inputTokens,
  fiveHourPct: status.fiveHourPct,
  fiveHourReset: status.fiveHourReset,
  sevenDayPct: status.sevenDayPct,
  sevenDayReset: status.sevenDayReset,
});

export const contentFingerprint = (
  status: StatusSnapshot,
  line2: string,
  config: AgentHudConfig | undefined,
  custom: ReadonlyMap<string, string>,
): string =>
  JSON.stringify({
    fields: fingerprintStatus(status),
    line2,
    configuredLayout: config?.layout,
    custom: [...custom.values()],
  });

export const selectOutput = (
  params: RenderSectionsParams,
  cliSections: readonly SectionName[] | undefined,
  config: AgentHudConfig | undefined,
  custom: ReadonlyMap<string, string>,
  defaultOutput: string,
): string => {
  if (cliSections !== undefined) return renderSections(params, cliSections);
  if (config !== undefined) {
    return config.layout.map((items) => renderLayoutLine(params, custom, items)).join("\n");
  }
  return defaultOutput;
};
