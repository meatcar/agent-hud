import colors from "./colors.ts";

import {
  FIVE_HOUR_SECS,
  MODEL_1M_MARKER,
  MODEL_1M_MARK_PCT,
  PERCENT,
  SEVEN_DAY_SECS,
} from "./constants.ts";
import { cacheHitPct, computeUsed } from "./helpers.ts";
import { getNumber, getString, getStringOrNumber } from "./json.ts";
import { renderClockGroup, renderCtxSegment, renderRateLimitsGroup } from "./powerline.ts";
import { buildVimPrefix } from "./render.ts";

export interface Fields {
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

export const extractFields = (parsed: unknown): Fields => ({
  projectDir: getString(parsed, "workspace", "project_dir"),
  modelId: getString(parsed, "model", "id")?.replace(/^claude-/, ""),
  effort: getString(parsed, "effort", "level"),
  vimMode: getString(parsed, "vim", "mode"),
  transcriptPath: getString(parsed, "transcript_path") || undefined,
  worktreeBranch: getString(parsed, "worktree", "branch"),
  remainingPct: getNumber(parsed, "context_window", "remaining_percentage"),
  cacheRead: getNumber(parsed, "context_window", "current_usage", "cache_read_input_tokens"),
  cacheCreation: getNumber(
    parsed,
    "context_window",
    "current_usage",
    "cache_creation_input_tokens",
  ),
  inputTokens: getNumber(parsed, "context_window", "current_usage", "input_tokens"),
  fiveHourPct: getNumber(parsed, "rate_limits", "five_hour", "used_percentage"),
  fiveHourReset: getStringOrNumber(parsed, "rate_limits", "five_hour", "resets_at"),
  sevenDayPct: getNumber(parsed, "rate_limits", "seven_day", "used_percentage"),
  sevenDayReset: getStringOrNumber(parsed, "rate_limits", "seven_day", "resets_at"),
});

export interface Line1Params extends Fields {
  sessionStart: number | undefined;
  now: number;
  ttlSecs: number | undefined;
  lastActivity: number | undefined;
}

export const buildLine1 = (params: Line1Params): string => {
  const used = computeUsed(params.remainingPct, params.modelId, {
    cacheRead: params.cacheRead,
    cacheCreation: params.cacheCreation,
    input: params.inputTokens,
  });
  const hitPct = cacheHitPct(params.cacheRead, params.cacheCreation, params.inputTokens);
  const cacheMissPct = hitPct !== undefined ? PERCENT - hitPct : undefined;

  const hd =
    buildVimPrefix(params.vimMode) +
    (params.modelId ? colors.cyan(params.modelId) : "") +
    (params.effort ? ` ${colors.dim(params.effort)}` : "");

  const ctxSeg = renderCtxSegment({
    used,
    sessionStart: params.sessionStart,
    cacheMissPct,
    now: params.now,
    markerPct: params.modelId?.includes(MODEL_1M_MARKER) ? MODEL_1M_MARK_PCT : undefined,
    ttlSecs: params.ttlSecs,
    lastActivity: params.lastActivity,
  });

  const limSeg = renderRateLimitsGroup({
    five: {
      pct: params.fiveHourPct,
      resetAt: params.fiveHourReset,
      windowSecs: FIVE_HOUR_SECS,
      now: params.now,
    },
    seven: {
      pct: params.sevenDayPct,
      resetAt: params.sevenDayReset,
      windowSecs: SEVEN_DAY_SECS,
      now: params.now,
    },
  });

  const clkSeg = renderClockGroup(new Date());

  return `${hd} ${ctxSeg}  ${limSeg}  ${clkSeg}`;
};

export interface Line2Params {
  repoOut: string;
  driftOut: string;
  worktreeBranch: string | undefined;
}

export const buildLine2 = (params: Line2Params): string => {
  const wt = params.worktreeBranch ? colors.dim(`[${params.worktreeBranch}]`) : "";
  const parts = [params.repoOut, wt, params.driftOut].filter((part) => part !== "");
  return parts.join(" ");
};
