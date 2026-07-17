# Baseline — current bash statusline

Measured on 2026-04-17 against `~/.claude/statusline-command.sh`.

Fixtures point at real transcripts at three size percentiles across the user's
~483 existing Claude Code sessions:

| fixture | transcript size | transcript lines |
| ------- | --------------: | ---------------: |
| average |          145 KB |               67 |
| heavy   |          2.3 MB |            1,231 |
| worst   |         14.6 MB |            2,777 |

## hyperfine (--warmup 3 --min-runs 20)

| fixture | mean ± σ           | min … max          | runs |
| ------- | ------------------ | ------------------ | ---: |
| average | 114.8 ms ± 10.0 ms | 98.1 ms … 133.3 ms |   26 |
| heavy   | 109.6 ms ± 7.6 ms  | 99.1 ms … 137.7 ms |   27 |
| worst   | 113.2 ms ± 10.2 ms | 97.1 ms … 135.4 ms |   24 |

Transcript size is essentially irrelevant — `head -50` bounds the read.
The flat ~110 ms floor comes from subprocess forks.

## Fork count per invocation (`bash -x`)

| command   |  count |
| --------- | -----: |
| jq        |     15 |
| awk       |      6 |
| starship  |      3 |
| date      |      4 |
| head      |      2 |
| sed       |      1 |
| **total** | **31** |

At ~3 ms per fork+exec on this box, 31 forks ≈ 90 ms — matches the observed
floor. That is the budget to beat.

## Implications for the rewrite

- **Eliminating all 15 `jq` calls** (single `JSON.parse`) is the biggest win.
- **Replacing `starship module time` + `starship module directory`** removes
  2 of 3 starship forks; `starship-jj` stays.
- `awk`, `date`, `sed`, `head` disappear entirely inside the Bun script.
- **Session-start cache** is not the big win we expected — `head -50 | jq`
  is cheap. Keep the cache anyway (avoids even the cheap read + one more
  subprocess) but don't expect dramatic gains from it.
- Expected post-rewrite: **~15–25 ms** (1 bun exec + 1 starship-jj fork).
  Target ≥4× faster on all fixtures.
