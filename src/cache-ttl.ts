import { PERCENT, TTL_1H_SECS, TTL_5M_SECS } from "./constants.ts";
import type { RateLimitsV1 } from "./rate-limits.ts";

type Env = Record<string, string | undefined>;

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== "" && value !== "0";

// Infer the prompt-cache TTL Claude Code negotiated for this session.
// Env overrides are inherited from the Claude Code process; rate_limits only
// Appear on stdin for subscription auth, which gets the 1h TTL automatically.
// A maxed window means usage credits, which drop the TTL back to 5m.
// https://code.claude.com/docs/en/prompt-caching#cache-lifetime
export const resolveTtlSecs = (env: Env, limits: RateLimitsV1): number | undefined => {
  if (isSet(env.DISABLE_PROMPT_CACHING)) {
    return undefined;
  }
  if (isSet(env.FORCE_PROMPT_CACHING_5M)) {
    return TTL_5M_SECS;
  }
  if (isSet(env.ENABLE_PROMPT_CACHING_1H)) {
    return TTL_1H_SECS;
  }
  if (limits.fiveHour === undefined && limits.sevenDay === undefined) {
    return TTL_5M_SECS;
  }
  const onCredits = [limits.fiveHour, limits.sevenDay].some(
    (bucket) => bucket !== undefined && bucket.pct >= PERCENT,
  );
  return onCredits ? TTL_5M_SECS : TTL_1H_SECS;
};
