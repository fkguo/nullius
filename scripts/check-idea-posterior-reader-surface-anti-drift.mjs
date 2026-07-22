#!/usr/bin/env node

/** Keep static and event-created argument-graph text on one visible contract. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererPath = 'skills/idea-posterior/scripts/render_argument_graph.py';
const browserTestPath = 'skills/idea-posterior/tests/test_reader_surface_interactions.py';
const skillPath = 'skills/idea-posterior/SKILL.md';
const ciPath = '.github/workflows/ci.yml';

const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const renderer = read(rendererPath);
const browserTest = read(browserTestPath);
const skill = read(skillPath);
const failures = [];

const required = new Map([
  [rendererPath, [
    'VISIBLE_PROBABILITY_DIGITS = 3',
    'argument_graph_reader_surface_contract_v1',
    '"static_states": ["initial_canvas"]',
    '"edge_tooltip"',
    '"node_detail_panel"',
    '"expanded_legend"',
    '"control_ids": ["themetoggle", "zout", "zin", "zfit", "panel-close"]',
    '"expandable_ids": ["legend"]',
    '"filter_controls": []',
    '"interaction_evidence_required": True',
    'format_probability(node.belief)',
    'Number(value).toFixed(VISIBLE_PROBABILITY_DIGITS)',
    "belief.textContent = 'posterior belief ' + fmtP(node.belief)",
    "' (pinned at ' + fmtP(node.pinned_prior)",
    "close.id = 'panel-close'",
  ]],
  [browserTestPath, [
    "new MouseEvent('click'",
    "new PointerEvent('pointermove'",
    'legend.open = true',
    'result["contract"]',
    'result["observed_detail"]',
    'result["control_ids"]',
    'result["expandable_ids"]',
    'captureReaderInventory();',
    'captureExpandableIds();',
    'reader control lacks a stable id',
    'reader expandable lacks a stable id',
    "doc.querySelectorAll('button,input,select,textarea')",
    "doc.querySelectorAll('details')",
    'VISIBLE_PROBABILITY_DIGITS',
  ]],
  [skillPath, [
    'one visible-probability formatter',
    'initial-DOM inspection is only a quick drift check',
    'interaction-state evidence or fail closed',
  ]],
  [ciPath, [
    'Check idea-posterior reader-surface anti-drift',
    'test_reader_surface_interactions.py -q',
  ]],
]);

for (const [relativePath, anchors] of required) {
  const content = read(relativePath);
  for (const anchor of anchors) {
    if (!content.includes(anchor)) {
      failures.push(`${relativePath}: missing contract anchor ${JSON.stringify(anchor)}`);
    }
  }
}

if (/\.toFixed\(\d+\)/.test(renderer)) {
  failures.push(`${rendererPath}: hard-coded JavaScript precision bypasses the shared formatter`);
}
if (browserTest.includes('pytest.skip')) {
  failures.push(`${browserTestPath}: browser evidence must fail closed when unavailable`);
}

if (failures.length > 0) {
  process.stderr.write('[idea-posterior-reader-surface-drift] anti-drift check failed:\n\n');
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write('[idea-posterior-reader-surface-drift] anti-drift check passed.\n');
