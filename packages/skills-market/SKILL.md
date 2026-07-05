---
name: nullius-market
description: Browse and install Nullius skills. This directory is the skills-market catalog (package metadata + installers), not a runnable task skill; use it to discover available skills and install specific ones into your skills home.
---

# Nullius Skills Market

This is the **catalog/installer control plane** for Nullius skills — it is intentionally a
metadata + installer package, not a task skill. A host that linked the whole market root here (via
`scripts/install_codex.sh` / `install_opencode.sh` / `install_claude_code.sh`) sees this `SKILL.md` so
the directory is a well-formed, inert catalog entry rather than a `SKILL.md`-less directory that a strict
skill loader could reject.

This cross-host copy-installer is currently **dormant**: real distribution runs through
direct in-repo symlinks today, and this catalog exists to serve hosts without a local
monorepo checkout once that route goes live. See `README.md` for the full status.

## Install specific skills (recommended)

Install only what you need (skill-pack dependencies are pulled in automatically):

```bash
python3 scripts/install_skill.py --platform <codex|claude_code|opencode> --package <skill-id>
```

List available skill ids in `packages/index.json`. To install every market skill as a live,
repo-tracking symlink, use the per-skill installer instead of treating this catalog as a single skill:

```bash
bash scripts/install_symlink_<platform>.sh --skills-root /path/to/monorepo
```

This catalog entry runs nothing on its own.
