import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HEP_EXPORT_PROJECT,
  HEP_IMPORT_PAPER_BUNDLE,
  HEP_RUN_BUILD_CITATION_MAPPING,
  invalidParams,
} from '@autoresearch/shared';
import { strToU8, unzipSync, zipSync } from 'fflate';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import {
  assertSafePathSegment,
  getProjectPaperEvidenceCatalogPath,
  getRunArtifactPath,
  getRunArtifactsDir,
  getRunManifestPath,
} from '../paths.js';
import { listPapers } from '../papers.js';
import { writeRunJsonArtifact } from '../citations.js';
import { resolvePathWithinParent } from '../../data/pathGuard.js';

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function expandTilde(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function getPdgDataDir(): string {
  const explicit = process.env.PDG_DATA_DIR;
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(expandTilde(explicit));
  }

  // Keep PDG cache colocated with a per-project HEP_DATA_DIR when available.
  const hepDataDir = process.env.HEP_DATA_DIR;
  if (hepDataDir && hepDataDir.trim().length > 0) {
    return path.resolve(path.join(expandTilde(hepDataDir), 'pdg'));
  }

  return path.resolve(path.join(os.homedir(), '.hep-research-mcp', 'pdg'));
}

function getPdgArtifactsDir(): string {
  const dataDir = getPdgDataDir();
  const candidate = path.join(dataDir, 'artifacts');
  return resolvePathWithinParent(dataDir, candidate, 'PDG artifacts dir');
}

function sha256Bytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function guessMimeTypeByName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.jsonl') return 'application/x-ndjson';
  if (ext === '.md') return 'text/markdown';
  if (ext === '.txt') return 'text/plain';
  return 'application/octet-stream';
}

function writeRunTextArtifact(params: {
  runId: string;
  artifactName: string;
  content: string;
  mimeType: string;
}): RunArtifactRef {
  const artifactPath = getRunArtifactPath(params.runId, params.artifactName);
  fs.writeFileSync(artifactPath, params.content, 'utf-8');
  return {
    name: params.artifactName,
    uri: `hep://runs/${encodeURIComponent(params.runId)}/artifact/${encodeURIComponent(params.artifactName)}`,
    mimeType: params.mimeType,
  };
}

function writeRunBinaryArtifact(params: {
  runId: string;
  artifactName: string;
  bytes: Uint8Array;
  mimeType: string;
}): RunArtifactRef {
  const artifactPath = getRunArtifactPath(params.runId, params.artifactName);
  fs.writeFileSync(artifactPath, Buffer.from(params.bytes));
  return {
    name: params.artifactName,
    uri: `hep://runs/${encodeURIComponent(params.runId)}/artifact/${encodeURIComponent(params.artifactName)}`,
    mimeType: params.mimeType,
  };
}

function computeRunStatus(manifest: RunManifest): RunManifest['status'] {
  const statuses = manifest.steps.map(s => s.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('pending') || statuses.includes('in_progress')) return 'running';
  return 'done';
}

function mergeArtifactRefs(existing: RunStep['artifacts'] | undefined, added: RunArtifactRef[]): RunArtifactRef[] {
  const byName = new Map<string, RunArtifactRef>();
  for (const a of existing ?? []) byName.set(a.name, a);
  for (const a of added) byName.set(a.name, a);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function startRunStep(runId: string, stepName: string): Promise<{ manifestStart: RunManifest; stepIndex: number; step: RunStep }> {
  const now = new Date().toISOString();
  const manifestStart = await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: HEP_EXPORT_PROJECT, args: { run_id: runId } },
    update: current => {
      const step: RunStep = { step: stepName, status: 'in_progress', started_at: now };
      const next: RunManifest = {
        ...current,
        updated_at: now,
        steps: [...current.steps, step],
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });
  const stepIndex = manifestStart.steps.length - 1;
  const step = manifestStart.steps[stepIndex]!;
  return { manifestStart, stepIndex, step };
}

function buildManifestAfterStep(params: {
  manifestStart: RunManifest;
  stepIndex: number;
  stepStart: RunStep;
  status: 'done' | 'failed';
  artifacts: RunArtifactRef[];
  now: string;
  notes?: string;
}): RunManifest {
  const step: RunStep = {
    ...params.stepStart,
    status: params.status,
    completed_at: params.now,
    artifacts: params.artifacts,
    notes: params.notes,
  };
  return {
    ...params.manifestStart,
    status: params.status === 'done' ? 'done' : 'failed',
    updated_at: params.now,
    steps: params.manifestStart.steps.map((s, idx) => (idx === params.stepIndex ? step : s)),
  };
}

function makeRunArtifactRef(runId: string, artifactName: string, mimeType: string): RunArtifactRef {
  return {
    name: artifactName,
    uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`,
    mimeType,
  };
}

function latexToNotebookMarkdown(latex: string): string {
  // Minimal, deterministic conversion for NotebookLM: keep plain text and cite keys.
  return latex
    .replace(/\\section\*\{([^}]+)\}/g, (_: string, t: string) => `# ${String(t).trim()}\n`)
    .replace(/\\section\{([^}]+)\}/g, (_: string, t: string) => `## ${String(t).trim()}\n`)
    .replace(/\\cite\{([^}]+)\}/g, (_: string, keys: string) => ` [cite: ${String(keys).trim()}]`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    + '\n';
}

function extractCiteKeysFromLatex(latex: string): string[] {
  const keys = new Set<string>();
  // Support common natbib variants: \cite, \citep, \citet, \citeauthor, \citeyear, etc.
  const re = /\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\s*\{([^}]+)\}/g;
  for (let m = re.exec(latex); m; m = re.exec(latex)) {
    const inner = String(m[1] ?? '').trim();
    if (!inner) continue;
    for (const raw of inner.split(',')) {
      const k = raw.trim();
      if (k) keys.add(k);
    }
  }
  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function tryReadBibliographyRawEntries(runId: string, artifactName: string): Map<string, string> | null {
  const p = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(p)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(p, 'utf-8')) as any;
    const entries: unknown = payload?.entries;
    if (!Array.isArray(entries)) return null;

    const out = new Map<string, string>();
    for (const e of entries) {
      const key = typeof e?.key === 'string' ? e.key.trim() : '';
      const raw = typeof e?.raw === 'string' ? e.raw.trim() : '';
      if (!key || !raw) continue;
      out.set(key, raw);
    }
    return out;
  } catch {
    return null;
  }
}

function parseBibtexEntriesByKey(bibtex: string): Map<string, string> {
  const normalized = String(bibtex ?? '').replace(/\r\n/g, '\n');
  const starts: number[] = [];
  const re = /^@/gm;
  for (let m = re.exec(normalized); m; m = re.exec(normalized)) {
    starts.push(m.index);
  }

  const out = new Map<string, string>();
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : normalized.length;
    const block = normalized.slice(start, end).trim();
    if (!block) continue;

    const keyMatch = block.match(/^@\w+\s*\{\s*([^,\s]+)\s*,/);
    const key = keyMatch?.[1]?.trim();
    if (!key) continue;

    out.set(key, block + '\n');
  }

  return out;
}

function buildMasterBib(params: {
  citeKeys: string[];
  writingMasterByKey?: Map<string, string> | null;
  bibRawByKey?: Map<string, string> | null;
}): { content: string; stats: { total: number; from_writing_master: number; from_bibliography_raw: number; missing: number }; missing_keys: string[] } {
  const parts: string[] = [];
  let fromWritingMaster = 0;
  let fromRaw = 0;
  const missingKeys: string[] = [];

  for (const key of params.citeKeys) {
    const fromMaster = params.writingMasterByKey?.get(key);
    if (fromMaster) {
      parts.push(fromMaster);
      fromWritingMaster += 1;
      continue;
    }

    const raw = params.bibRawByKey?.get(key);
    if (raw) {
      parts.push(raw);
      fromRaw += 1;
      continue;
    }
    missingKeys.push(key);
  }

  const content = parts.join('\n\n').trim() + (parts.length > 0 ? '\n' : '');
  return {
    content,
    stats: {
      total: params.citeKeys.length,
      from_writing_master: fromWritingMaster,
      from_bibliography_raw: fromRaw,
      missing: missingKeys.length,
    },
    missing_keys: missingKeys,
  };
}

type ExportEvidenceItem = {
  type?: string;
  evidence_id?: string;
  locator?: any;
  text?: string;
  meta?: any;
};

function formatLocator(locator: any): string {
  if (!locator || typeof locator !== 'object') return 'locator:unknown';
  if (locator.kind === 'latex') {
    const file = typeof locator.file === 'string' ? locator.file : 'unknown';
    const line = typeof locator.line === 'number' ? locator.line : 0;
    const column = typeof locator.column === 'number' ? locator.column : 0;
    return `latex:${file}:${line}:${column}`;
  }
  if (locator.kind === 'pdf') {
    const page = typeof locator.page === 'number' ? locator.page : 0;
    return `pdf:page:${page}`;
  }
  return `locator:${String(locator.kind ?? 'unknown')}`;
}

function toOneLinePreview(text: unknown, maxLen: number): string {
  const t = typeof text === 'string' ? text : '';
  const cleaned = t.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, Math.max(0, maxLen - 1)) + '…';
}

function collectEvidenceMarkdownLinesFromJsonl(jsonlContent: string, sourceLabel: string): string[] {
  const lines: string[] = [];
  const rows = jsonlContent.split('\n').filter(Boolean);
  for (const row of rows) {
    let item: ExportEvidenceItem | null = null;
    try {
      item = JSON.parse(row) as ExportEvidenceItem;
    } catch {
      continue;
    }
    const type = typeof item?.type === 'string' ? item.type : 'unknown';
    const evidenceId = typeof item?.evidence_id === 'string' ? item.evidence_id : 'unknown';
    const loc = formatLocator(item?.locator);
    const preview = toOneLinePreview(item?.text, 240);
    const regionUri = typeof item?.meta?.region_uri === 'string' ? item.meta.region_uri : '';
    const extra = regionUri ? ` region_uri=${regionUri}` : '';
    lines.push(`- [${sourceLabel}] ${type} (${evidenceId}) ${loc}${extra}: ${preview}`);
  }
  return lines;
}

function chunkLinesToFiles(params: {
  baseName: string;
  maxChars: number;
  header: string;
  lines: string[];
}): Array<{ name: string; content: string }> {
  const maxChars = Math.max(500, Math.trunc(params.maxChars));
  const files: Array<{ name: string; content: string }> = [];

  let buf = params.header.trimEnd() + '\n';
  let idx = 1;

  for (const line of params.lines) {
    const next = buf + line + '\n';
    if (next.length > maxChars && buf.length > params.header.length + 10) {
      files.push({ name: `${params.baseName}_${pad3(idx)}.md`, content: buf });
      idx += 1;
      buf = params.header.trimEnd() + '\n' + line + '\n';
      continue;
    }
    buf = next;
  }

  if (buf.trim().length > 0) {
    files.push({ name: `${params.baseName}_${pad3(idx)}.md`, content: buf });
  }

  return files;
}

function readRunArtifactText(runId: string, artifactName: string): string {
  const p = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(p)) throw invalidParams(`Missing run artifact: ${artifactName}`, { run_id: runId, artifact_name: artifactName });
  return fs.readFileSync(p, 'utf-8');
}

function tryReadRunArtifactText(runId: string, artifactName: string): string | null {
  const p = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

function readRunArtifactJson<T>(runId: string, artifactName: string): T {
  const raw = readRunArtifactText(runId, artifactName);
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw invalidParams(`Invalid JSON run artifact: ${artifactName}`, {
      run_id: runId,
      artifact_name: artifactName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function tryReadRunArtifactJson<T>(runId: string, artifactName: string): T | null {
  const raw = tryReadRunArtifactText(runId, artifactName);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function exportProjectForRun(params: {
  run_id: string;
  rendered_latex_artifact_name?: string;
  rendered_latex_verification_artifact_name?: string;
  bibliography_raw_artifact_name?: string;
  master_bib_artifact_name?: string;
  report_tex_artifact_name?: string;
  report_md_artifact_name?: string;
  research_pack_zip_artifact_name?: string;
  notebooklm_pack_prefix?: string;
  max_chars_per_notebooklm_file?: number;
  include_evidence_digests?: boolean;
  include_pdg_artifacts?: boolean;
  include_paper_bundle?: boolean;
  paper_bundle_zip_artifact_name?: string;
  paper_bundle_manifest_artifact_name?: string;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: {
    cite_keys: number;
    master_bib_entries: number;
    notebooklm_files: number;
    zip_files: number;
    pdg_artifacts: { enabled: boolean; files: number; artifacts_dir_exists: boolean };
    paper_bundle: { enabled: boolean; embedded: boolean; files: number; manifest_included: boolean };
    evidence_sources: { run_catalogs: number; project_catalogs: number; evidence_lines: number };
  };
}> {
  const runId = params.run_id;
  const run = getRun(runId);

  const { manifestStart, stepIndex, step } = await startRunStep(runId, 'export_project');
  const artifacts: RunArtifactRef[] = [];

  try {
    const renderedLatexName = params.rendered_latex_artifact_name ?? 'rendered_latex.tex';
    const latexBody = readRunArtifactText(runId, renderedLatexName);
    const citeKeys = extractCiteKeysFromLatex(latexBody);

    const renderedLatexVerificationName = params.rendered_latex_verification_artifact_name ?? 'rendered_latex_verification.json';
    const renderedLatexVerification = readRunArtifactJson<any>(runId, renderedLatexVerificationName);
    const renderedLatexVerificationText = JSON.stringify(renderedLatexVerification, null, 2);
    const renderedLatexVerificationRef = makeRunArtifactRef(runId, renderedLatexVerificationName, 'application/json');

    const bibliographyName = params.bibliography_raw_artifact_name ?? 'bibliography_raw_v1.json';
    const bibRawByKey = tryReadBibliographyRawEntries(runId, bibliographyName);

    const writingMasterBibName = 'writing_master.bib';
    const writingMasterBibText = tryReadRunArtifactText(runId, writingMasterBibName);
    const writingMasterByKey = writingMasterBibText ? parseBibtexEntriesByKey(writingMasterBibText) : null;
    const writingMasterBibRef = writingMasterBibText ? makeRunArtifactRef(runId, writingMasterBibName, 'text/x-bibtex') : null;

    const masterBib = buildMasterBib({ citeKeys, writingMasterByKey, bibRawByKey });
    if (masterBib.missing_keys.length > 0) {
      throw invalidParams('Missing BibTeX entries for one or more cite keys (fail-fast).', {
        run_id: runId,
        missing_cite_keys_total: masterBib.missing_keys.length,
        missing_cite_keys_sample: masterBib.missing_keys.slice(0, 20),
        cite_keys_total: masterBib.stats.total,
        bibliography_raw_artifact: bibliographyName,
        writing_master_bib_artifact: writingMasterBibName,
        next_actions: [
          {
            tool: HEP_RUN_BUILD_CITATION_MAPPING,
            args: { run_id: runId, identifier: '<arXiv/DOI/recid>', allowed_citations_primary: masterBib.missing_keys },
            reason: 'Build bibliography_raw_v1.json + writing_master.bib + allowed_citations_v1.json (then re-run export).',
          },
          {
            tool: HEP_EXPORT_PROJECT,
            args: { run_id: runId },
            reason: 'Re-run export after citations/bibtex are available.',
          },
        ],
      });
    }
    const masterBibName = params.master_bib_artifact_name ?? 'master.bib';
    artifacts.push(writeRunTextArtifact({
      runId,
      artifactName: masterBibName,
      content: masterBib.content,
      mimeType: 'text/plain',
    }));

    const reportTexName = params.report_tex_artifact_name ?? 'report.tex';
    const reportTex = [
      '% Auto-generated by hep_export_project (vNext M10)',
      '\\documentclass{article}',
      '\\usepackage{hyperref}',
      '\\begin{document}',
      latexBody.trim(),
      '',
      '\\bibliographystyle{unsrt}',
      '\\bibliography{master}',
      '\\end{document}',
      '',
    ].join('\n');
    artifacts.push(writeRunTextArtifact({
      runId,
      artifactName: reportTexName,
      content: reportTex,
      mimeType: 'text/x-tex',
    }));

    const reportMdName = params.report_md_artifact_name ?? 'report.md';
    const reportMd = latexToNotebookMarkdown(latexBody);
    artifacts.push(writeRunTextArtifact({
      runId,
      artifactName: reportMdName,
      content: reportMd,
      mimeType: 'text/plain',
    }));

    const notebookPrefix = params.notebooklm_pack_prefix ?? 'notebooklm_pack';
    const notebookRunManifestName = `${notebookPrefix}_run_manifest.json`;
    const notebookFiles: Array<{ name: string; content: string; mimeType: string }> = [];
    notebookFiles.push({ name: `${notebookPrefix}_report.md`, content: reportMd, mimeType: 'text/plain' });
    notebookFiles.push({ name: `${notebookPrefix}_master.bib`, content: masterBib.content, mimeType: 'text/plain' });

    // M2/P0: include verifier + coverage report in export outputs (Evidence-first).
    const runArtifactsDir = getRunArtifactsDir(runId);
    const diagnosticNames = fs.readdirSync(runArtifactsDir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('_diagnostics.json'))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b));

    let hitsTotal = 0;
    let warningsTotal = 0;
    let maxEvidenceItemsHit = false;
    const hitKeys: Array<{ key: string; dimension: string; limit: number; observed: number; action: string }> = [];

    for (const name of diagnosticNames) {
      const diag = tryReadRunArtifactJson<any>(runId, name);
      if (!diag) continue;
      const hits = Array.isArray(diag.hits) ? diag.hits : [];
      const warns = Array.isArray(diag.warnings) ? diag.warnings : [];
      hitsTotal += hits.length;
      warningsTotal += warns.length;

      for (const h of hits) {
        const key = typeof h?.key === 'string' ? h.key : '';
        const dimension = typeof h?.dimension === 'string' ? h.dimension : '';
        const limit = typeof h?.limit === 'number' ? h.limit : NaN;
        const observed = typeof h?.observed === 'number' ? h.observed : NaN;
        const action = typeof h?.action === 'string' ? h.action : '';
        if (!key) continue;
        hitKeys.push({ key, dimension, limit, observed, action });
        if (key === 'writing.max_evidence_items') maxEvidenceItemsHit = true;
      }
    }

    hitKeys.sort((a, b) => a.key.localeCompare(b.key) || a.dimension.localeCompare(b.dimension));

    const searchExportMeta = (() => {
      const metaNames = fs.readdirSync(runArtifactsDir, { withFileTypes: true })
        .filter(d => d.isFile() && d.name.startsWith('inspire_search_export_') && d.name.endsWith('_meta.json'))
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b));
      const candidates: Array<{ name: string; meta: any; exported: number; generated_at: string }> = [];
      for (const name of metaNames) {
        const meta = tryReadRunArtifactJson<any>(runId, name);
        if (!meta) continue;
        const exported = typeof meta.exported === 'number' ? meta.exported : Number(meta.exported ?? 0);
        candidates.push({
          name,
          meta,
          exported: Number.isFinite(exported) ? exported : 0,
          generated_at: typeof meta.generated_at === 'string' ? meta.generated_at : '',
        });
      }
      candidates.sort((a, b) => (b.exported - a.exported) || String(b.generated_at).localeCompare(String(a.generated_at)) || a.name.localeCompare(b.name));
      return candidates[0] ? { artifactName: candidates[0].name, meta: candidates[0].meta } : null;
    })();

    const evidenceMeta = tryReadRunArtifactJson<any>(runId, 'writing_evidence_meta_v1.json');
    const evidenceSourceStatusName = 'writing_evidence_source_status.json';
    const evidenceSourceStatus = tryReadRunArtifactJson<any>(runId, evidenceSourceStatusName);

    const sourcesCoverage = (() => {
      if (!evidenceSourceStatus) return null;
      const summary = evidenceSourceStatus?.summary ?? {};
      const succeeded = typeof summary?.succeeded === 'number' ? summary.succeeded : NaN;
      const failed = typeof summary?.failed === 'number' ? summary.failed : NaN;
      const fallbackCount = typeof summary?.fallback_count === 'number' ? summary.fallback_count : undefined;
      if (!Number.isFinite(succeeded) || !Number.isFinite(failed)) return null;
      const attempted = succeeded + failed;
      if (!Number.isFinite(attempted) || attempted <= 0) return null;

      const failedIds = Array.isArray(evidenceSourceStatus?.sources)
        ? (evidenceSourceStatus.sources as any[])
            .filter(s => s && typeof s === 'object' && s.status === 'failed' && typeof s.identifier === 'string')
            .map(s => String(s.identifier))
        : [];
      const failedUnique = Array.from(new Set(failedIds));
      const failedSample = failedUnique.slice(0, 5);
      const successRate = `${((succeeded / attempted) * 100).toFixed(1)}%`;

      return {
        sources: {
          source_status_artifact: evidenceSourceStatusName,
          attempted,
          succeeded,
          failed,
          fallback_count: fallbackCount,
          failed_identifiers: failedSample.length > 0 ? failedSample : undefined,
          success_rate: successRate,
        },
        human: {
          attempted,
          succeeded,
          failed,
          failed_sample: failedSample,
          success_rate: successRate,
        },
      };
    })();

    const citationsPass = renderedLatexVerification?.pass === true;
    const stats = renderedLatexVerification?.statistics ?? {};
    const orphanCount = typeof stats.orphan_count === 'number' ? stats.orphan_count : undefined;
    const unauthorizedCount = typeof stats.unauthorized_count === 'number' ? stats.unauthorized_count : undefined;
    const missingCount = typeof stats.missing_count === 'number' ? stats.missing_count : undefined;
    const totalCitations = typeof stats.total_citations === 'number' ? stats.total_citations : undefined;
    const issuesTotal = Array.isArray(renderedLatexVerification?.issues) ? renderedLatexVerification.issues.length : undefined;

    const datasetHasMore = typeof searchExportMeta?.meta?.has_more === 'boolean' ? searchExportMeta.meta.has_more : undefined;
    const datasetMaxResults = typeof searchExportMeta?.meta?.max_results === 'number' ? searchExportMeta.meta.max_results : undefined;

    const evidenceSummary = sourcesCoverage
      ? (() => {
          const failedPart = sourcesCoverage.human.failed > 0
            ? sourcesCoverage.human.failed_sample.length > 0
              ? `, ${sourcesCoverage.human.failed} failed: ${sourcesCoverage.human.failed_sample.join(', ')}`
              : `, ${sourcesCoverage.human.failed} failed`
            : '';
          const truncationPart = maxEvidenceItemsHit ? ', max_evidence_items hit' : '';
          return `Evidence ${sourcesCoverage.human.succeeded}/${sourcesCoverage.human.attempted} sources (${sourcesCoverage.human.success_rate}${failedPart}${truncationPart})`;
        })()
      : maxEvidenceItemsHit
        ? 'Evidence truncated (max_evidence_items hit)'
        : 'Evidence complete/unknown';

    const humanSummary = [
      datasetHasMore === true
        ? `Dataset truncated (has_more=true${datasetMaxResults ? `, max_results=${datasetMaxResults}` : ''})`
        : datasetHasMore === false
          ? 'Dataset complete'
          : 'Dataset unknown',
      evidenceSummary,
      citationsPass
        ? 'Verifier pass'
        : `Verifier failed (unauthorized=${unauthorizedCount ?? 'unknown'}, orphan=${orphanCount ?? 'unknown'}, missing=${missingCount ?? 'unknown'})`,
    ].join('; ') + '.';

    const coverageReport = {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: runId,
      project_id: run.project_id,
      sources: sourcesCoverage?.sources,
      dataset: {
        meta_artifact: searchExportMeta?.artifactName,
        query: typeof searchExportMeta?.meta?.query === 'string' ? searchExportMeta.meta.query : undefined,
        sort: typeof searchExportMeta?.meta?.sort === 'string' ? searchExportMeta.meta.sort : undefined,
        total: typeof searchExportMeta?.meta?.total === 'number' ? searchExportMeta.meta.total : undefined,
        exported: typeof searchExportMeta?.meta?.exported === 'number' ? searchExportMeta.meta.exported : undefined,
        has_more: datasetHasMore,
        max_results: datasetMaxResults,
        warnings: Array.isArray(searchExportMeta?.meta?.warnings) ? searchExportMeta!.meta.warnings.map((w: any) => String(w)) : undefined,
      },
      evidence: {
        writing_evidence_meta_artifact: evidenceMeta ? 'writing_evidence_meta_v1.json' : undefined,
        latex_sources: Array.isArray(evidenceMeta?.latex?.sources) ? evidenceMeta.latex.sources : undefined,
        latex_total_items: typeof evidenceMeta?.latex?.total_items === 'number' ? evidenceMeta.latex.total_items : undefined,
        pdf_included: evidenceMeta?.pdf ? true : false,
        max_evidence_items_hit: maxEvidenceItemsHit,
        warnings: Array.isArray(evidenceMeta?.warnings) ? evidenceMeta.warnings.map((w: any) => String(w)) : undefined,
      },
      citations: {
        verification_artifact: renderedLatexVerificationName,
        pass: citationsPass,
        total_citations: totalCitations,
        orphan_count: orphanCount,
        unauthorized_count: unauthorizedCount,
        missing_count: missingCount,
        issues_total: issuesTotal,
      },
      budgets: {
        diagnostics_artifacts: diagnosticNames,
        hits_total: hitsTotal,
        warnings_total: warningsTotal,
        hit_keys: hitKeys,
      },
      human_summary: humanSummary,
    };

    const coverageReportName = 'coverage_report.json';
    artifacts.push(writeRunJsonArtifact(runId, coverageReportName, coverageReport));
    artifacts.push(renderedLatexVerificationRef);
    if (writingMasterBibRef) artifacts.push(writingMasterBibRef);

    // Evidence digests (optional): collect from run catalogs + project paper catalogs.
    const includeDigests = params.include_evidence_digests ?? true;
    const maxChars = params.max_chars_per_notebooklm_file ?? 80_000;
    let evidenceLines: string[] = [];
    let runCatalogs = 0;
    let projectCatalogs = 0;

    if (includeDigests) {
      const runArtifactsDir = getRunArtifactsDir(runId);
      const runJsonl = fs.readdirSync(runArtifactsDir, { withFileTypes: true })
        .filter(d => d.isFile() && d.name.endsWith('_evidence_catalog.jsonl'))
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b));

      for (const name of runJsonl) {
        const content = fs.readFileSync(path.join(runArtifactsDir, name), 'utf-8');
        evidenceLines.push(...collectEvidenceMarkdownLinesFromJsonl(content, `run:${name}`));
        runCatalogs += 1;
      }

      const papers = listPapers(run.project_id).slice().sort((a, b) => a.paper_id.localeCompare(b.paper_id));
      for (const paper of papers) {
        if (!paper.artifacts?.evidence_catalog) continue;
        const p = getProjectPaperEvidenceCatalogPath(run.project_id, paper.paper_id);
        if (!fs.existsSync(p)) continue;
        const content = fs.readFileSync(p, 'utf-8');
        evidenceLines.push(...collectEvidenceMarkdownLinesFromJsonl(content, `paper:${paper.paper_id}`));
        projectCatalogs += 1;
      }
    }

    evidenceLines = evidenceLines.filter(Boolean);
    evidenceLines.sort((a, b) => a.localeCompare(b));

    const digestFiles = includeDigests && evidenceLines.length > 0
      ? chunkLinesToFiles({
        baseName: `${notebookPrefix}_evidence_digest`,
        maxChars,
        header: '# Evidence Digest\n\nEach line is a compact reference (type, evidence_id, locator).\n',
        lines: evidenceLines,
      })
      : [];

    for (const f of digestFiles) {
      notebookFiles.push({ name: f.name, content: f.content, mimeType: 'text/plain' });
    }

    // Write notebooklm pack files as run artifacts (flat names; upload-friendly).
    for (const f of notebookFiles) {
      artifacts.push(writeRunTextArtifact({
        runId,
        artifactName: f.name,
        content: f.content,
        mimeType: f.mimeType,
      }));
    }

    const includePaperBundle = params.include_paper_bundle ?? false;
    const paperBundleZipArtifactName = params.paper_bundle_zip_artifact_name ?? 'paper_bundle.zip';
    assertSafePathSegment(paperBundleZipArtifactName, 'paper_bundle_zip_artifact_name');
    const paperBundleManifestArtifactName = params.paper_bundle_manifest_artifact_name ?? 'paper_bundle_manifest.json';
    assertSafePathSegment(paperBundleManifestArtifactName, 'paper_bundle_manifest_artifact_name');

    const paperZipEntries: Record<string, Uint8Array> = {};
    let paperEmbeddedFiles = 0;

    if (includePaperBundle) {
      const bundleZipPath = getRunArtifactPath(runId, paperBundleZipArtifactName);
      if (!fs.existsSync(bundleZipPath)) {
        throw invalidParams('Missing paper bundle artifact (fail-fast)', {
          run_id: runId,
          artifact: paperBundleZipArtifactName,
          next_actions: [
            { tool: HEP_IMPORT_PAPER_BUNDLE, args: { run_id: runId }, reason: 'Import the final paper bundle first, then re-run export.' },
          ],
        });
      }

      const zipBytes = fs.readFileSync(bundleZipPath);
      const extracted = unzipSync(new Uint8Array(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength));

      for (const [zipPath, bytes] of Object.entries(extracted)) {
        if (!zipPath) continue;
        if (zipPath.endsWith('/')) continue;
        if (zipPath.includes('\\') || zipPath.startsWith('/')) {
          throw invalidParams('Unsafe paper_bundle.zip entry (fail-fast)', { run_id: runId, zip_path: zipPath });
        }
        const parts = zipPath.split('/');
        if (parts.some(p => p === '' || p === '.' || p === '..')) {
          throw invalidParams('Unsafe paper_bundle.zip entry (path traversal) (fail-fast)', { run_id: runId, zip_path: zipPath });
        }
        if (!zipPath.startsWith('paper/')) {
          throw invalidParams('Unexpected paper_bundle.zip entry (expected paper/*) (fail-fast)', {
            run_id: runId,
            zip_path: zipPath,
            hint: 'paper_bundle.zip should be produced by hep_import_paper_bundle.',
          });
        }
        paperZipEntries[zipPath] = bytes;
        paperEmbeddedFiles += 1;
      }

      const bundleManifestPath = getRunArtifactPath(runId, paperBundleManifestArtifactName);
      if (fs.existsSync(bundleManifestPath)) {
        const embedName = 'paper/paper_bundle_manifest.json';
        if (!Object.prototype.hasOwnProperty.call(paperZipEntries, embedName)) {
          paperZipEntries[embedName] = strToU8(fs.readFileSync(bundleManifestPath, 'utf-8'));
        }
      }
    }

    const includePdgArtifacts = params.include_pdg_artifacts ?? false;
    const pdgZipEntries: Record<string, Uint8Array> = {};
    const pdgExportFiles: Array<{ name: string; zip_path: string; size_bytes: number; sha256: string; mimeType: string }> = [];
    let pdgArtifactsDir: string | null = null;
    let pdgArtifactsDirExists = false;

    if (includePdgArtifacts) {
      pdgArtifactsDir = getPdgArtifactsDir();
      pdgArtifactsDirExists = fs.existsSync(pdgArtifactsDir);

      if (pdgArtifactsDirExists) {
        const names = fs.readdirSync(pdgArtifactsDir, { withFileTypes: true })
          .filter(e => e.isFile())
          .map(e => e.name)
          .sort((a, b) => a.localeCompare(b));

        for (const name of names) {
          assertSafePathSegment(name, 'pdg_artifact_name');
          const p = resolvePathWithinParent(pdgArtifactsDir, name, 'pdg_artifact');
          const stat = fs.statSync(p);
          if (!stat.isFile()) continue;
          const bytes = fs.readFileSync(p);
          const zipPath = `pdg/artifacts/${name}`;
          pdgZipEntries[zipPath] = bytes;
          pdgExportFiles.push({
            name,
            zip_path: zipPath,
            size_bytes: bytes.length,
            sha256: sha256Bytes(bytes),
            mimeType: guessMimeTypeByName(name),
          });
        }
      }
    }

    // Write export manifest (small, deterministic; no timestamps).
    const runManifestArtifactName = 'run_manifest.json';
    const exportManifest = {
      version: 1,
      run_id: runId,
      project_id: run.project_id,
      files: {
        master_bib: masterBibName,
        ...(writingMasterBibText ? { writing_master_bib: writingMasterBibName } : {}),
        report_tex: reportTexName,
        report_md: reportMdName,
        rendered_latex_verification: renderedLatexVerificationName,
        coverage_report: coverageReportName,
        run_manifest: runManifestArtifactName,
        notebooklm_pack: [...notebookFiles.map(f => f.name), notebookRunManifestName],
        ...(includePaperBundle ? { paper_bundle_dir: 'paper/' } : {}),
        ...(includePdgArtifacts ? { pdg_artifacts: pdgExportFiles.map(f => f.zip_path) } : {}),
      },
      ...(includePaperBundle
        ? {
          paper_bundle: {
            zip_artifact: paperBundleZipArtifactName,
            embedded_files: paperEmbeddedFiles,
            embedded_prefix: 'paper/',
            bundle_manifest_artifact: fs.existsSync(getRunArtifactPath(runId, paperBundleManifestArtifactName))
              ? paperBundleManifestArtifactName
              : null,
          },
        }
        : {}),
      ...(includePdgArtifacts
        ? {
          pdg_artifacts: {
            artifacts_dir: pdgArtifactsDir,
            artifacts_dir_exists: pdgArtifactsDirExists,
            files: pdgExportFiles,
          },
        }
        : {}),
    };
    artifacts.push(writeRunJsonArtifact(runId, 'export_manifest_v1.json', exportManifest));

    const zipName = params.research_pack_zip_artifact_name ?? 'research_pack.zip';
    const zipRef = makeRunArtifactRef(runId, zipName, 'application/zip');
    const runManifestRef = makeRunArtifactRef(runId, runManifestArtifactName, 'application/json');
    const notebookRunManifestRef = makeRunArtifactRef(runId, notebookRunManifestName, 'application/json');

    const now = new Date().toISOString();
    const artifactsForStep = [...artifacts, runManifestRef, notebookRunManifestRef, zipRef];
    const manifestDone = buildManifestAfterStep({
      manifestStart,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts: artifactsForStep,
      now,
    });
    const runManifestJson = JSON.stringify(manifestDone, null, 2);

    // Write finalized manifest copies as artifacts (must reflect the completed export step).
    writeRunTextArtifact({
      runId,
      artifactName: runManifestArtifactName,
      content: runManifestJson,
      mimeType: 'application/json',
    });
    artifacts.push(runManifestRef);

    writeRunTextArtifact({
      runId,
      artifactName: notebookRunManifestName,
      content: runManifestJson,
      mimeType: 'application/json',
    });
    artifacts.push(notebookRunManifestRef);

    // Build research_pack.zip (contains a real notebooklm_pack/ directory).
    const zipEntries: Record<string, Uint8Array> = {};
    zipEntries['master.bib'] = strToU8(masterBib.content);
    zipEntries['report.tex'] = strToU8(reportTex);
    zipEntries['report.md'] = strToU8(reportMd);
    zipEntries['rendered_latex_verification.json'] = strToU8(renderedLatexVerificationText);
    zipEntries['coverage_report.json'] = strToU8(JSON.stringify(coverageReport, null, 2));
    if (writingMasterBibText) {
      zipEntries['writing_master.bib'] = strToU8(writingMasterBibText);
    }
    zipEntries['run_manifest.json'] = strToU8(runManifestJson);
    zipEntries['export_manifest_v1.json'] = strToU8(JSON.stringify(exportManifest, null, 2));

    zipEntries['notebooklm_pack/master.bib'] = strToU8(masterBib.content);
    zipEntries['notebooklm_pack/report.md'] = strToU8(reportMd);
    zipEntries['notebooklm_pack/run_manifest.json'] = strToU8(runManifestJson);
    for (const f of digestFiles) {
      zipEntries[`notebooklm_pack/${f.name.replace(`${notebookPrefix}_`, '')}`] = strToU8(f.content);
    }

    for (const [zipPath, bytes] of Object.entries(paperZipEntries)) {
      zipEntries[zipPath] = bytes;
    }

    for (const [zipPath, bytes] of Object.entries(pdgZipEntries)) {
      zipEntries[zipPath] = bytes;
    }

    const zipBytes = zipSync(zipEntries, { level: 0 });
    writeRunBinaryArtifact({
      runId,
      artifactName: zipName,
      bytes: zipBytes,
      mimeType: 'application/zip',
    });
    artifacts.push(zipRef);

    // Persist completed run manifest last (avoids marking done if artifact writes fail).
    await updateRunManifestAtomic({
      run_id: runId,
      tool: { name: HEP_EXPORT_PROJECT, args: { run_id: runId } },
      update: current => {
        const idx = current.steps[stepIndex]?.step === step.step && current.steps[stepIndex]?.started_at === step.started_at
          ? stepIndex
          : current.steps.findIndex(s => s.step === step.step && s.started_at === step.started_at);
        if (idx < 0) {
          throw invalidParams('Internal: export_project run step not found (fail-fast)', {
            run_id: runId,
            step: step.step,
            started_at: step.started_at ?? null,
          });
        }

        const merged = mergeArtifactRefs(current.steps[idx]?.artifacts, artifactsForStep);
        const updatedStep: RunStep = {
          ...current.steps[idx]!,
          status: 'done',
          started_at: current.steps[idx]!.started_at ?? step.started_at,
          completed_at: now,
          artifacts: merged,
        };
        const next: RunManifest = {
          ...current,
          updated_at: now,
          steps: current.steps.map((s, i) => (i === idx ? updatedStep : s)),
        };
        return { ...next, status: computeRunStatus(next) };
      },
    });

    // Refresh run manifest artifacts and zip to reflect the final (done) manifest.
    const finalRunManifestJson = fs.readFileSync(getRunManifestPath(runId), 'utf-8');
    fs.writeFileSync(getRunArtifactPath(runId, runManifestArtifactName), finalRunManifestJson, 'utf-8');
    fs.writeFileSync(getRunArtifactPath(runId, `${notebookPrefix}_run_manifest.json`), finalRunManifestJson, 'utf-8');

    zipEntries['run_manifest.json'] = strToU8(finalRunManifestJson);
    zipEntries['notebooklm_pack/run_manifest.json'] = strToU8(finalRunManifestJson);
    const finalZipBytes = zipSync(zipEntries, { level: 0 });
    fs.writeFileSync(getRunArtifactPath(runId, zipName), Buffer.from(finalZipBytes));

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary: {
        cite_keys: citeKeys.length,
        master_bib_entries: masterBib.stats.total,
        notebooklm_files: notebookFiles.length + 1,
        zip_files: Object.keys(zipEntries).length,
        pdg_artifacts: { enabled: includePdgArtifacts, files: pdgExportFiles.length, artifacts_dir_exists: pdgArtifactsDirExists },
        paper_bundle: {
          enabled: includePaperBundle,
          embedded: includePaperBundle && Object.keys(paperZipEntries).length > 0,
          files: Object.keys(paperZipEntries).length,
          manifest_included: Object.prototype.hasOwnProperty.call(paperZipEntries, 'paper/paper_bundle_manifest.json'),
        },
        evidence_sources: { run_catalogs: runCatalogs, project_catalogs: projectCatalogs, evidence_lines: evidenceLines.length },
      },
    };
  } catch (err) {
    try {
      const failedAt = new Date().toISOString();
      const message = err instanceof Error ? err.message : String(err);
      await updateRunManifestAtomic({
        run_id: runId,
        tool: { name: HEP_EXPORT_PROJECT, args: { run_id: runId } },
        update: current => {
          const idx = current.steps[stepIndex]?.step === step.step && current.steps[stepIndex]?.started_at === step.started_at
            ? stepIndex
            : current.steps.findIndex(s => s.step === step.step && s.started_at === step.started_at);
          if (idx < 0) return current;

          const merged = mergeArtifactRefs(current.steps[idx]?.artifacts, artifacts);
          const updatedStep: RunStep = {
            ...current.steps[idx]!,
            status: 'failed',
            started_at: current.steps[idx]!.started_at ?? step.started_at,
            completed_at: failedAt,
            artifacts: merged,
            notes: message,
          };
          const next: RunManifest = {
            ...current,
            updated_at: failedAt,
            steps: current.steps.map((s, i) => (i === idx ? updatedStep : s)),
          };
          return { ...next, status: computeRunStatus(next) };
        },
      });
    } catch {
      // ignore
    }
    throw err;
  }
}
