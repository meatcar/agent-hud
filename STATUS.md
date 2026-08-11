# Project status

## Current delivery

The implementation for [issue #7](https://github.com/meatcar/agent-hud/issues/7)
was merged through [PR #17](https://github.com/meatcar/agent-hud/pull/17), with
the macOS SQLite deadline fix in [PR #19](https://github.com/meatcar/agent-hud/pull/19).
The validated [v0.3.0 GitHub release](https://github.com/meatcar/agent-hud/releases/tag/agent-hud-v0.3.0)
is available. npm publication is blocked only on repository credentials tracked
in [issue #21](https://github.com/meatcar/agent-hud/issues/21).

### Completed

- [x] Preserve the default two-line Claude Code statusline.
- [x] Add positional built-in section layouts.
- [x] Add TOML layouts and direct-argv cached command sections.
- [x] Keep rendering cache-first and latency-bounded.
- [x] Make shared SQLite merges, leases, and GC concurrency-safe.
- [x] Isolate Claude Code input behind `StatusAdapter` and `StatusSnapshot`.
- [x] Add deterministic Unicode, merge, process, and contention properties.
- [x] Validate runtime coverage through LCOV plus subprocess contracts.
- [x] Validate the exact npm tarball, offline install, bundled executable, and
      Nix wrapper.
- [x] Gate CI, releases, and publication through the reusable quality workflow.
- [x] Pass independent read-only architecture, concurrency, package, CI, and
      final acceptance reviews.

### Delivery gates

- [x] Frozen dependency install.
- [x] Lint, formatting, LSP, and structural diagnostics.
- [x] Unit and integration suite: 453 tests.
- [x] Deterministic stress suite: 1,359 tests.
- [x] Runtime coverage manifest: 20/20 executable modules.
- [x] Seven executable-entrypoint scenarios.
- [x] Local Linux package, Nix, and detached-refresh validation.
- [x] Publish a review branch and open a PR linked to issue #7.
- [x] Pass the hosted Ubuntu and macOS quality matrix.
- [x] Merge the feature and release-blocking fix PRs.
- [x] Create the immutable `agent-hud-v0.3.0` GitHub release.
- [x] Revalidate the exact release commit and npm tarball in the retry workflow.
- [ ] Publish `@meatcar/agent-hud@0.3.0` after configuring `NPM_TOKEN` ([#21](https://github.com/meatcar/agent-hud/issues/21)).

## Follow-up integrations

Additional agent CLIs should be implemented one at a time, using an authoritative
sanitized fixture before adding an adapter. Tests must remain offline and must
not invoke a model or agent CLI.

- [ ] Pi extension fixture and `StatusAdapter`.
- [ ] Codex hook/event fixture and `StatusAdapter`.
- [ ] OpenCode plugin/event fixture and `StatusAdapter`.
- [ ] Document the stable integration contract once a second real adapter proves
      which abstractions are shared.

A provider registry, schema auto-detection, and generic quota model are deferred
until real upstream contracts demonstrate a need.

## Tracking

- This file is the durable high-level delivery checklist.
- GitHub issues own actionable follow-up work and acceptance criteria.
- GitHub PRs own review discussion and hosted CI status.
- `.github/workflows/quality.yml` is the machine-verifiable delivery gate.
- Pi tasks and subagent artifacts are execution detail, not the project source of
  truth.
