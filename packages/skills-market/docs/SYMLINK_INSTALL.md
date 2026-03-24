# Superpowers-Style Symlink Install (Private Skills Repo)

This document describes the **Git clone + symlink** route (similar to superpowers), for installing market-listed skills without copying files.

## 1) Scope

Use this route when you want:
- Fast install/update via symlink
- Full market skill set (all `skill-pack` entries) at once
- A local private skills source checkout

Use the Python installer (`scripts/install_skill.py`) when you want:
- Per-skill selection and dependency-aware install
- Payload allowlist/denylist copy install
- More controlled, reproducible install artifacts
- Installer-managed Python runtime isolation for opted-in skills (`runtime.python`)

## 2) Repository Roles

- `skills-market`:
  - metadata (`packages/*.json`)
  - validators
  - install scripts
- `skills` (private, recommended: `autoresearch-lab/skills`):
  - runtime skill source directories
  - expected layout: `skills/<skill-id>/SKILL.md`

## 3) Prerequisites

- `git` installed
- Access to private GitHub org/repo (`autoresearch-lab/skills`)
- Local clone of:
  - `skills-market`
  - `skills` repo

## 4) Local Layout (Recommended)

```text
~/Coding/Agents/Autoresearch/
  skills-market/
  skills/
    skills/
      hepar/
      research-team/
      ...
```

Notes:
- Preferred source lookup path is `SKILLS_ROOT/skills/<skill-id>/SKILL.md`.
- Fallback source lookup path is `SKILLS_ROOT/<skill-id>/SKILL.md`.

## 5) Install Commands

From `skills-market` repo root:

```bash
cd ~/Coding/Agents/Autoresearch/skills-market
```

### 5.1 Codex

```bash
bash scripts/install_symlink_codex.sh \
  --skills-root ~/Coding/Agents/Autoresearch/skills
```

### 5.2 Claude Code

```bash
bash scripts/install_symlink_claude_code.sh \
  --skills-root ~/Coding/Agents/Autoresearch/skills
```

### 5.3 OpenCode

```bash
bash scripts/install_symlink_opencode.sh \
  --skills-root ~/Coding/Agents/Autoresearch/skills
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

Example:

```bash
bash scripts/install_symlink_codex.sh \
  --skills-root ~/Coding/Agents/Autoresearch/skills \
  --dry-run
```

## 8) Updating Skills

When `skills` repo updates:

```bash
cd ~/Coding/Agents/Autoresearch/skills
git pull
```

Symlink installs see updates immediately (same linked source).

If market metadata changes (new/removed skill ids), rerun platform installer scripts.

### Python isolation note

The symlink route does not create skill-local Python environments.

If you need a skill-local `.venv` for an opted-in skill such as `auto-relay` or `hep-calc`, use the Python installer route instead:

```bash
python3 scripts/install_skill.py --platform codex --package auto-relay
python3 scripts/install_skill.py --platform codex --package hep-calc
```

This M-15 first slice only covers Python isolation inside `skills-market`; it does not add Node/TS runtime isolation or compatibility/export mirror changes.

## 9) Troubleshooting

### 9.1 “target exists and is not symlink”

A real directory/file exists at target location.

Fix:
- back up/remove the path manually
- rerun installer

### 9.2 “missing source for <skill-id>”

Cause:
- skill missing from local `skills` repo
- wrong `--skills-root`
- mismatch between market package ids and skills repo contents

Fix:
- verify repo checkout and branch
- verify `SKILL.md` exists at expected source path

### 9.3 “unsupported platform”

Use one of:
- `codex`
- `claude_code`
- `opencode`

## 10) Suggested Team Flow

1. Keep `skills` private repo clean and runtime-focused (no review/tmp artifacts).
2. Update `skills-market` metadata and validate:
   - `python3 scripts/validate_market.py`
3. Install via symlink scripts on each platform.
4. Restart client app/CLI if skill discovery is cached.
