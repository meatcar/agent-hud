import { getNumber, getString, getStringOrNumber } from "../json.ts";
import type { StatusAdapter } from "../status.ts";

export const adaptClaudeCodeStatus: StatusAdapter = (parsed) => ({
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
