# agent-hud

Fast two-line statusline for [Claude Code](https://code.claude.com). One bun
process, zero dependencies.

- Shows the model and its reasoning effort
- Shows how much context is left and the cache hit rate
- Bars for the 5-hour and 7-day rate limits, with time until you hit them
- Clock
- Repo name, branch, and how far you are from trunk (jj and git)
- Sessions share rate-limit numbers through a small on-disk DB, so every pane
  stays current even when only one is talking to the API
- Idle refreshes wait for the minute to tick over, so the clock is never stale

## Install

**Nix:**

```sh
nix run github:meatcar/agent-hud
```

**Homebrew:**

```sh
brew tap oven-sh/bun # bun is not in homebrew-core
brew tap meatcar/tap https://github.com/meatcar/homebrew-tap
brew trust oven-sh/bun # non-interactive shells only;
brew trust meatcar/tap # interactive brew prompts instead
brew install --HEAD meatcar/tap/agent-hud
```

**npm / bun:**

```sh
bun install -g @meatcar/agent-hud
```

**Git:**

```sh
git clone https://github.com/meatcar/agent-hud.git && cd agent-hud && bun link
```

## Setup

Point Claude Code at it in `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "agent-hud" }
}
```

It reads the statusline JSON Claude Code writes to stdin and prints two ANSI lines.
Try it by hand:

```sh
echo '{}' | agent-hud
```

## Environment

| Var                  | Effect                                                 |
| -------------------- | ------------------------------------------------------ |
| `AGENT_HUD_STATE_DIR`| State location (default `~/.claude/agent-hud-state`)   |
| `AGENT_HUD_NO_ALIGN` | Skip sleeping to the minute boundary on idle re-renders|
| `NO_COLOR`           | Disable ANSI colors                                    |

## Development

```sh
bun test
bun run check   # tsc --noEmit
bun run bench   # hyperfine comparison, see bench/run.sh
```

## License

MIT
