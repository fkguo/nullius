# skills-market

Private-first marketplace index and installers for the Autoresearch ecosystem.

## Scope

This repository is the distribution control plane for skill/tool package metadata and platform installers.

Supported platforms:
- Claude Code
- Codex
- OpenCode

## Layout

- `packages/`: package metadata (`*.json`)
- `schemas/`: metadata schema
- `scripts/`: install/validation scripts
- `.github/workflows/`: CI checks

## Quick Start

Validate metadata locally:

```bash
python3 scripts/validate_market.py
```

Installers:

- Codex: `bash scripts/install_codex.sh`
- OpenCode: `bash scripts/install_opencode.sh`
- Claude Code (local skills link fallback): `bash scripts/install_claude_code.sh`

Superpowers-style full symlink install (Git clone + links):

```bash
# Codex full install (all market skill-pack entries)
bash scripts/install_symlink_codex.sh \
  --skills-root ~/Coding/Agents/Autoresearch/skills

# Claude Code full install
bash scripts/install_symlink_claude_code.sh \
  --skills-root ~/Coding/Agents/Autoresearch/skills

# OpenCode full install
bash scripts/install_symlink_opencode.sh \
  --skills-root ~/Coding/Agents/Autoresearch/skills
```

Detailed guide:
- `docs/SYMLINK_INSTALL.md`

Selective skill install (default: install only what you ask for):

```bash
# Install one skill to Codex path (~/.codex/skills/<skill-id>)
python3 scripts/install_skill.py \
  --platform codex \
  --package hepar

# Install multiple skills (with skill-pack dependency auto-install)
python3 scripts/install_skill.py \
  --platform codex \
  --package hepar \
  --package research-writer
```

`install_skill.py` behavior:
- No implicit full install unless you pass `--all`
- Skill-pack dependencies are auto-installed by default (disable with `--no-deps`)
- Non-skill dependencies (`tool-pack/workflow-pack/engine-pack/contract-pack`) are surfaced as preflight warnings, or hard-failed with `--strict-deps`
- Source payload uses package-level publish allowlist (`source.include`) and denylist (`source.exclude`) so review artifacts/dev traces are not installed

## Source Publishing Model (Private)

Skill runtime source should live in a separate private repo, referenced by package metadata:
- target repo: `autoresearch-lab/skills` (private)
- each `skill-pack` points to:
  - `source.repo`
  - `source.ref`
  - `source.subpath`
  - `source.include` / `source.exclude`

Only allowlisted files are installed, which keeps installation payload minimal and avoids leaking development/review process files.

## Notes

- This repo is private and oriented to internal ecosystem rollout.
- Runtime compatibility SSOT:
  - Local sibling checkout: `../autoresearch-meta/compatibility-matrix/ecosystem-manifest.json`
  - GitHub: `https://github.com/autoresearch-lab/autoresearch-meta/blob/main/compatibility-matrix/ecosystem-manifest.json`
