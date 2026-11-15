import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateResultRegistry } from './result-registry.js';
import { notebookSectionLinkTargets } from './notebook-run-links.js';
import { checkNotebookContentReview } from './notebook-content-review.js';

export type NotebookResultLinks = {
  status: 'not_applicable' | 'unavailable' | 'missing_links' | 'linked';
  results: Array<{ result_id: string; artifact: string | null; sections: string[] }>;
  missing_result_ids: string[];
  reason: string | null;
  scope: string;
};

// Normalize project-relative Markdown destinations, without reading linked
// files or following symlinks. Registry validation owns artifact validity.
function localTarget(raw: string): string | null {
  const unwrapped = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  let target: string;
  try { target = decodeURIComponent(unwrapped.split(/[?#]/, 1)[0]!); }
  catch { return null; }
  return localPath(target);
}

function localPath(target: string): string | null {
  if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || path.posix.isAbsolute(target)
    || target.includes('\\')) return null;
  const normalized = path.posix.normalize(target);
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
}

/** Necessary traceability check, NOT a prose or derivation quality verdict.
 * Status/current expose missing links even in file mode. Scoped checks are
 * diagnostics; closeout requires the unscoped check and a valid result registry.
 * Automatic state tables, comments and code examples cannot satisfy it. */
export function checkNotebookResultLinks(
  projectRoot: string, current: readonly Pick<ReturnType<typeof validateResultRegistry>['current'][number], 'result_id' | 'artifact_target'>[],
): NotebookResultLinks {
  const report: NotebookResultLinks = {
    status: 'not_applicable', results: [], missing_result_ids: [], reason: null,
    scope: 'Direct artifact links in human ## sections only; no recursive, HTML, shortcut or indented-link scan. '
      + 'Links do not establish explanation, derivation completeness, correctness or verification.',
  };
  if (current.length === 0) return report;
  let text: string;
  try { text = fs.readFileSync(path.join(projectRoot, 'research_notebook.md'), 'utf-8'); }
  catch {
    return { ...report, status: 'unavailable', reason: 'research_notebook.md missing or unreadable' };
  }
  const sections = notebookSectionLinkTargets(text)
    .map(section => ({ ...section, targets: new Set(section.targets.map(localTarget).filter(Boolean)) }));
  report.results = current.map(row => {
    // Registry artifacts are literal filesystem paths, not URI destinations.
    // Match the registry resolver's fragment rule without decoding '%' or
    // treating a literal '?' in the filename as a URL query delimiter.
    const target = row.artifact_target === null ? null : localPath(row.artifact_target.split('#', 1)[0]!);
    return {
      result_id: row.result_id, artifact: row.artifact_target,
      sections: target === null ? [] : sections.filter(section => section.targets.has(target)).map(section => section.heading),
    };
  });
  report.missing_result_ids = report.results.filter(row => row.sections.length === 0).map(row => row.result_id);
  report.status = report.missing_result_ids.length ? 'missing_links' : 'linked';
  return report;
}

export function checkNotebookStructure(projectRoot: string, resultId?: string): NotebookResultLinks {
  try {
    const registry = validateResultRegistry(projectRoot);
    let current = registry.current;
    // A malformed row can hide another definition of the selected id, so it
    // remains global. Other row-local defects do not block an unrelated id.
    if (!registry.block_found || registry.issues.some(issue => issue.code === 'malformed_result_row')
      || (resultId === undefined && registry.issues.length > 0)) {
      throw new Error('results registry absent or defective; inspect nullius current before checking notebook links');
    }
    if (resultId !== undefined) {
      current = current.filter(row => row.result_id === resultId);
      if (current.length === 0) throw new Error(`no current registered result: ${resultId}`);
      if (registry.defective_result_ids.has(resultId)) throw new Error(`defective current result: ${resultId}`);
    }
    return checkNotebookResultLinks(projectRoot, current);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'unavailable', reason, results: [], missing_result_ids: [], scope: 'Result-link structure unavailable; content review is evaluated separately.' };
  }
}

/** Both engine A5 and file closeout require the same current structure and
 * whole-notebook semantic review. Selecting a result only scopes structure. */
export function notebookCloseoutGate(projectRoot: string): { decision: 'pass' | 'hold' | 'unavailable'; summary: string } {
  const structure = checkNotebookStructure(projectRoot);
  const content = checkNotebookContentReview(projectRoot);
  const ready = (structure.status === 'linked' || structure.status === 'not_applicable') && content.status === 'accepted';
  return { decision: ready ? 'pass' : structure.status === 'unavailable' || content.status === 'unavailable' ? 'unavailable' : 'hold',
    summary: `Notebook structure: ${structure.status}. ${structure.reason ?? structure.missing_result_ids.join(', ')} Whole-notebook content review: ${content.status}. ${content.reason}` };
}

/** Read-only closeout check for external-agent/file-mode work. Result-scoped
 * checks do not turn unrelated historical structural gaps into blockers. */
export function runNotebookCheck(
  projectRoot: string, resultId: string | undefined, json: boolean,
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
  structureOnly = false,
): number {
  const content_review = checkNotebookContentReview(projectRoot);
  const report = checkNotebookStructure(projectRoot, resultId);
  const structurePassed = report.status === 'linked' || report.status === 'not_applicable';
  const accepted = structurePassed && (structureOnly || content_review.status === 'accepted');
  const unavailable = report.status === 'unavailable' || (!structureOnly && content_review.status === 'unavailable');
  const output = { status: accepted ? (structureOnly ? 'structure_passed' : resultId === undefined ? 'accepted' : 'diagnostic_passed') : unavailable ? 'unavailable' : 'incomplete', structure: report, content_review,
    acceptance_scope: structureOnly ? 'Structure only; no scientific closeout acceptance.' : 'Result-scoped structure when selected, always whole-notebook current-version content review.' };
  if (json) io.stdout(`${JSON.stringify(output, null, 2)}\n`);
  else io.stdout(`Human notebook result links: ${report.status}. ${report.reason ?? report.missing_result_ids.join(', ')}\nNotebook content review: ${content_review.status}. ${content_review.reason}\n${output.acceptance_scope}\n`);
  return accepted ? 0 : unavailable ? 2 : 1;
}
