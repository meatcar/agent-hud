# Benchmark results — 2026-04-18T22:39:04Z

## hyperfine (--warmup 3 --min-runs 30)

| fixture          | bash               | bun               | speedup |
| ---------------- | ------------------ | ----------------- | ------: |
| average          | 100.0 ms ± 4.9 ms  | 42.5 ms ± 5.4 ms  |   2.35× |
| heavy            | 102.4 ms ± 2.4 ms  | 45.0 ms ± 3.7 ms  |   2.28× |
| worst            | 99.5 ms ± 3.7 ms   | 56.4 ms ± 21.7 ms |   1.76× |
| no-transcript    | 108.3 ms ± 10.3 ms | 55.5 ms ± 10.0 ms |   1.95× |
| with-rate-limits | 164.6 ms ± 29.4 ms | 53.4 ms ± 8.0 ms  |   3.08× |

## Component breakdown

| command      | mean ± σ         |
| ------------ | ---------------- |
| bun-startup  | 1.6 ms ± 0.7 ms  |
| starship-jj  | 14.7 ms ± 3.4 ms |
| starship-dir | 4.2 ms ± 0.8 ms  |

## Notes

<!-- add commentary here -->
