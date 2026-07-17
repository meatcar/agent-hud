# agent-hud

Fast two-line statusline for [Claude Code](https://code.claude.com). A single bun
process, zero runtime dependencies.

- **Line 1** — model + reasoning effort, context remaining, cache hit rate,
  5h/7d rate-limit bars with burn-down ETAs, clock.
- **Line 2** — repo name, VCS drift (jj or git: branch, ahead/behind), worktree branch.

Rate limits are shared across concurrent sessions through a small on-disk DB, so
every pane shows current numbers even when only one session is receiving updates.
Idle re-renders align to the minute boundary so time-derived labels never show
stale minutes.

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

**npm / bun** (needs [bun](https://bun.com) on `PATH`):

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
