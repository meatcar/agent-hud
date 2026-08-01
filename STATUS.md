# Project status

## Current delivery

The implementation for [issue #7](https://github.com/meatcar/agent-hud/issues/7)
is complete and passes the full local quality stack. It includes positional and
TOML layouts, cache-first custom command sections, protocol-neutral status
composition, concurrency fixes, deterministic process/property testing, and
exact package/Nix/release validation.

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
- [x] Unit and integration suite: 447 tests.
- [x] Deterministic stress suite: 1,341 tests.
- [x] Runtime coverage manifest: 20/20 executable modules.
- [x] Seven executable-entrypoint scenarios.
- [x] Local Linux package, Nix, and detached-refresh validation.
- [ ] Publish a review branch and open a PR linked to issue #7.
- [ ] Pass the hosted Ubuntu and macOS quality matrix.
- [ ] Merge and let the exact-artifact release path run.

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
- The implementation PR owns review discussion and hosted CI status.
- `.github/workflows/quality.yml` is the machine-verifiable delivery gate.
- Pi tasks and subagent artifacts are execution detail, not the project source of
  truth.
