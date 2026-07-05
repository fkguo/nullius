# Symlink Install (Git clone + symlink route)

This document describes the **clone + symlink** route (similar to superpowers), for
installing market-listed skills without copying files. The live skill source is the
in-repo `skills/` directory of this monorepo; a standalone `nullius/skills` publish
repo is a planned, not-yet-live target (see the package README's dormant-surface
note), so today you point the installer at the monorepo's own `skills/` directory.

## 1) Scope

Use this route when you want:
- Fast install/update via symlink
- Full market skill set (all `skill-pack` entries) at once
- A single local checkout as the skill source (the monorepo's in-repo `skills/`)

Use the Python installer (`scripts/install_skill.py`) when you want:
- Per-skill selection and dependency-aware install
- Payload allowlist/denylist copy install
- More controlled, reproducible install artifacts
- Installer-managed Python runtime isolation for opted-in skills (`runtime.python`)
- The bounded `--auto-safe` install path for explicitly approved, immutable-ref `skill-pack` closures

## 2) Repository Roles

- `skills-market` (this package, `packages/skills-market/`):
  - metadata (`packages/*.json`)
  - validators
  - install scripts
- skill source directories — the live source is the monorepo's in-repo `skills/`
  directory (`skills/<skill-id>/SKILL.md`). A standalone `nullius/skills` publish
  repo is a planned, not-yet-live target; until it exists, point `--skills-root` at
  the monorepo's `skills/` directory.

## 3) Prerequisites

- `git` installed
- A local checkout of this monorepo (it provides both `packages/skills-market/` and
  the in-repo `skills/` source under one root)

## 4) Local Layout

```text
~/Coding/Agents/nullius/          # this monorepo
  packages/skills-market/
  skills/
    research-team/
    ...
```

Notes:
- Preferred source lookup path is `SKILLS_ROOT/skills/<skill-id>/SKILL.md`.
- Fallback source lookup path is `SKILLS_ROOT/<skill-id>/SKILL.md`; pointing
  `--skills-root` at the monorepo's `skills/` directory uses this fallback form.

## 5) Install Commands

From the monorepo's `packages/skills-market/` directory:

```bash
cd ~/Coding/Agents/nullius/packages/skills-market
```

### 5.1 Codex

```bash
bash scripts/install_symlink_codex.sh \
  --skills-root ~/Coding/Agents/nullius/skills
```

### 5.2 Claude Code

```bash
bash scripts/install_symlink_claude_code.sh \
  --skills-root ~/Coding/Agents/nullius/skills
```

### 5.3 OpenCode

```bash
bash scripts/install_symlink_opencode.sh \
  --skills-root ~/Coding/Agents/nullius/skills
```

## 6) Target Paths

- Codex: `~/.codex/skills`
- Claude Code: `~/.claude/skills`
- OpenCode: `~/.config/opencode/skills`

The installer links every market `skill-pack` package id to the platform target root.

## 7) Safety Behavior

- Will not overwrite a non-symlink target directory/file.
- Missing source skill:
  - default: error
  - with `--allow-missing`: warning + skip
- Supports `--dry-run` for preview.
- Does not participate in `--auto-safe` authority. Symlink install is intentionally outside the EVO-12 first deliverable.

Example:

```bash
bash scripts/install_symlink_codex.sh \
  --skills-root ~/Coding/Agents/nullius/skills \
  --dry-run
```

## 8) Updating Skills

When the in-repo `skills/` source updates, pull the monorepo:

```bash
cd ~/Coding/Agents/nullius
git pull
```

Symlink installs see updates immediately (same linked source).

If market metadata changes (new/removed skill ids), rerun platform installer scripts.

### Python isolation note

The symlink route does not create skill-local Python environments.

If you need a skill-local `.venv` for an opted-in skill such as `hep-calc`, use the Python installer route instead:

```bash
python3 scripts/install_skill.py --platform codex --package hep-calc
```

This M-15 first slice only covers Python isolation inside `skills-market`; it does not add Node/TS runtime isolation or compatibility/export mirror changes.

### Auto-safe boundary note

The bounded EVO-12 `--auto-safe` path belongs only to `scripts/install_skill.py` and only for copy installs.

- It requires `install_policy.auto_safe.human_pre_approved: true`.
- It requires `source.ref` to be pinned to an immutable 40-character git SHA.
- It rejects non-`skill-pack` dependencies and ineligible dependency closures atomically.
- It writes `.market_install.json` provenance plus `.auto_safe_install_audit.json`.

The symlink scripts in this document do none of the above and should be treated as a separate install route.

## 9) Troubleshooting

### 9.1 “target exists and is not symlink”

A real directory/file exists at target location.

Fix:
- back up/remove the path manually
- rerun installer

### 9.2 “missing source for <skill-id>”

Cause:
- skill missing from the in-repo `skills/` source directory
- wrong `--skills-root`
- mismatch between market package ids and the `skills/` directory contents

Fix:
- verify the monorepo checkout and branch
- verify `SKILL.md` exists at expected source path

### 9.3 “unsupported platform”

Use one of:
- `codex`
- `claude_code`
- `opencode`

## 10) Suggested Team Flow

1. Keep the in-repo `skills/` source clean and runtime-focused (no review/tmp artifacts).
2. Update `skills-market` metadata and validate:
   - `python3 scripts/validate_market.py`
3. Install via symlink scripts on each platform.
4. Restart client app/CLI if skill discovery is cached.
