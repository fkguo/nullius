#!/usr/bin/env node

/**
 * Transcription-fidelity checklist anti-drift CI check.
 *
 * The "Extraction / transcription fidelity" failure checklist — items (a)–(g)
 * — is defined CANONICALLY in skills/research-integrity/SKILL.md and is
 * restated / referenced by sibling skills. Nothing else keeps those copies in
 * sync, so a label edit in one file can silently diverge from the canonical
 * list. This lock asserts:
 *
 *   1. LABEL-SET SYNC. The short label of every item (a)–(g) parsed from the
 *      canonical bullet list in research-integrity/SKILL.md is identical
 *      (letter -> normalized label) to the inline enumeration restated in
 *      deep-literature-review/SKILL.md.
 *
 *   2. LETTER-RANGE SYNC. Every "(a)–(g)" range reference to the checklist
 *      (today: review-swarm/SKILL.md and claim-grounding/SKILL.md) spans the
 *      exact letters defined canonically — so adding an (h) item, or dropping
 *      (g), fails CI until the range references are updated to match.
 *
 * The check is a structural parse — same shape as the other anti-drift
 * scripts in this directory (e.g. check-skill-tool-name-anti-drift.mjs).
 *
 * ## What is the canonical source
 *
 * skills/research-integrity/SKILL.md owns the list as a bullet block:
 *
 *   - **(a) equation misquote** — a sign, coefficient, index, ...
 *   - **(b) wrong numeric value** — a transposed digit, ...
 *   ...
 *
 * The bold span immediately after the "(x)" marker is the short label.
 *
 * ## KNOWN LIMITATIONS
 *
 * 1. The restated inline enumeration is tracked explicitly
 *    (RESTATED_ENUMERATION_FILES). If a NEW skill restates the (a)–(g) labels
 *    inline, add it to that list — the lock cannot discover an arbitrary new
 *    prose restatement of the labels. The letter-range scan (assertion 2) IS
 *    discovery-based and needs no such list.
 *
 * 2. The letter-range scan flags any SKILL.md that references a "(a)–(x)"
 *    range, so a new range-referencing file is caught automatically. As of
 *    this writing the only such ranges in skills/ are the two
 *    transcription-fidelity references; if an unrelated "(a)–(x)" range is
 *    ever added to a skill, narrow RANGE_SCAN_RE or exempt that file.
 *
 * 3. Label comparison is normalized (lowercase, whitespace-collapsed). A
 *    purely cosmetic re-casing / re-spacing of a label in one file will NOT
 *    trip the lock; a semantic word change will.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Canonical owner of the (a)–(g) checklist (bullet-list form).
const CANONICAL_FILE = 'skills/research-integrity/SKILL.md';

// Files that restate the full short-label set inline. Each MUST carry the same
// letter -> label set as CANONICAL_FILE. See KNOWN LIMITATION 1.
const RESTATED_ENUMERATION_FILES = ['skills/deep-literature-review/SKILL.md'];

// Skill roots scanned for "(a)–(x)" range references (assertion 2).
const SKILL_ROOTS = ['skills'];

// Canonical bullet line: "- **(a) equation misquote** — a sign, ..."
// Captures the letter and the bold short label (up to the closing "**").
const CANONICAL_ITEM_RE = /^-\s+\*\*\(([a-z])\)\s+(.+?)\*\*/;

// A "(x)–(y)" / "(x)-(y)" range reference (en-dash U+2013 or hyphen).
const RANGE_SCAN_RE = /\(([a-z])\)[–-]\(([a-z])\)/g;

function normalizeLabel(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function readRepoFile(relPath) {
  const abs = path.join(repoRoot, relPath);
  if (!existsSync(abs)) return { text: null, error: `file missing: ${relPath}` };
  return { text: readFileSync(abs, 'utf-8'), error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical bullet-list parse
// ─────────────────────────────────────────────────────────────────────────────

function parseCanonical(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = CANONICAL_ITEM_RE.exec(line);
    if (!m) continue;
    const [, letter, label] = m;
    map.set(letter, normalizeLabel(label));
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Restated inline enumeration parse
//   "... handoff: (a) equation misquote, (b) wrong numeric value, ...,
//    (g) silent factor drop (full definitions: ..."
// ─────────────────────────────────────────────────────────────────────────────

function parseRestated(text) {
  // Flatten wrapped lines so the comma-separated run is contiguous.
  const flat = text.replace(/\s+/g, ' ');
  // The enumeration opens at the first "(a)" and is closed by the
  // "(full definitions" back-reference that points to the canonical skill.
  const region = flat.match(/\(a\)\s.*?(?=\(full definitions)/);
  if (!region) {
    return { map: null, error: 'inline "(a) … (full definitions" enumeration not found' };
  }
  const map = new Map();
  // Each item is "(letter) label", terminated by the next "(letter)" or end.
  const itemRe = /\(([a-z])\)\s*([^()]*?)\s*(?=,\s*\([a-z]\)|$)/g;
  let m;
  while ((m = itemRe.exec(region[0])) !== null) {
    const [, letter, label] = m;
    if (label.length > 0) map.set(letter, normalizeLabel(label));
  }
  return { map, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill-file discovery (for the range scan)
// ─────────────────────────────────────────────────────────────────────────────

function listSkillFiles() {
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

function scanRanges(relPath, text) {
  const hits = [];
  text.split('\n').forEach((line, idx) => {
    RANGE_SCAN_RE.lastIndex = 0;
    let m;
    while ((m = RANGE_SCAN_RE.exec(line)) !== null) {
      hits.push({ relPath, lineNumber: idx + 1, low: m[1], high: m[2], lineText: line });
    }
  });
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function diffMaps(canonical, other, otherLabel) {
  const errs = [];
  const letters = new Set([...canonical.keys(), ...other.keys()]);
  for (const letter of [...letters].sort()) {
    const a = canonical.get(letter);
    const b = other.get(letter);
    if (a === undefined) {
      errs.push(`${otherLabel}: item (${letter}) "${b}" is not in the canonical list (${CANONICAL_FILE}).`);
    } else if (b === undefined) {
      errs.push(`${otherLabel}: canonical item (${letter}) "${a}" is missing from this file.`);
    } else if (a !== b) {
      errs.push(`${otherLabel}: item (${letter}) label "${b}" != canonical "${a}".`);
    }
  }
  return errs;
}

function main() {
  const errors = [];

  // 1. Parse the canonical list.
  const canonicalRead = readRepoFile(CANONICAL_FILE);
  if (canonicalRead.error) {
    process.stderr.write(`[transcription-fidelity-drift] ${canonicalRead.error}\n`);
    process.exitCode = 1;
    return;
  }
  const canonical = parseCanonical(canonicalRead.text);

  if (canonical.size === 0) {
    errors.push(
      `no "(x)" checklist items parsed from ${CANONICAL_FILE} — the canonical bullet ` +
      `shape ("- **(a) label** — …") may have drifted from CANONICAL_ITEM_RE.`,
    );
  } else {
    // Sanity: canonical letters must be a contiguous run starting at "a".
    const letters = [...canonical.keys()].sort();
    const expected = letters.map((_, i) => String.fromCharCode(97 + i));
    if (letters.join('') !== expected.join('')) {
      errors.push(
        `canonical checklist letters ${JSON.stringify(letters)} are not a contiguous ` +
        `run starting at "a" — expected ${JSON.stringify(expected)}.`,
      );
    }
  }

  const canonicalLow = 'a';
  const canonicalHigh = canonical.size > 0 ? [...canonical.keys()].sort().at(-1) : null;

  // 2. Label-set sync: every restating file matches the canonical set.
  for (const relPath of RESTATED_ENUMERATION_FILES) {
    const read = readRepoFile(relPath);
    if (read.error) {
      errors.push(read.error);
      continue;
    }
    const { map, error } = parseRestated(read.text);
    if (error) {
      errors.push(`${relPath}: ${error}`);
      continue;
    }
    errors.push(...diffMaps(canonical, map, relPath));
  }

  // 3. Letter-range sync: every "(x)–(y)" range in skills spans the canonical
  //    letters. Discovery-based, so a new range-referencing file is caught.
  if (canonicalHigh) {
    for (const relPath of listSkillFiles()) {
      const read = readRepoFile(relPath);
      if (read.error) continue;
      for (const hit of scanRanges(relPath, read.text)) {
        if (hit.low !== canonicalLow || hit.high !== canonicalHigh) {
          errors.push(
            `${relPath}:${hit.lineNumber}: range reference "(${hit.low})–(${hit.high})" does not ` +
            `match the canonical span "(${canonicalLow})–(${canonicalHigh})" from ${CANONICAL_FILE}. ` +
            `Line: ${hit.lineText.trim()}`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write('[transcription-fidelity-drift] checklist anti-drift check failed:\n\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write(
      `\nThe "Extraction / transcription fidelity" checklist is owned by ${CANONICAL_FILE}.\n` +
      `Keep the restated label set (${RESTATED_ENUMERATION_FILES.join(', ')}) and every "(a)–(g)" ` +
      `range reference in skills/**/SKILL.md in lockstep with it. If you intentionally added or ` +
      `removed an item, update all copies and the range references in the same change.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `[ok] transcription-fidelity checklist in sync: canonical items (${canonicalLow})–(${canonicalHigh}) ` +
    `in ${CANONICAL_FILE} match ${RESTATED_ENUMERATION_FILES.length} restated enumeration(s) ` +
    `and all "(a)–(${canonicalHigh})" range references across skills/.\n`,
  );
}

main();
