#!/usr/bin/env bash
# Regenerate screenshots/*.png and the screenshots/README.md showcase doc.
# Needs freeze + showboat (or uvx); re-execs under nix shell when missing.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v freeze >/dev/null 2>&1 || ! command -v resvg >/dev/null 2>&1 \
  || ! { command -v showboat >/dev/null 2>&1 || command -v uvx >/dev/null 2>&1; }; then
  exec nix shell nixpkgs#charm-freeze nixpkgs#resvg nixpkgs#uv --command "$0" "$@"
fi

sb() {
  if command -v showboat >/dev/null 2>&1; then showboat "$@"; else uvx showboat "$@"; fi
}

# Freeze's builtin PNG rasterizer ignores font flags and tofus nerd-font icons,
# so render SVG and rasterize with resvg pointed at a pinned nerd font.
fontdir=$(dirname "$(find "$(nix build --no-link --print-out-paths nixpkgs#nerd-fonts.jetbrains-mono)" \
  -name "JetBrainsMonoNerdFontMono-Regular.ttf" | head -1)")

state=$(mktemp -d)
ansdir=$(mktemp -d)
trap 'rm -rf "$state" "$ansdir"' EXIT

# Seed the shared DB so the bars render the cross-session merge path
now=$(date +%s)
bun -e "
  import { openDb, writeRateLimits } from './src/rate-limits.ts';
  const db = openDb('$state/shared.db');
  writeRateLimits(db, {
    version: 1,
    fiveHour: { pct: 35, resetsAt: $now + 3 * 3600 },
    sevenDay: { pct: 12, resetsAt: $now + 4 * 86400 },
  });
  db.close();
"

reset5=$(date -u -d "+3 hours" +%Y-%m-%dT%H:%M:%SZ)
reset7=$(date -u -d "+4 days" +%Y-%m-%dT%H:%M:%SZ)

mkdir -p screenshots

shot() { # $1 = name; fixture JSON on stdin
  AGENT_HUD_STATE_DIR=$state AGENT_HUD_NO_ALIGN=1 bun src/index.ts > "$ansdir/$1.ans"
  # </dev/null: freeze reads stdin over --execute when it's a non-tty
  freeze --execute "cat $ansdir/$1.ans" --font.family "JetBrainsMono Nerd Font Mono" \
    --padding 16 -o "$ansdir/$1.svg" < /dev/null
  resvg --use-fonts-dir "$fontdir" --zoom 3 "$ansdir/$1.svg" "screenshots/$1.png"
}

shot loaded <<EOF
{
  "workspace": { "project_dir": "$PWD" },
  "model": { "id": "claude-fable-5" },
  "effort": { "level": "high" },
  "session_id": "showcase",
  "transcript_path": "$state/showcase.jsonl",
  "context_window": {
    "remaining_percentage": 38,
    "current_usage": {
      "cache_read_input_tokens": 120000,
      "cache_creation_input_tokens": 4000,
      "input_tokens": 3000
    }
  },
  "rate_limits": {
    "five_hour": { "used_percentage": 63, "resets_at": "$reset5" },
    "seven_day": { "used_percentage": 41, "resets_at": "$reset7" }
  },
  "worktree": { "branch": "feature/screenshots" }
}
EOF

shot minimal <<EOF
{
  "workspace": { "project_dir": "$PWD" },
  "model": { "id": "claude-haiku-4-5" }
}
EOF

doc=screenshots/README.md
# showboat copies each image next to the doc under a uuid-date name; purge stale copies
rm -f "$doc" screenshots/????????-????-??-??.png
sb init "$doc" "agent-hud"
sb note "$doc" "A busy session: model and effort, cache miss rate, context-used bar, both rate-limit bars with reset countdowns, clock — then the repo, worktree branch, and jj drift on line two."
sb image "$doc" "![busy session](screenshots/loaded.png)"
sb note "$doc" "A second session given no rate-limit data on stdin: the bars still render, merged from the on-disk DB the first session wrote. Everything else degrades quietly — model, clock, repo."
sb image "$doc" "![sparse session, rate limits from the shared db](screenshots/minimal.png)"

chmod 644 screenshots/*.png
echo "wrote screenshots/*.png and $doc"
