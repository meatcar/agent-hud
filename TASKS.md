# Tasks

- [x] CI: `bun run check` + `bun test` on push/PR — `.github/workflows/ci.yml`
- [x] Releases + changelog: release-please — `.github/workflows/release-please.yml`
- [x] Renovate config, automerge on green CI — `renovate.json`
- [ ] Screenshot generator: fixtures → ANSI → PNG → `SCREENSHOTS.md` via showboat
- [ ] Link screenshots from README

Needs a human:

- [ ] Install the Renovate GitHub app for this repo: <https://github.com/apps/renovate>
- [ ] Add `NPM_TOKEN` repo secret (granular, publish-only) — release-please publishes
      `@meatcar/agent-hud` on the first release once it exists
