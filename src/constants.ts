export const MODEL_1M_WINDOW_TOKENS = 1_000_000;
export const MODEL_1M_MARK_TOKENS = 200_000;
export const MODEL_1M_MARKER = "[1m]";
// Position of the 200k mark as a percentage of the full 1M window (200k / 1M).
export const MODEL_1M_MARK_PCT = 20;
export const FIVE_HOUR_SECS = 18_000;
export const SEVEN_DAY_SECS = 604_800;
// Prompt-cache TTLs: 1h on subscription auth, 5m on API key / cloud providers.
// https://code.claude.com/docs/en/prompt-caching#cache-lifetime
export const TTL_5M_SECS = 300;
export const TTL_1H_SECS = 3600;
export const CTX_WARN_REMAINING = 20;
export const CTX_WARN_USED = 60;
export const CTX_CRIT_USED = 80;
export const TRANSCRIPT_SCAN_BYTES = 262_144;
export const SEC_PER_DAY = 86_400;
export const SEC_PER_HOUR = 3600;
export const SEC_PER_MIN = 60;
export const PERCENT = 100;
export const CLOCK_PAD = 2;
export const MS_PER_SEC = 1000;
export const MS_PER_MIN = 60_000;
export const STATE_VERSION = 1;

// Shared-state GC: sweep at most daily, drop session leftovers after 30 days.
export const GC_INTERVAL_SECS = SEC_PER_DAY;
export const GC_MAX_AGE_DAYS = 30;
export const GC_MAX_AGE_SECS = GC_MAX_AGE_DAYS * SEC_PER_DAY;

// Powerline separators
export const PL_HARD_R = "\uE0B0"; //
export const PL_SOFT_R = "\uE0B1"; //
export const PL_LOWER_R = "\uE0BC"; //
export const PL_LOWER_R_THIN = "\uE0BD"; //
export const PL_CAP_L = "\uE0B6"; //  (rounded left)
export const PL_CAP_R = "\uE0B4"; //  (rounded right)

// Nerd Font icons
export const ICON_MISS = "\uDB80\uDF2A"; // 󰌪
export const ICON_5H = "5h";
export const ICON_7D = "7d";
export const ICON_CLOCK = "\uF017"; //

// Bar widths
export const CTX_BAR_WIDTH = 16;
export const LIMIT_BAR_WIDTH = 16;
// Max cells a bar may grow past its intrinsic width hunting for a label fit;
// Past that, render with clipped labels instead of looping forever.
export const MAX_BAR_GROWTH = 64;

// Rate limit burn-rate thresholds (ratio of burn ETA to remaining window time)
export const LIMIT_WARN_BURN_RATIO = 1; // Burn ETA < remaining → yellow
export const LIMIT_CRIT_BURN_RATIO = 0.5; // Burn ETA < half remaining → red

// Miss % severity thresholds
export const MISS_WARN = 20;
export const MISS_CRIT = 50;

// Cache leaf past its TTL
export const ICON_WILTED = "🥀";

// Bar rendering
export const BAR_SIDE_MARGIN = 0;
export const BAR_MARGIN = BAR_SIDE_MARGIN + BAR_SIDE_MARGIN;
export const EIGHTHS_PER_CELL = 8;
export const EIGHTHS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
// Slim vertical tick for the 200k boundary marker — a gridline, not a full block.
export const MARKER_TICK = "│";
