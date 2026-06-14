#!/usr/bin/env node

// Host-neutral skill-path anti-drift guard.
//
// Locks the repo-wide host-neutrality invariant for the `skills/` surface:
// agent skills must NOT hardcode a single host's install location when resolving
// a skill directory. The portable idiom is an explicit `SKILL_DIR` override with a
// host-neutral fallback that PROBES the known agent skill homes in equal order:
//
//   SKILL_DIR="${SKILL_DIR:-$(for r in \
//     "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" \
//     "${CODEX_HOME:-$HOME/.codex}" \
//     "$HOME/.config/opencode"; do \
//     [ -d "$r/skills/<skill>" ] && echo "$r/skills/<skill>" && break; done || true)}"
//
// What is FORBIDDEN is a host home token used DIRECTLY as the skills root — i.e.
// glued to `/skills`:  `$CODEX_HOME/skills`, `${CODEX_HOME:-$HOME/.codex}/skills`,
// `~/.codex/skills`, `$HOME/.claude/skills`, `${CLAUDE_CONFIG_DIR}/skills`, etc.
//
// What is ALLOWED — and why a blanket `CODEX_HOME` ban would be wrong — is the
// SAME host token appearing as ONE equal entry in the neutral probe, where the
// `/skills` join happens through the loop variable (`$r/skills/...`) and the host
// token itself is followed by a closing quote, not `/skills`. The chosen idiom
// (approved by the maintainer) legitimately contains `${CODEX_HOME:-$HOME/.codex}`
// AND `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` as co-equal probe entries; neither is
// privileged. So the discriminating signal is purely the `<host-token>/skills`
// adjacency, not the mere presence of `CODEX_HOME` / `.codex` / `.claude`.
// (Legitimate host CONFIG refs such as `~/.codex/config.toml` or
// `~/.claude/settings.json` are therefore never flagged — they are not `/skills`.)
//
// SCOPE: `skills/` only. Deliberately NOT scanned:
//   - `packages/skills-market/**`: a multi-host marketplace package that ships
//     PAIRED per-host installers (`install_codex.sh` + `install_claude_code.sh`)
//     and a schema-enforced canonical `source_path` (`~/.codex/skills/<id>/SKILL.md`).
//     It already models every host explicitly; its conventions are governed by the
//     marketplace's own validate_market_runtime contracts, not this lane.
//   - `packages/{orchestrator,project-contracts}/**`: scaffold-authority + tests
//     that reference `~/.codex/skills/...` as legacy-residue fixtures / test data.
// Neutralizing those is a separate, larger concern (marketplace schema redesign)
// and should be its own lane with its own maintainer decision.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A host home token (env var or literal dot-dir) glued directly to `/skills`.
// Leading (?<![A-Za-z0-9_]) avoids matching longer identifiers like MY_CODEX_HOME
// or a content word ending in `codex`/`claude`.
const HOST_SKILLS_PRIVILEGE =
  /(?<![A-Za-z0-9_])(?:CODEX_HOME|CLAUDE_CONFIG_DIR|\.codex|\.claude)\}?\/skills/;

const SCAN_EXT = new Set(['.md', '.py', '.sh', '.txt', '.json', '.ts', '.mjs', '.cjs', '.js']);

// Tests legitimately embed fake host paths as fixtures; the codex runner itself is
// the one legitimately host-specific entrypoint (it never resolves a skills root,
// but is allow-listed to honor the maintainer's "only run_codex.sh" intent).
const SKIP_FILE_RE = /(\.test\.[cm]?[tj]sx?$|(^|\/)test_[^/]*\.py$|(^|\/)run_codex\.sh$)/;

function trackedSkillFiles() {
  return execFileSync('git', ['ls-files', 'skills/'], { cwd: repoRoot, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);
}

const violations = [];
for (const rel of trackedSkillFiles()) {
  if (SKIP_FILE_RE.test(rel)) continue;
  if (!SCAN_EXT.has(path.extname(rel))) continue;
  let content;
  try {
    content = readFileSync(path.join(repoRoot, rel), 'utf-8');
  } catch {
    continue;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = HOST_SKILLS_PRIVILEGE.exec(lines[i]);
    if (m) {
      violations.push({ file: rel, line: i + 1, match: m[0] });
    }
  }
}

if (violations.length === 0) {
  console.log('OK: skills/ resolves skill dirs host-neutrally; no <host-home>/skills hardcoding.');
  process.exit(0);
}

console.error('DRIFT: host-privileging <host-home>/skills path(s) reintroduced under skills/:');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  …${v.match}…`);
}
console.error('');
console.error('A skill must NOT pin a single host as the skills root. Replace the hardcoded');
console.error('home with the host-neutral probe (explicit SKILL_DIR override + ordered probe of');
console.error('"${CLAUDE_CONFIG_DIR:-$HOME/.claude}", "${CODEX_HOME:-$HOME/.codex}",');
console.error('"$HOME/.config/opencode"), joining "/skills/<skill>" through the loop variable.');
console.error('CODEX_HOME / CLAUDE_CONFIG_DIR are fine AS EQUAL PROBE ENTRIES — just never glued');
console.error('directly to "/skills". Host config refs (e.g. ~/.codex/config.toml) are not flagged.');
process.exit(1);
