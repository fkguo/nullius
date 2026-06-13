# Changelog

Notable changes to autoresearch-lab. The format follows
[Keep a Changelog](https://keepachangelog.com/). The project is **pre-1.0**: all
workspace packages move in lockstep on a single `0.x` version, breaking changes may
occur in any `0.x` release, and there is no API-stability promise yet. Dated, tagged
releases begin at the first published release; until then the current development
version is the lockstep number below.

## [Unreleased]

### Changed
- **Version lockstep at `0.3.0`.** Unified every workspace package version — plus the
  exported `VERSION` constants and the MCP server/client identity strings — to a single
  `0.3.0`, replacing ad-hoc drift across `0.0.1` / `0.1.0` / `0.3.0` (the front-door
  `@autoresearch/orchestrator` had been stuck at `0.0.1`, looking earlier than the
  libraries it owns). Versions now move together.
- Added `scripts/check-version-consistency.mjs` (CI-enforced) to keep package versions
  and `VERSION` constants locked in step.
