#!/usr/bin/env node

/**
 * P3-A followup-1: skill tool-name anti-drift CI check.
 *
 * Locks the contract that every backtick'd `tool_name` reference inside
 * `skills/**\/SKILL.md` resolves to a real tool registered in the canonical
 * tool-name inventories under `packages/`. Catches:
 *   - A tool renamed or removed in code while a skill still references
 *     the old name.
 *   - A typo introduced when authoring a new skill that happens to follow
 *     the prefix pattern but doesn't exist.
 *
 * The check is a structural grep — same shape as the four other anti-drift
 * scripts in this directory.
 *
 * ## Data sources (verified by reading source, not by name)
 *
 *   - packages/shared/src/tool-names.ts (cross-package canonical; 90 tools
 *     spanning arxiv_/hepdata_/idea_/inspire_/openalex_/orch_/pdg_/zotero_).
 *   - packages/hep-mcp/src/tool-names.ts (hep-mcp-local; ~29 hep_* tools).
 *
 * No other *-mcp package has a local tool-names.ts as of 2026-05-22; they
 * all consume from @autoresearch/shared. If a future *-mcp adds its own
 * local registry, add it to TOOL_NAME_SOURCES below.
 *
 * ## What is checked
 *
 * Inside `skills/**\/SKILL.md`, any token matching:
 *
 *   `<prefix>_<lowercase_identifier>`
 *
 * where <prefix> ∈ { arxiv, hepdata, hep, idea, inspire, openalex, orch,
 * pdg, zotero } MUST exist in the union of the two registries above
 * (or be explicitly listed in ALLOWED_NONEXISTENT_TOKENS with reason).
 *
 * ## KNOWN LIMITATIONS
 *
 * 1. Only backtick'd tokens are checked. SKILL.md prose like
 *    "hep_project_query_evidence returns ..." (no backticks) is invisible
 *    to the lint. Convention is to backtick all tool names in SKILL.md;
 *    review-time reviewers should call out missing backticks. Loosening
 *    to bare prose would require an exclusion list for parameter names
 *    that share the prefix family (arxiv_id, inspire_id, hep_calc_env,
 *    hep_calc_demo_*, etc.); that exclusion list itself would silently
 *    rot, so this lint stays opinionated.
 *
 * 2. The lint only catches "skill references a tool that does not exist".
 *    It does NOT catch "tool exists but is missing from skills" — adding
 *    a new tool without updating any skill is allowed and normal.
 *
 * 3. Tokens that happen to share the prefix family but are parameter
 *    names (e.g. inside an example like `inspire_search` calling
 *    convention) are still checked. Today every backtick'd token in
 *    skills/**\/SKILL.md resolves to a real tool; if a future skill
 *    backticks a parameter name (e.g. `\`arxiv_id\``), prefer rewording
 *    the prose (e.g. `<arxiv_id>` or "the arXiv ID") over adding an
 *    exemption.
 *
 * 4. The token-extraction regex stops at the first character that is not
 *    [a-z0-9_]; closing-backtick presence is not required. This handles
 *    cases like `\`inspire_literature(mode=get_citations)\`` correctly —
 *    we extract `inspire_literature` and ignore the `(mode=...)` tail.
 *
 * 5. Tool names declared OUTSIDE the canonical tool-names.ts files (e.g.
 *    `DEEP_ANALYZE_INTERNAL_TOOL_NAME = 'inspire_deep_analyze_internal'`
 *    in packages/hep-mcp/src/tools/research/latex/keyEquationIdentifier.ts
 *    as of 2026-05-22) are NOT in the registry and will be flagged if a
 *    skill references them. The fix is to either move the declaration
 *    into a canonical tool-names.ts, or add the token to
 *    ALLOWED_NONEXISTENT_TOKENS with a reason pointing at the declaration
 *    site. Widening the data-source scan to grep every TS file under
 *    packages/ for *_TOOL_NAME constants would be one option, but doing
 *    so today would silently legitimize the irregular pattern; preferring
 *    the explicit exemption keeps the registries honest.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Sources to scan for real tool names. Each is a TS file containing one or
// more `export const TOOL_NAME = 'tool_value' as const;` declarations.
const TOOL_NAME_SOURCES = [
  'packages/shared/src/tool-names.ts',
  'packages/hep-mcp/src/tool-names.ts',
];

// Token prefixes that identify a "tool-like" backtick'd identifier in
// SKILL.md prose. Adding a new MCP-style prefix (e.g. when a new family
// of tools lands) should add to this list.
const TOOL_PREFIXES = [
  'arxiv', 'hep', 'hepdata', 'idea', 'inspire', 'openalex', 'orch', 'pdg', 'zotero',
];

// Skill source roots to scan.
const SKILL_ROOTS = ['skills'];

/**
 * Tokens that look like tool names (match the prefix pattern) but are
 * deliberately not in the registry. Each entry MUST be `[token, reason]`
 * so a future maintainer can audit why it is exempt.
 *
 * When a token in this map finally gets registered in a real tool-names.ts,
 * REMOVE it from here — otherwise the lint silently masks subsequent
 * regressions of the same name.
 *
 * Today this map is empty: every backtick'd tool reference in
 * skills/**\/SKILL.md resolves to a real tool.
 */
const ALLOWED_NONEXISTENT_TOKENS = new Map([
  // ['hep_pdg_drift_check', 'P3-A future-work placeholder (not yet implemented); see ars-borrowed-backlog'],
]);

// Load-time validation: every exemption MUST carry a non-empty reason
// string. Otherwise a future maintainer can silently add `['foo']` (no
// value) or `['foo', '']` (empty reason) and Map.has() would still mask
// the regression. The script aborts with a clear error rather than
// running with a corrupted exemption map.
for (const [token, reason] of ALLOWED_NONEXISTENT_TOKENS) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      `ALLOWED_NONEXISTENT_TOKENS contains a non-string or empty token: ${JSON.stringify(token)}. ` +
      `Each entry must be ['token', 'reason'] with both non-empty.`,
    );
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error(
      `ALLOWED_NONEXISTENT_TOKENS['${token}'] has an empty or non-string reason. ` +
      `Each exemption must carry a non-empty justification so future readers can audit why.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Real-tool extraction
// ─────────────────────────────────────────────────────────────────────────────

// `export const FOO_BAR = 'foo_bar' as const;` or `... = "foo_bar" as const;`
const REAL_TOOL_DECL_RE = /^\s*export\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]([a-z][a-z0-9_]*)['"]\s+as\s+const\s*;?\s*$/;

function extractRealTools(sourceRel) {
  const abs = path.join(repoRoot, sourceRel);
  if (!existsSync(abs)) {
    return { tools: new Set(), error: `tool-name source missing: ${sourceRel}` };
  }
  const tools = new Set();
  const lines = readFileSync(abs, 'utf-8').split('\n');
  for (const line of lines) {
    const m = REAL_TOOL_DECL_RE.exec(line);
    if (!m) continue;
    const [, constName, value] = m;
    // Filter out prefix sentinels: HEP_RUN_PREFIX = 'hep_run_' is a guard
    // value, not a real tool.
    if (constName.endsWith('_PREFIX')) continue;
    if (value.endsWith('_')) continue;
    tools.add(value);
  }
  return { tools, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill scanning
// ─────────────────────────────────────────────────────────────────────────────

function listSkillFiles() {
  // Walks `skills/<dir>/SKILL.md` and `skills/<group>/<dir>/SKILL.md`
  // (e.g. `skills/.system/skill-creator/SKILL.md`). Each directory under
  // SKILL_ROOTS is either a leaf skill (has its own SKILL.md) or a group
  // container whose immediate children may be skills. We cover both shapes
  // by checking the direct SKILL.md AND recursing one level when no direct
  // SKILL.md is present (covers `.system/`-style namespaces without
  // descending into arbitrary skill internals like `scripts/`).
  const out = [];
  for (const root of SKILL_ROOTS) {
    const rootAbs = path.join(repoRoot, root);
    if (!existsSync(rootAbs)) continue;
    for (const entry of readdirSync(rootAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirAbs = path.join(rootAbs, entry.name);
      const directMd = path.join(dirAbs, 'SKILL.md');
      if (existsSync(directMd) && statSync(directMd).isFile()) {
        out.push(path.relative(repoRoot, directMd));
        continue;
      }
      // No direct SKILL.md → treat as group container; pick up immediate
      // children with their own SKILL.md.
      for (const child of readdirSync(dirAbs, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const nestedMd = path.join(dirAbs, child.name, 'SKILL.md');
        if (existsSync(nestedMd) && statSync(nestedMd).isFile()) {
          out.push(path.relative(repoRoot, nestedMd));
        }
      }
    }
  }
  return out.sort();
}

// Matches a backtick followed by <prefix>_<lowercase token>.
// Captures the matched token without the opening backtick.
const TOKEN_EXTRACT_RE = new RegExp(
  '`(' + TOOL_PREFIXES.join('|') + ')_([a-z][a-z0-9_]*)',
  'g',
);

function extractTokensFromSkill(relPath) {
  const abs = path.join(repoRoot, relPath);
  const lines = readFileSync(abs, 'utf-8').split('\n');
  const hits = [];
  lines.forEach((line, idx) => {
    let match;
    // Reset state for each line so the global regex doesn't carry lastIndex
    // across iterations of forEach.
    TOKEN_EXTRACT_RE.lastIndex = 0;
    while ((match = TOKEN_EXTRACT_RE.exec(line)) !== null) {
      const token = `${match[1]}_${match[2]}`;
      hits.push({ token, lineNumber: idx + 1, lineText: line });
    }
  });
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const errors = [];

  // Build the union of real tool names from all sources.
  const realTools = new Set();
  for (const sourceRel of TOOL_NAME_SOURCES) {
    const { tools, error } = extractRealTools(sourceRel);
    if (error) {
      errors.push(`source-scan: ${error}`);
      continue;
    }
    for (const t of tools) realTools.add(t);
  }

  if (realTools.size === 0 && errors.length === 0) {
    errors.push(
      'no real tools extracted from any source — TOOL_NAME_SOURCES may be ' +
      'mis-configured or the REAL_TOOL_DECL_RE may have drifted from the ' +
      'actual export shape.',
    );
  }

  // Scan every skill file.
  const skillFiles = listSkillFiles();
  let totalTokens = 0;
  let totalUnique = 0;
  const uniqueSeen = new Set();
  for (const skillRel of skillFiles) {
    for (const { token, lineNumber, lineText } of extractTokensFromSkill(skillRel)) {
      totalTokens += 1;
      if (!uniqueSeen.has(token)) {
        uniqueSeen.add(token);
        totalUnique += 1;
      }
      if (realTools.has(token)) continue;
      if (ALLOWED_NONEXISTENT_TOKENS.has(token)) continue;
      errors.push(
        `${skillRel}:${lineNumber}: token \`${token}\` not found in the ` +
        `tool-name registries (${TOOL_NAME_SOURCES.join(', ')}). ` +
        `Line: ${lineText.trim()}`,
      );
    }
  }

  if (errors.length > 0) {
    process.stderr.write('[skill-tool-name-drift] skill tool-name anti-drift check failed:\n\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write(
      '\nEvery backtick\'d tool-name reference inside skills/**/SKILL.md must ' +
      'resolve to a real tool in:\n' +
      TOOL_NAME_SOURCES.map((s) => `  - ${s}\n`).join('') +
      '\nIf a referenced name is a deliberate placeholder for not-yet-implemented ' +
      'future work, add it to ALLOWED_NONEXISTENT_TOKENS in ' +
      'scripts/check-skill-tool-name-anti-drift.mjs with file:line + reason.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `[ok] all ${totalUnique} unique backtick'd tool tokens (${totalTokens} occurrences) ` +
    `across ${skillFiles.length} SKILL.md files resolve to real tools in ` +
    `${TOOL_NAME_SOURCES.length} tool-name registries (${realTools.size} tools total).\n`,
  );
}

main();
