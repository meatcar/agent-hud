import {
  CLOCK_PAD,
  MODEL_1M_MARKER,
  MODEL_1M_WINDOW_TOKENS,
  MS_PER_MIN,
  MS_PER_SEC,
  PERCENT,
  SEC_PER_DAY,
  SEC_PER_HOUR,
  SEC_PER_MIN,
} from "./constants.ts";

export const msToNextMinute = (nowMs: number): number =>
  (MS_PER_MIN - (nowMs % MS_PER_MIN)) % MS_PER_MIN;

export const pad2 = (num: number): string => String(num).padStart(CLOCK_PAD, "0");

export const formatDuration = (seconds: number | undefined): string | undefined => {
  if (seconds === undefined || Number.isNaN(seconds)) {
    return undefined;
  }
  if (seconds < SEC_PER_MIN) {
    return "now";
  }
  const days = Math.floor(seconds / SEC_PER_DAY);
  if (days > 0) {
    return `${days}d`;
  }
  const hours = Math.floor((seconds % SEC_PER_DAY) / SEC_PER_HOUR);
  const minutes = Math.floor((seconds % SEC_PER_HOUR) / SEC_PER_MIN);
  return hours > 0 ? `${hours}h${pad2(minutes)}m` : `${minutes}m`;
};

export const burnSeconds = (
  pct: number | undefined,
  elapsed: number | undefined,
): number | undefined => {
  if (pct === undefined || elapsed === undefined) {
    return undefined;
  }
  if (pct <= 0 || elapsed <= 0) {
    return undefined;
  }
  const rem = PERCENT - pct;
  if (rem <= 0) {
    return 0;
  }
  return Math.round((rem * elapsed) / pct);
};

export const toEpoch = (value: string | number | undefined): number | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number") {
    return Math.floor(value);
  }
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / MS_PER_SEC);
};

const tokenTotal = (read: number, creation: number, input: number): number =>
  read + creation + input;

export const computeUsed = (
  remainingPct: number | undefined,
  modelId: string | undefined,
  tokens: { cacheRead?: number; cacheCreation?: number; input?: number } | undefined,
): number | undefined => {
  if (
    modelId?.includes(MODEL_1M_MARKER) &&
    tokens?.cacheRead !== undefined &&
    tokens.cacheCreation !== undefined &&
    tokens.input !== undefined
  ) {
    const total = tokenTotal(tokens.cacheRead, tokens.cacheCreation, tokens.input);
    return Math.round(Math.min(PERCENT, (total * PERCENT) / MODEL_1M_WINDOW_TOKENS));
  }
  if (remainingPct === undefined) {
    return undefined;
  }
  return Math.round(PERCENT - remainingPct);
};

export const cacheHitPct = (
  read: number | undefined,
  creation: number | undefined,
  input: number | undefined,
): number | undefined => {
  if (read === undefined || creation === undefined || input === undefined) {
    return undefined;
  }
  const total = tokenTotal(read, creation, input);
  if (total <= 0) {
    return undefined;
  }
  return Math.round((read * PERCENT) / total);
};
