#!/usr/bin/env node

// Scaffold-authority anti-drift guard.
//
// Locks the 2026-03-14 "scaffold boundary invariant"
// (.serena/memories/architecture-decisions.md): the canonical project root
// documents — AGENTS.md plus the five baseline docs (project_charter,
// project_index, research_plan, research_notebook, research_contract) — have a
// SINGLE scaffold authority: `packages/project-contracts/.../scaffold_templates/`,
// rendered by `project_scaffold_cli`.
//
// The `research-team` skill is a CONSUMER of that baseline, not an independent
// authority. It must NOT carry its own copies of those baseline documents under
// `skills/research-team/assets/` — those copies drift silently from the
// canonical templates (e.g. when the canonical AGENTS framing changes, a stale
// `assets/AGENTS_template.md` would not be flagged). research-team's genuine
// opt-in feature files (prompts, run_*.sh, knowledge_base/graph readmes,
// methodology_trace, research_team_config, project_map, …) are unaffected.
//
// This guard fails if ANY baseline-doc template reappears under
// `skills/research-team/assets/`. The matcher is basename-precise so legitimate
// opt-in files whose names merely START with a canonical word — e.g.
// `project_map_template.md`, `research_preflight_template.md`,
// `research_team_config_template.json` — are NOT flagged.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS_DIR = 'skills/research-team/assets/';

// A file is a forbidden baseline-doc template iff its basename is exactly one of
// the canonical document stems (optionally with a `_template` suffix) and a
// doc/text/json extension. Exact alternation — NOT prefix — so `project_map`,
// `research_preflight`, and `research_team_config` do not match.
const BASELINE_DOC_TEMPLATE =
  /^(agents|project_charter|project_index|research_plan|research_notebook|research_contract)(_template)?\.(md|json|txt)$/i;

function trackedAssetFiles() {
  return execFileSync('git', ['ls-files', ASSETS_DIR], { cwd: repoRoot, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);
}

const violations = [];
for (const rel of trackedAssetFiles()) {
  if (BASELINE_DOC_TEMPLATE.test(path.basename(rel))) {
    violations.push(rel);
  }
}

if (violations.length === 0) {
  console.log(
    `OK: ${ASSETS_DIR} carries no baseline-doc template; project-contracts remains the sole scaffold authority.`,
  );
  process.exit(0);
}

console.error('DRIFT: baseline-doc scaffold template(s) reappeared under research-team assets:');
for (const v of violations) {
  console.error(`  ${v}`);
}
console.error('');
console.error('The canonical project root documents (AGENTS.md + project_charter / project_index /');
console.error('research_plan / research_notebook / research_contract) have a single scaffold');
console.error('authority: packages/project-contracts/.../scaffold_templates/, rendered by');
console.error('project_scaffold_cli. The research-team scaffold must consume that baseline, not');
console.error('ship its own copy. Remove the file(s) above and let the canonical scaffold render');
console.error('them; keep only genuine research-team opt-in feature files under assets/.');
process.exit(1);
