#!/usr/bin/env bash
# Run hyperfine bench (bash vs bun) and save results to bench/results/<iso8601>/
set -euo pipefail

cd "$(dirname "$0")/.."

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
out="bench/results/$ts"
mkdir -p "$out"

bun_state=$(mktemp -d)
trap 'rm -rf "$bun_state"' EXIT

# Pre-seed shared DB so bench measures the read+merge+skip path (common case)
bun -e "
  import { openDb, writeRateLimits } from './src/rate-limits.ts';
  const db = openDb('${bun_state}/shared.db');
  writeRateLimits(db, { version: 1, fiveHour: { pct: 40, resetsAt: 4070908800 }, sevenDay: { pct: 18, resetsAt: 4071513600 } });
  db.close();
"

# Main comparison: bash vs bun across all fixtures
hyperfine \
  --shell=bash \
  --warmup 3 --min-runs 30 \
  --parameter-list fixture average,heavy,worst,no-transcript,with-rate-limits \
  --export-json "$out/hyperfine.json" \
  "bash ~/.claude/statusline-command.sh < bench/{fixture}.json" \
  "AGENT_HUD_STATE_DIR=${bun_state} AGENT_HUD_NO_ALIGN=1 bun src/index.ts < bench/{fixture}.json"

# Component breakdown: isolate each subprocess cost
hyperfine \
  --warmup 3 --min-runs 30 \
  --command-name "bun-startup" \
  --command-name "jj-drift" \
  --command-name "git-drift" \
  --export-json "$out/components.json" \
  "bun -e ''" \
  "jj --ignore-working-copy --no-pager log --no-graph --color=never -r 'trunk()..@' -T '\".\"'" \
  "git rev-list --left-right --count origin/main...HEAD"

{
  echo "# Benchmark results — $ts"
  echo ""
  echo "## hyperfine (--warmup 3 --min-runs 30)"
  echo ""
  bun bench/analyze.ts "$out/hyperfine.json"
  echo ""
  echo "## Component breakdown"
  echo ""
  bun bench/analyze.ts "$out/components.json"
  echo ""
  echo "## Notes"
  echo ""
  echo "<!-- add commentary here -->"
} > "$out/analysis.md"

echo "saved to $out"
