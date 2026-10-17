#!/usr/bin/env node

/**
 * LANG-01: source-language anti-drift.
 *
 * Source code under packages/<pkg>/src/ (.ts and .py) is English only: no
 * CJK characters in identifiers, strings or comments. The check scans every
 * such file, skips generated code (any `generated/` directory) and lines that
 * carry the contract's exemption marker `CONTRACT-EXEMPT: LANG-01`, and fails
 * with file:line for every remaining hit.
 *
 * Scope is deliberately packages/*\/src only: documentation, skill templates
 * (skills/**), tests and package-local scripts are outside LANG-01 and may be
 * bilingual.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCE_EXTENSIONS = Object.freeze(['.ts', '.py']);
export const EXEMPTION_MARKER = 'CONTRACT-EXEMPT: LANG-01';
// Han ideographs plus the Japanese/Korean syllabaries and CJK punctuation;
// the contract's own grep covered U+4E00–U+9FFF, this is a superset.
export const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === 'generated' || entry.name === 'node_modules') continue;
      yield* walk(full);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      yield full;
    }
  }
}

/** Lists `packages/<pkg>/src` directories that exist under repoRoot. */
export function sourceRoots(repoRoot) {
  const packagesDir = path.join(repoRoot, 'packages');
  const roots = [];
  for (const name of readdirSync(packagesDir).sort()) {
    const src = path.join(packagesDir, name, 'src');
    try { if (statSync(src).isDirectory()) roots.push(src); } catch { /* no src dir */ }
  }
  return roots;
}

/**
 * Returns `{ files, hits }`: files scanned and `[{ file, line, text }]` for
 * every line with a CJK character that does not carry the exemption marker.
 */
export function scanSourceLanguage({ repoRoot = scriptRepoRoot } = {}) {
  const hits = [];
  let files = 0;
  for (const root of sourceRoots(repoRoot)) {
    for (const file of walk(root)) {
      files += 1;
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const text = lines[i];
        if (!CJK_PATTERN.test(text)) continue;
        if (text.includes(EXEMPTION_MARKER)) continue;
        hits.push({ file: path.relative(repoRoot, file), line: i + 1, text: text.trim() });
      }
    }
  }
  return { files, hits };
}

function isMain() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === modulePath;
  }
}

if (isMain()) {
  const { files, hits } = scanSourceLanguage();
  if (hits.length) {
    console.error(`[source-language] FAIL (LANG-01): ${hits.length} line(s) with CJK characters in packages/*/src`);
    for (const hit of hits) console.error(`  ${hit.file}:${hit.line}: ${hit.text}`);
    console.error(`  Translate to English, or mark the line with \`${EXEMPTION_MARKER} <reason>\` when no standard English term exists.`);
    process.exit(1);
  }
  console.log(`[source-language] ok — ${files} source files under packages/*/src carry no CJK characters`);
}
