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
- Skill-packs can opt into installer-managed Python isolation with `runtime.python.mode = "isolated-venv"`
- Opted-in Python skills get a skill-local `.venv`; installs fail closed if venv creation or package install fails
- `--auto-safe` is a narrower copy-install authority for `skill-pack` closures only:
  - requires explicit `--package`
  - rejects `--all` and `--no-deps`
  - requires `install_policy.auto_safe.human_pre_approved: true`
  - requires `source.ref` to be an immutable 40-character git SHA
  - fails closed if any dependency in the requested closure is not an eligible `skill-pack`
- `--auto-safe` writes install provenance into `.market_install.json` and a deterministic target-root audit file at `.auto_safe_install_audit.json`
- The current checked-in catalog has a limited real `--auto-safe` rollout for `codex-cli-runner` and `auto-relay`; the rest of the catalog is not yet onboarded to this authority
- This slice is local to `skills-market` installer behavior only; compatibility/export mirror updates are intentionally deferred

Example auto-safe invocation:

```bash
python3 scripts/install_skill.py \
  --platform codex \
  --package codex-cli-runner \
  --auto-safe
```

`--auto-safe` does not apply to the symlink installer scripts. The Git clone + symlink route remains a separate install surface documented in `docs/SYMLINK_INSTALL.md`.

## Source Publishing Model (Private)

Skill runtime source should live in a separate private repo, referenced by package metadata:
- target repo: `autoresearch-lab/skills` (private)
- each `skill-pack` points to:
  - `source.repo`
  - `source.ref`
  - `source.subpath`
  - `source.include` / `source.exclude`

Only allowlisted files are installed, which keeps installation payload minimal and avoids leaking development/review process files.

## Python Runtime Isolation (M-15 first slice)

This first slice adds Python-only dependency isolation for selected skill-packs.

- Supported now: installer-managed `.venv` inside the installed skill directory
- Not included in this slice: Node/TS runtime isolation
- Initial rollout:
  - `auto-relay` installs required `PyYAML` into a skill-local `.venv`
  - `hep-calc` gets a skill-local `.venv` boundary even with an empty package list

When a skill opts in via `runtime.python`, the installed payload records `python_runtime` in `.market_install.json` and annotates the installed `SKILL.md` with a runtime note pointing agents/users to the skill-local interpreter.

## Notes

- This repo is private and oriented to internal ecosystem rollout.
- Runtime compatibility SSOT:
  - Local sibling checkout: `../autoresearch-meta/compatibility-matrix/ecosystem-manifest.json`
  - GitHub: `https://github.com/autoresearch-lab/autoresearch-meta/blob/main/compatibility-matrix/ecosystem-manifest.json`
