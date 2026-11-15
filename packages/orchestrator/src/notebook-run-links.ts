import * as fs from 'node:fs';
import * as path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mathFromMarkdown } from 'mdast-util-math';
import { math } from 'micromark-extension-math';
import type { Nodes } from 'mdast';
import { createMarkdownHtmlContext } from './markdown-html-context.js';
import { stripCurrentStateBlock } from './notebook-current-state.js';
import type { ValidityLedgerView, ValidityState } from './validity-ledger.js';

/** Objective run references in the user's research notes. Ledger validity
 * describes a cited run, not whether the surrounding discussion misuses it.
 * Scientific interpretation belongs to the host and the notebook review. */
export type NotebookRunCitation = {
  section: string;
  run_id: string;
  validity: ValidityState | null;
  superseded_by: string | null;
};

export type NotebookRunLinksReport = {
  notebook_found: boolean;
  citations: NotebookRunCitation[];
  /** Referenced run IDs absent from both the ledger and known run directories. */
  unknown_run_ids: string[];
};

const INDENTED_CODE_LINE = /^(?: {4}|\t)/;
const RUN_LINK_PATTERN = /^(?:\.\/)?(?:artifacts|team)\/runs\/([^/#?]+)(\/|(?=[?#]|$))/;

function runIdFromTarget(target: string, ledger: ValidityLedgerView, existingRunDirIds: ReadonlySet<string>): string | null {
  const runMatch = RUN_LINK_PATTERN.exec(target);
  if (!runMatch) return null;
  const id = runMatch[1]!;
  if (id === '.' || id === '..') return null;
  // A path inside a run or a directory link ending in '/' identifies its
  // run segment. A bare target needs an existing directory or ledger identity;
  // otherwise it may be a root-level metadata file, not a run reference.
  if (runMatch[2] !== '/' && !ledger.runs.has(id) && !existingRunDirIds.has(id)) return null;
  return id;
}

/** Visible evidence links by human notebook section. The CommonMark tree
 * distinguishes links, images, raw HTML and reference syntax at their own
 * source positions; no destination-set intersection can promote hidden text.
 * Shortcut references and indented link lines remain outside the bounded
 * dialect. Navigation never establishes scientific completeness. */
export function notebookSectionLinkTargets(text: string): Array<{ heading: string; targets: string[] }> {
  const source = stripCurrentStateBlock(text);
  const lines = source.split('\n');
  const tree = fromMarkdown(source, { extensions: [math()], mdastExtensions: [mathFromMarkdown()] });
  const definitions = new Map<string, string>();
  function walk(node: Nodes, visit: (node: Nodes) => void): void {
    visit(node);
    if ('children' in node) for (const child of node.children) walk(child, visit);
  }
  walk(tree, node => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });
  const sections: Array<{ heading: string; targets: Set<string> }> = [];
  let current: Set<string> | null = null;
  const html = createMarkdownHtmlContext();
  function collect(node: Nodes): void {
    // Image alt content, raw HTML and code have no visible Markdown links.
    if (node.type === 'html') { html.scan(node.value); return; }
    if (node.type === 'image' || node.type === 'imageReference'
      || node.type === 'code' || node.type === 'inlineCode') return;
    if (node.type === 'link' || node.type === 'linkReference') {
      const line = node.position?.start.line;
      if (line === undefined || INDENTED_CODE_LINE.test(lines[line - 1] ?? '')) return;
      const target = node.type === 'link' ? node.url
        : node.referenceType === 'shortcut' ? undefined : definitions.get(node.identifier);
      if (target !== undefined && !html.hidden) current?.add(target);
      if ('children' in node) for (const child of node.children) collect(child);
      return;
    }
    if ('children' in node) for (const child of node.children) collect(child);
  }
  for (const node of tree.children) {
    const line = node.position?.start.line;
    const rawHeading = line === undefined ? '' : lines[line - 1] ?? '';
    if (node.type === 'heading' && node.depth === 2 && /^##[ \t]+/.test(rawHeading) && !html.hidden) {
      current = new Set<string>();
      sections.push({ heading: rawHeading.replace(/^##[ \t]+/, '').trim(), targets: current });
      // Heading links are not body evidence, but their HTML can change the
      // rendering context of the body that follows.
      walk(node, child => { if (child.type === 'html') html.scan(child.value); });
    } else collect(node);
  }
  return sections.map(section => ({ heading: section.heading, targets: [...section.targets] }));
}

export function analyzeNotebookRunLinks(
  projectRoot: string,
  ledger: ValidityLedgerView,
  existingRunDirIds: ReadonlySet<string>,
): NotebookRunLinksReport {
  const report: NotebookRunLinksReport = {
    notebook_found: false,
    citations: [],
    unknown_run_ids: [],
  };
  const notebookPath = path.join(projectRoot, 'research_notebook.md');
  if (!fs.existsSync(notebookPath)) return report;
  report.notebook_found = true;
  const text = fs.readFileSync(notebookPath, 'utf-8');
  const unknown = new Set<string>();
  for (const section of notebookSectionLinkTargets(text)) {
    const seen = new Set<string>();
    for (const target of section.targets) {
      const runId = runIdFromTarget(target, ledger, existingRunDirIds);
      if (runId === null || seen.has(runId)) continue;
      seen.add(runId);
      const run = ledger.runs.get(runId);
      report.citations.push({
        section: section.heading,
        run_id: runId,
        validity: run?.validity ?? null,
        superseded_by: run?.superseded_by ?? null,
      });
      if (run === undefined && !existingRunDirIds.has(runId)) unknown.add(runId);
    }
  }
  report.unknown_run_ids = [...unknown];
  return report;
}
