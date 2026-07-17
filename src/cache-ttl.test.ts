import { describe, expect, test } from "bun:test";

import { resolveTtlSecs } from "./cache-ttl.ts";
import { TTL_1H_SECS, TTL_5M_SECS } from "./constants.ts";
import type { RateLimitsV1 } from "./rate-limits.ts";

const NO_LIMITS: RateLimitsV1 = { version: 1, fiveHour: undefined, sevenDay: undefined };
const SUB_LIMITS: RateLimitsV1 = {
  version: 1,
  fiveHour: { pct: 40, resetsAt: 2_000_000 },
  sevenDay: { pct: 18, resetsAt: 3_000_000 },
};

describe("resolveTtlSecs", () => {
  test("no env, no rate limits → 5m (API key / provider)", () => {
    expect(resolveTtlSecs({}, NO_LIMITS)).toBe(TTL_5M_SECS);
  });

  test("no env, subscription rate limits present → 1h", () => {
    expect(resolveTtlSecs({}, SUB_LIMITS)).toBe(TTL_1H_SECS);
  });

  test("only seven-day bucket present → 1h", () => {
    expect(
      resolveTtlSecs({}, { version: 1, fiveHour: undefined, sevenDay: SUB_LIMITS.sevenDay }),
    ).toBe(TTL_1H_SECS);
  });

  test("DISABLE_PROMPT_CACHING → undefined even on subscription", () => {
    expect(resolveTtlSecs({ DISABLE_PROMPT_CACHING: "1" }, SUB_LIMITS)).toBeUndefined();
  });

  test("FORCE_PROMPT_CACHING_5M beats ENABLE_PROMPT_CACHING_1H and subscription", () => {
    expect(
      resolveTtlSecs({ FORCE_PROMPT_CACHING_5M: "1", ENABLE_PROMPT_CACHING_1H: "1" }, SUB_LIMITS),
    ).toBe(TTL_5M_SECS);
  });

  test("ENABLE_PROMPT_CACHING_1H without subscription → 1h", () => {
    expect(resolveTtlSecs({ ENABLE_PROMPT_CACHING_1H: "1" }, NO_LIMITS)).toBe(TTL_1H_SECS);
  });

  test("window at 100% → 5m (drawing on usage credits)", () => {
    const maxed: RateLimitsV1 = {
      version: 1,
      fiveHour: { pct: 100, resetsAt: 2_000_000 },
      sevenDay: SUB_LIMITS.sevenDay,
    };
    expect(resolveTtlSecs({}, maxed)).toBe(TTL_5M_SECS);
  });

  test("env value '0' or '' treated as unset", () => {
    expect(
      resolveTtlSecs({ DISABLE_PROMPT_CACHING: "0", FORCE_PROMPT_CACHING_5M: "" }, SUB_LIMITS),
    ).toBe(TTL_1H_SECS);
  });
});
