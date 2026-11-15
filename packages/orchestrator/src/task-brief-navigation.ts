import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { createMarkdownHtmlContext } from './markdown-html-context.js';

export type TaskBriefNavigation = {
  status: 'unselected' | 'available' | 'unavailable' | 'ambiguous';
  source: 'research_plan.md#Current Status';
  path: string | null;
  candidates: string[];
  freshness: 'unchecked';
  scientific_acceptance: 'not_assessed';
  restore_argv: string[] | null;
  reason: string | null;
};

function nodeText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  return 'children' in node ? node.children.map(nodeText).join('') : '';
}

function containsHtml(node: Nodes): boolean {
  return node.type === 'html' || ('children' in node && node.children.some(containsHtml));
}

function selectedLinks(node: Nodes, targets: string[] | null, html: ReturnType<typeof createMarkdownHtmlContext>): void {
  if (node.type === 'html') { html.scan(node.value); return; }
  if (node.type === 'blockquote') {
    for (const child of node.children) selectedLinks(child, null, html);
    return;
  }
  if (node.type === 'code' || node.type === 'inlineCode'
    || node.type === 'image' || node.type === 'imageReference') return;
  const selected = !html.hidden && targets && !containsHtml(node) && nodeText(node).trim().toLowerCase() === 'task brief';
  if (selected && node.type === 'link') targets.push(node.url);
  if (selected && node.type === 'linkReference') {
    throw new Error('Use an explicit inline [Task brief](artifacts/runs/<run-id>/task_brief.md) link.');
  }
  if ('children' in node) for (const child of node.children) selectedLinks(child, targets, html);
}

function regularFile(root: string, relative: string): string {
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Expected a regular project file without symlink components: ${relative}`);
    }
  }
  return current;
}

function briefPath(raw: string): string {
  if (/[?#]/.test(raw)) throw new Error('Task brief link must name a file without a query or fragment.');
  const target = decodeURIComponent(raw);
  const parts = target.split('/');
  if (parts.length < 4 || parts[0] !== 'artifacts' || parts[1] !== 'runs' || !target.endsWith('.md')
    || /[\\\u0000-\u001f\u007f]/.test(target) || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Task brief must be a project-relative Markdown file under artifacts/runs/<run-id>/.');
  }
  return target;
}

/** Read navigation only. The existing Python helper owns brief metadata and
 * byte-freshness checks; status neither hashes selected inputs nor grants
 * scientific acceptance. Historical runs are never searched for a newest brief. */
export function readTaskBriefNavigation(projectRoot: string): TaskBriefNavigation {
  const result: TaskBriefNavigation = {
    status: 'unselected', source: 'research_plan.md#Current Status', path: null,
    candidates: [], freshness: 'unchecked', scientific_acceptance: 'not_assessed',
    restore_argv: null, reason: null,
  };
  try {
    if (!fs.lstatSync(path.join(projectRoot, 'research_plan.md'), { throwIfNoEntry: false })) return result;
    const plan = regularFile(projectRoot, 'research_plan.md');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(plan));
    const tree = fromMarkdown(text);
    const html = createMarkdownHtmlContext();
    let inStatus = false;
    let sections = 0;
    for (const node of tree.children) {
      if (node.type === 'heading' && !html.hidden) {
        inStatus = node.depth === 2 && !containsHtml(node) && nodeText(node).trim().toLowerCase() === 'current status';
        if (inStatus) sections += 1;
        selectedLinks(node, null, html);
      } else selectedLinks(node, inStatus ? result.candidates : null, html);
    }
    if (sections > 1 || result.candidates.length > 1) {
      return { ...result, status: 'ambiguous', reason: 'Select one Task brief in one Current Status section; no implicit latest-run selection.' };
    }
    if (!result.candidates.length) return result;
    result.path = briefPath(result.candidates[0]!);
    regularFile(projectRoot, result.path);
    const helper = fileURLToPath(new URL('../../../skills/research-harness/scripts/task_brief.py', import.meta.url));
    if (!fs.statSync(helper).isFile()) throw new Error('Task brief restore helper unavailable.');
    return { ...result, status: 'available', restore_argv: [
      'python3', helper, 'restore', '--project-root', path.resolve(projectRoot), '--brief', result.path,
    ] };
  } catch (error) {
    return { ...result, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}
