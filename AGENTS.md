## Codebase: Direnv + Nix + Bun

```
flake.nix          # inputs only
.envrc             # env init
nix/flake-modules/ # flake parts: devshell.nix, treefmt.nix, package.nix
src/               # statusline source; index.ts is the entrypoint
bench/             # hyperfine benchmarks + fixtures
scripts/           # screenshots.sh (vhs) — bun run screenshots
```

## Principles

- Red/Green TDD. Conventional Commits: consistent scopes, short titles. Atomic, testable, logically distinct commits.
- Ask before network or out-of-workspace actions.

## Commands (repo root)

- `direnv exec .`: run commands
- `nix fmt`: format (run after every source edit)
- `nix flake check`: validate flake outputs
- `bun test`: run tests (vcs drift tests spawn `jj` — devshell provides it)

## Nix

- Use `inputs'.nixpkgs-unstable.legacyPackages` only for intentional unstable packages.
- Formatters (`treefmt-nix`): `nixfmt`, `deadnix`+`statix` (lint), `oxfmt`.

## Bun / TypeScript

See `./node_modules/bun-types/CLAUDE.md`.

Code quality enforced via `bun check`, running:

- `bun format`: `treefmt`
- `bun lint`: `oxlint` (type-aware; `correctness`/`suspicious`/`perf` error) + `fallow` (duplicates, code health)
