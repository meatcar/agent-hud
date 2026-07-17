#!/usr/bin/env bash
# Regenerate screenshots/loaded.png (the README screenshot) via vhs.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v vhs >/dev/null 2>&1 || ! command -v ffmpeg >/dev/null 2>&1; then
  exec nix shell nixpkgs#vhs nixpkgs#ffmpeg --command "$0" "$@"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# vhs renders in a browser; expose the nerd font to fontconfig via XDG_DATA_HOME
fontdir=$(dirname "$(find "$(nix build --no-link --print-out-paths nixpkgs#nerd-fonts.iosevka)" \
  -name "IosevkaNerdFontMono-Regular.ttf" | head -1)")
mkdir -p "$tmp/share/fonts"
cp "$fontdir"/*.ttf "$tmp/share/fonts/"
export XDG_DATA_HOME="$tmp/share"

# Seed the shared DB so the bars render the cross-session merge path
mkdir -p "$tmp/state"
now=$(date +%s)
bun -e "
  import { openDb, writeRateLimits } from './src/rate-limits.ts';
  const db = openDb('$tmp/state/shared.db');
  writeRateLimits(db, {
    version: 1,
    fiveHour: { pct: 35, resetsAt: $now + 3 * 3600 },
    sevenDay: { pct: 12, resetsAt: $now + 4 * 86400 },
  });
  db.close();
"

reset5=$(date -u -d "+3 hours" +%Y-%m-%dT%H:%M:%SZ)
reset7=$(date -u -d "+4 days" +%Y-%m-%dT%H:%M:%SZ)

# The vhs shell inherits these, so the tape can run the command as-is
export AGENT_HUD_STATE_DIR=$tmp/state AGENT_HUD_NO_ALIGN=1

cat >"$tmp/fixture.json" <<EOF
{
  "workspace": { "project_dir": "$PWD" },
  "model": { "id": "claude-fable-5[1m]" },
  "effort": { "level": "high" },
  "session_id": "showcase",
  "transcript_path": "$tmp/state/showcase.jsonl",
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

mkdir -p screenshots
cat >"$tmp/showcase.tape" <<EOF
Output "$tmp/showcase.gif"
Set Theme "Catppuccin Mocha"
Set FontFamily "Iosevka Nerd Font Mono"
Set FontSize 16
Set WindowBar Colorful
Set BorderRadius 8
Set Padding 4
Set Width 900
Set Height 120
Type "clear && bun src/index.ts < $tmp/fixture.json && sleep 30"
Enter
Sleep 2s
EOF
vhs "$tmp/showcase.tape"

# vhs's Screenshot command is a no-op and raw frames lack the window chrome;
# the composited look only exists in the gif, so take its last frame
mkdir -p "$tmp/frames"
ffmpeg -loglevel error -i "$tmp/showcase.gif" -vsync 0 "$tmp/frames/%05d.png"
cp "$(ls "$tmp/frames"/*.png | tail -1)" screenshots/loaded.png

chmod 644 screenshots/loaded.png
echo "wrote screenshots/loaded.png"
