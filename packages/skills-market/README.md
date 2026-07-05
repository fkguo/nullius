# skills-market

Cross-host skill distribution catalog and copy-installer for the Nullius ecosystem.

## Status: designed, currently dormant

This package is a **fully-designed but currently dormant** distribution surface.
It is the ecosystem's only real cross-host distribution mechanism — a package
catalog (`packages/*.json`) plus a copy-installer (`install_skill.py`) with a
per-package publish allowlist/denylist (`source.include` / `source.exclude`) — but
nothing depends on it today:

- **Real distribution currently runs through direct symlinks**: hosts link the
  in-repo `skills/` directory straight into their skills home (see the
  `install_symlink_*.sh` scripts and `docs/SYMLINK_INSTALL.md`). No package
  consumes the copy-installer catalog yet.
- The copy-installer + catalog exist to distribute skills **to hosts that do not
  have a local checkout of this monorepo** — that use case is not live yet.
- The former GitHub mirror is retired (see Notes); the checked-in catalog and
  manifest are the only live copies.

Keep it slim and honest rather than pretending it is a running marketplace.

## Scope

This package holds the cross-host distribution control plane: skill package
metadata and the platform copy/symlink installers.

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
  --skills-root ~/Coding/Agents/Nullius/skills

# Claude Code full install
bash scripts/install_symlink_claude_code.sh \
  --skills-root ~/Coding/Agents/Nullius/skills

# OpenCode full install
bash scripts/install_symlink_opencode.sh \
  --skills-root ~/Coding/Agents/Nullius/skills
```

Detailed guide:
- `docs/SYMLINK_INSTALL.md`

Selective skill install (default: install only what you ask for):

```bash
# Install one skill to Codex path (~/.codex/skills/<skill-id>)
python3 scripts/install_skill.py \
  --platform codex \
  --package research-harness

# Install multiple skills (with skill-pack dependency auto-install)
python3 scripts/install_skill.py \
  --platform codex \
  --package research-harness \
  --package research-team \
  --package research-writer
```

`install_skill.py` behavior:
- No implicit full install unless you pass `--all`
- Skill-pack dependencies are auto-installed by default (disable with `--no-deps`)
- Non-skill dependencies (`tool-pack/workflow-pack/engine-pack/contract-pack`) are surfaced as preflight warnings, or hard-failed with `--strict-deps`
- Source payload uses package-level publish allowlist (`source.include`) and denylist (`source.exclude`) so review artifacts/dev traces are not installed
- `research-harness` is the thin external-project entry skill for Codex / Claude Code / OpenCode. It has no hard package dependency on `research-team` or `hep-mcp`; it routes to them when those capabilities are available.
- Skill-packs can opt into installer-managed Python isolation with `runtime.python.mode = "isolated-venv"`
- Opted-in Python skills get a skill-local `.venv`; installs fail closed if venv creation or package install fails
- `--auto-safe` is a narrower copy-install authority for `skill-pack` closures only:
  - requires explicit `--package`
  - rejects `--all` and `--no-deps`
  - requires `install_policy.auto_safe.human_pre_approved: true`
  - requires `source.ref` to be an immutable 40-character git SHA
  - fails closed if any dependency in the requested closure is not an eligible `skill-pack`
- `--auto-safe` writes install traceability into `.market_install.json` and a deterministic target-root audit file at `.auto_safe_install_audit.json`
- **No package is currently onboarded to `--auto-safe`.** The authority and its
  fail-closed policy live in the code (and are covered by mechanism tests), but no
  catalog entry carries `install_policy.auto_safe` today. Onboarding requires a real
  external publish target — a standalone skills repo whose pinned 40-character SHA
  actually resolves — so that the immutable `source.ref` recorded into
  `.market_install.json` is a truthful origin rather than a fabricated pin. Until
  such a target exists, every skill-pack ships with `source.ref: main` against the
  in-repo source and installs through the normal (copy or symlink) route.

To onboard a package once a real pinned publish target exists, add an
`install_policy.auto_safe.human_pre_approved: true` block to its package file and set
its `source.ref` to the resolvable 40-character SHA, then install with:

```bash
python3 scripts/install_skill.py \
  --platform codex \
  --package <onboarded-skill> \
  --auto-safe
```

`--auto-safe` does not apply to the symlink installer scripts. The Git clone + symlink route remains a separate install surface documented in `docs/SYMLINK_INSTALL.md`.

## Source Publishing Model (planned target)

The copy-installer resolves each skill-pack's payload from a `source` block:
- `source.repo` — the intended standalone publish repo (`nullius/skills`). This
  external repo is **not live yet**; today the installer is driven with
  `--source-root <monorepo>` so it copies from the in-repo `skills/` directory, and
  `source.ref` is `main` (no external SHA is pinned).
- `source.subpath`
- `source.include` / `source.exclude`

Only allowlisted files are installed, which keeps the installation payload minimal
and avoids leaking development/review process files. When a real standalone
`nullius/skills` repo is published (with resolvable pinned SHAs), the same catalog
drives clone-based installs and `--auto-safe` onboarding without further code
changes.

## Python Runtime Isolation (M-15 first slice)

This first slice adds Python-only dependency isolation for selected skill-packs.

- Supported now: installer-managed `.venv` inside the installed skill directory
- Not included in this slice: Node/TS runtime isolation
- Initial rollout:
  - `hep-calc` gets a skill-local `.venv` boundary even with an empty package list

When a skill opts in via `runtime.python`, the installed payload records `python_runtime` in `.market_install.json` and annotates the installed `SKILL.md` with a runtime note pointing agents/users to the skill-local interpreter.

## Notes

- This distribution surface is dormant, not published: no external marketplace or
  mirror is live. Installer/runtime truth follows the checked-in catalog and
  manifest in this monorepo, not any external or private rollout assumption.
- Runtime compatibility SSOT:
  - Checked-in manifest: `meta/compatibility-matrix/ecosystem-manifest.json`, whose
    `components` block is generated from this catalog (`packages/*.json`) — see that
    directory's README for the generator/check workflow.
  - The former GitHub mirror (`https://github.com/autoresearch-lab/autoresearch-meta`, pre-rename) is retired and no longer synced; the checked-in manifest above is the only live copy.
