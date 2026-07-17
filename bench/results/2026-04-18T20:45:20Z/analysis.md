# Benchmark results — 2026-04-18T20:45:20Z

## hyperfine (--warmup 3 --min-runs 30)

| fixture       | bash               | bun               | speedup |
| ------------- | ------------------ | ----------------- | ------: |
| average       | 99.2 ms ± 4.2 ms   | 45.1 ms ± 10.7 ms |   2.20× |
| heavy         | 130.5 ms ± 31.0 ms | 42.0 ms ± 3.3 ms  |   3.11× |
| worst         | 125.6 ms ± 21.8 ms | 49.6 ms ± 10.7 ms |   2.53× |
| no-transcript | 98.4 ms ± 9.6 ms   | 47.0 ms ± 7.9 ms  |   2.10× |

## Component breakdown

| command      | mean ± σ         |
| ------------ | ---------------- |
| bun-startup  | 1.3 ms ± 0.6 ms  |
| starship-jj  | 14.1 ms ± 2.0 ms |
| starship-dir | 5.1 ms ± 1.1 ms  |

## Notes

<!-- add commentary here -->
