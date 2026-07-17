# Results — Bun statusline vs bash baseline

Measured 2026-04-17, same machine as baseline run.

## hyperfine (--warmup 3 --min-runs 30)

| fixture | bash mean ± σ     | bun mean ± σ     | speedup |
| ------- | ----------------- | ---------------- | ------: |
| average | 105.3 ms ± 6.1 ms | 43.1 ms ± 3.5 ms |   2.45× |
| heavy   | 107.2 ms ± 7.0 ms | 53.3 ms ± 7.6 ms |   2.49× |
| worst   | 114.4 ms ± 9.1 ms | 59.5 ms ± 6.4 ms |   2.66× |

Parity: `bash packages/statusline/bench/parity.sh` passes on all three
fixtures (bash and Bun outputs are byte-identical once the live clock is
masked).

## Where the time goes now

Standalone measurements of each remaining component:

| component                 |   mean |
| ------------------------- | -----: |
| Bun startup + stdin read  | ~13 ms |
| starship-jj prompt (fork) | ~14 ms |
| starship module directory |  ~6 ms |

The two starship subprocesses are spawned in parallel and awaited together,
so the critical path is `bun startup + max(starship forks)` ≈ **~27 ms
floor**. Observed means (43–60 ms) include scheduling variance and the
effect of running inside `bun run` (which re-parses `package.json`). Calling
the script directly via `bun packages/statusline/index.ts` saves a few ms
for production use.

## Why not faster?

- `starship-jj` is the dominant single cost but must stay: its output is
  complex enough to be worth keeping as a fork, and caching its output
  would show stale VCS state to the user.
- `starship module directory` could be inlined (would save ~6 ms), but it
  runs in parallel with `starship-jj`, so it's not on the critical path.
  Inlining would also couple us to the user's `starship.toml` formatting
  choices — risky for accuracy.
- Going below ~15 ms would require either `bun build --compile` or porting
  `starship-jj` into JS. Neither is justified for a status line refreshed
  at most once a second.

## Net effect

- **Bash hot loop**: 31 subprocess forks (`jq ×15`, `awk ×6`, `date ×4`,
  `starship ×3`, `head ×2`, `sed ×1`), ~110 ms.
- **Bun hot loop**: 2 subprocess forks (`starship` + `starship-jj`, parallel),
  ~43–60 ms.

Session-start cache at `~/.claude/statusline-state/<transcript-uuid>.json`
avoids the first-timestamp transcript scan on every refresh. The scan
itself is fast (<1 ms on a 14 MB file thanks to `Bun.file().slice()`), but
the cache is free and makes the behaviour O(1) in transcript size.
