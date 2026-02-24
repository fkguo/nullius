import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { invalidParams } from '@autoresearch/shared';
import { zipSync } from 'fflate';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { assertSafePathSegment, getRunArtifactPath, getRunArtifactsDir, getRunDir } from '../paths.js';
import { resolvePathWithinParent } from '../../data/pathGuard.js';

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Bytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256FileSync(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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

function runArtifactUri(runId: string, artifactName: string): string {
  return `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`;
}

function makeRunArtifactRef(runId: string, artifactName: string, mimeType: string): RunArtifactRef {
  return { name: artifactName, uri: runArtifactUri(runId, artifactName), mimeType };
}

function writeRunTextArtifact(params: { run_id: string; artifact_name: string; content: string; mimeType: string }): RunArtifactRef {
  fs.writeFileSync(getRunArtifactPath(params.run_id, params.artifact_name), params.content, 'utf-8');
  return makeRunArtifactRef(params.run_id, params.artifact_name, params.mimeType);
}

function writeRunBinaryArtifact(params: { run_id: string; artifact_name: string; bytes: Uint8Array; mimeType: string }): RunArtifactRef {
  fs.writeFileSync(getRunArtifactPath(params.run_id, params.artifact_name), Buffer.from(params.bytes));
  return makeRunArtifactRef(params.run_id, params.artifact_name, params.mimeType);
}

async function startRunStep(runId: string, stepName: string): Promise<{ manifestStart: RunManifest; stepIndex: number; step: RunStep }> {
  const now = nowIso();
  const manifestStart = await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: 'hep_export_paper_scaffold', args: { run_id: runId } },
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
    updated_at: params.now,
    steps: params.manifestStart.steps.map((s, idx) => (idx === params.stepIndex ? step : s)),
    status: computeRunStatus({
      ...params.manifestStart,
      updated_at: params.now,
      steps: params.manifestStart.steps.map((s, idx) => (idx === params.stepIndex ? step : s)),
    }),
  };
}

function readRunArtifactText(runId: string, artifactName: string): string {
  const p = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(p)) {
    throw invalidParams(`Missing run artifact: ${artifactName}`, { run_id: runId, artifact_name: artifactName });
  }
  return fs.readFileSync(p, 'utf-8');
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
  for (let m = re.exec(normalized); m; m = re.exec(normalized)) starts.push(m.index);

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

function buildGeneratedBib(params: {
  citeKeys: string[];
  writingMasterByKey?: Map<string, string> | null;
  bibRawByKey?: Map<string, string> | null;
}): { content: string; missing_keys: string[]; stats: Record<string, number> } {
  const parts: string[] = [];
  const missing: string[] = [];
  let fromWritingMaster = 0;
  let fromRaw = 0;

  for (const key of params.citeKeys) {
    const fromMaster = params.writingMasterByKey?.get(key);
    if (fromMaster) {
      parts.push(fromMaster);
      fromWritingMaster += 1;
      continue;
    }
    const raw = params.bibRawByKey?.get(key);
    if (raw) {
      parts.push(raw.trimEnd() + '\n');
      fromRaw += 1;
      continue;
    }
    missing.push(key);
  }

  const content = parts.join('\n\n').trim() + (parts.length > 0 ? '\n' : '');
  return {
    content,
    missing_keys: missing,
    stats: {
      total: params.citeKeys.length,
      from_writing_master: fromWritingMaster,
      from_bibliography_raw: fromRaw,
      missing: missing.length,
    },
  };
}

function slugifyFileStem(input: string): string {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return 'section';
  const cleaned = s
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, '') // strip simple commands
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return cleaned || 'section';
}

type SectionSpec = { id: string; title: string; file: string; content: string };

function splitIntegratedLatexToSections(latex: string): { sections: SectionSpec[]; preamble: string } {
  const normalized = String(latex ?? '').replace(/\r\n/g, '\n');
  const re = /\\section\{([^}]+)\}/g;
  const matches: Array<{ index: number; end: number; title: string }> = [];

  for (let m = re.exec(normalized); m; m = re.exec(normalized)) {
    matches.push({ index: m.index, end: m.index + m[0].length, title: String(m[1] ?? '').trim() });
  }

  if (matches.length === 0) {
    const body = normalized.trim();
    const file = 'sections/section_001_body.tex';
    return {
      preamble: '',
      sections: [{ id: 'body', title: 'Body', file, content: body ? body + '\n' : '' }],
    };
  }

  const preamble = normalized.slice(0, matches[0]!.index).trim();
  const sections: SectionSpec[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const nextIdx = i + 1 < matches.length ? matches[i + 1]!.index : normalized.length;
    const block = normalized.slice(m.index, nextIdx).trim();
    const title = m.title || `Section ${i + 1}`;
    const id = `${pad3(i + 1)}_${slugifyFileStem(title)}`;
    const file = `sections/section_${id}.tex`;
    sections.push({ id, title, file, content: block + '\n' });
  }

  return { preamble, sections };
}

function collectStableAssetMarkers(latex: string): { equations: string[]; figures: string[]; tables: string[] } {
  const collect = (re: RegExp): string[] => {
    const ids = new Set<string>();
    for (let m = re.exec(latex); m; m = re.exec(latex)) {
      const id = String(m[1] ?? '').trim();
      if (id) ids.add(id);
    }
    return Array.from(ids).sort((a, b) => a.localeCompare(b));
  };
  return {
    equations: collect(/\bEq\[([^\]]+)\]/g),
    figures: collect(/\bFig\[([^\]]+)\]/g),
    tables: collect(/\bTable\[([^\]]+)\]/g),
  };
}

function writeFileUtf8(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function failIfContainsHepUri(text: string, what: string, runId: string): void {
  if (text.includes('hep://')) {
    throw invalidParams(`Found forbidden hep:// URI in ${what} (LaTeX cannot compile it)`, {
      run_id: runId,
      what,
      next_actions: [
        {
          tool: 'hep_run_writing_integrate_sections_v1',
          args: { run_id: runId },
          reason: 'Ensure the integrated LaTeX contains only local paths (no hep:// URIs), then re-run export.',
        },
      ],
    });
  }
}

function parseRunArtifactUri(uri: string): { run_id: string; artifact_name: string } | null {
  const raw = String(uri ?? '').trim();
  const m = raw.match(/^hep:\/\/runs\/([^/]+)\/artifact\/(.+)$/);
  if (!m) return null;
  try {
    const runId = decodeURIComponent(m[1] ?? '');
    const artifactName = decodeURIComponent(m[2] ?? '');
    return { run_id: runId, artifact_name: artifactName };
  } catch {
    return null;
  }
}

function rewriteIncludeGraphicsAndMaterialize(params: {
  latex: string;
  run_id: string;
  figures_dir: string;
  materialized_assets: Array<{ id: string; kind: string; localPath: string; sourceUri: string; sha256?: string }>;
}): { latex: string; copied: number } {
  const normalized = String(params.latex ?? '');
  const runId = params.run_id;

  const ensureAssetRecorded = (asset: { id: string; kind: string; localPath: string; sourceUri: string; sha256?: string }) => {
    const key = `${asset.kind}:${asset.localPath}`;
    if (params.materialized_assets.some(a => `${a.kind}:${a.localPath}` === key)) return;
    params.materialized_assets.push(asset);
  };

  const includeRe = /\\includegraphics(\[[^\]]*\])?\{([^}]+)\}/g;
  let out = '';
  let last = 0;
  let copied = 0;

  const runArtifactsDir = getRunArtifactsDir(runId);

  for (let m = includeRe.exec(normalized); m; m = includeRe.exec(normalized)) {
    const full = m[0] ?? '';
    const opt = m[1] ?? '';
    const rawPath = String(m[2] ?? '').trim();

    let artifactName: string | null = null;
    let sourceUri: string | null = null;
    let sourcePath: string | null = null;

    const parsed = rawPath.startsWith('hep://') ? parseRunArtifactUri(rawPath) : null;
    if (parsed) {
      if (parsed.run_id !== runId) {
        throw invalidParams('includegraphics hep:// URI must refer to the same run_id (fail-fast)', {
          run_id: runId,
          includegraphics_uri: rawPath,
          parsed_run_id: parsed.run_id,
        });
      }
      artifactName = parsed.artifact_name;
      assertSafePathSegment(artifactName, 'includegraphics artifact_name');
      sourceUri = rawPath;
      sourcePath = getRunArtifactPath(runId, artifactName);
      if (!fs.existsSync(sourcePath)) {
        throw invalidParams('Missing run artifact referenced by includegraphics (fail-fast)', {
          run_id: runId,
          artifact_name: artifactName,
          includegraphics_uri: rawPath,
        });
      }
    } else {
      const base = path.posix.basename(rawPath.replaceAll('\\', '/')).trim();
      if (!base) continue;
      assertSafePathSegment(base, 'includegraphics file');
      artifactName = base;
      sourceUri = runArtifactUri(runId, artifactName);
      sourcePath = resolvePathWithinParent(runArtifactsDir, path.join(runArtifactsDir, artifactName), 'includegraphics source');
      if (!fs.existsSync(sourcePath)) {
        throw invalidParams('includegraphics references a file that is not available as a run artifact (fail-fast)', {
          run_id: runId,
          includegraphics_path: rawPath,
          expected_run_artifact: artifactName,
          next_actions: [
            { tool: 'hep_run_stage_content', args: { run_id: runId, content_type: 'application/octet-stream', content: '<binary>', artifact_suffix: artifactName }, reason: 'Stage the figure file as a run artifact (or regenerate it) and re-run export.' },
          ],
        });
      }
    }

    const localPath = `figures/${artifactName}`;
    const dst = path.join(params.figures_dir, artifactName);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(sourcePath, dst);
    copied += 1;

    ensureAssetRecorded({
      id: artifactName,
      kind: 'figure',
      localPath,
      sourceUri: sourceUri ?? runArtifactUri(runId, artifactName),
      sha256: sha256FileSync(dst),
    });

    out += normalized.slice(last, m.index) + `\\includegraphics${opt}{${localPath}}`;
    last = m.index + full.length;
  }
  out += normalized.slice(last);
  return { latex: out, copied };
}

function buildMainTex(params: {
  title: string;
  sections: SectionSpec[];
  bibliography_style: string;
  bibliography_files: string[];
}): string {
  const bibFilesNoExt = params.bibliography_files.map(f => f.replace(/\.bib$/i, '')).join(',');
  const inputs = params.sections.map(s => `\\input{${s.file}}`).join('\n');
  return [
    '% Auto-generated by hep_export_paper_scaffold (vNext M3)',
    '\\documentclass[12pt,onecolumn]{revtex4-2}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage{graphicx}',
    '\\usepackage{hyperref}',
    '\\usepackage{cite}',
    '',
    '\\begin{document}',
    `\\title{${params.title.replace(/[{}]/g, '')}}`,
    '\\author{(author)}',
    '\\date{\\today}',
    '',
    '\\begin{abstract}',
    '% TODO: abstract',
    '\\end{abstract}',
    '',
    '\\maketitle',
    '',
    inputs,
    '',
    `\\bibliographystyle{${params.bibliography_style}}`,
    `\\bibliography{${bibFilesNoExt}}`,
    '\\end{document}',
    '',
  ].join('\n');
}

function listPaperFiles(paperDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(p);
    }
  };
  walk(paperDir);
  return out.sort((a, b) => a.localeCompare(b));
}

function relPaperPath(paperDir: string, filePath: string): string {
  return path.relative(paperDir, filePath).replaceAll(path.sep, '/');
}

export interface ExportPaperScaffoldParams {
  run_id: string;
  output_dir_name?: string;
  overwrite?: boolean;
  integrated_latex_artifact_name?: string;
  writing_master_bib_artifact_name?: string;
  bibliography_raw_artifact_name?: string;
  zip_artifact_name?: string;
  paper_manifest_artifact_name?: string;
}

export interface ExportPaperScaffoldResult {
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
}

export async function exportPaperScaffoldForRun(params: ExportPaperScaffoldParams): Promise<ExportPaperScaffoldResult> {
  const runId = params.run_id;
  const run = getRun(runId);

  const outputDirName = params.output_dir_name?.trim() || 'paper';
  assertSafePathSegment(outputDirName, 'output_dir_name');

  const integratedName = params.integrated_latex_artifact_name?.trim() || 'writing_integrated.tex';
  assertSafePathSegment(integratedName, 'integrated_latex_artifact_name');

  const writingMasterBibName = params.writing_master_bib_artifact_name?.trim() || 'writing_master.bib';
  assertSafePathSegment(writingMasterBibName, 'writing_master_bib_artifact_name');

  const bibliographyRawName = params.bibliography_raw_artifact_name?.trim() || 'bibliography_raw.json';
  assertSafePathSegment(bibliographyRawName, 'bibliography_raw_artifact_name');

  const zipArtifactName = params.zip_artifact_name?.trim() || 'paper_scaffold.zip';
  assertSafePathSegment(zipArtifactName, 'zip_artifact_name');

  const paperManifestArtifactName = params.paper_manifest_artifact_name?.trim() || 'paper_manifest.json';
  assertSafePathSegment(paperManifestArtifactName, 'paper_manifest_artifact_name');

  const overwrite = Boolean(params.overwrite);

  const { manifestStart, stepIndex, step } = await startRunStep(runId, 'export_paper_scaffold');
  const artifacts: RunArtifactRef[] = [];

  try {
    const integratedLatex = readRunArtifactText(runId, integratedName);

    const citeKeys = extractCiteKeysFromLatex(integratedLatex);
    const bibRawByKey = tryReadBibliographyRawEntries(runId, bibliographyRawName);

    const writingMasterBibText = readRunArtifactText(runId, writingMasterBibName);
    const writingMasterByKey = parseBibtexEntriesByKey(writingMasterBibText);

    const generatedBib = buildGeneratedBib({ citeKeys, writingMasterByKey, bibRawByKey });
    if (generatedBib.missing_keys.length > 0) {
      throw invalidParams('Missing BibTeX entries for one or more cite keys (fail-fast).', {
        run_id: runId,
        missing_cite_keys_total: generatedBib.missing_keys.length,
        missing_cite_keys_sample: generatedBib.missing_keys.slice(0, 20),
        cite_keys_total: citeKeys.length,
        bibliography_raw_artifact: bibliographyRawName,
        writing_master_bib_artifact: writingMasterBibName,
        next_actions: [
          {
            tool: 'hep_run_build_citation_mapping',
            args: { run_id: runId, identifier: '<arXiv/DOI/recid>', allowed_citations_primary: generatedBib.missing_keys },
            reason: 'Build bibliography_raw.json + writing_master.bib + allowed_citations.json (then re-run export).',
          },
          { tool: 'hep_export_paper_scaffold', args: { run_id: runId }, reason: 'Re-run export after citations/bibtex are available.' },
        ],
      });
    }

    const { preamble, sections } = splitIntegratedLatexToSections(integratedLatex);
    if (preamble) {
      // Treat unexpected preamble text as unverified; keep it but do not inject it silently.
      // (We surface it in UNVERIFIED.md for manual inspection.)
    }

    const runDir = getRunDir(runId);
    const paperDir = resolvePathWithinParent(runDir, path.join(runDir, outputDirName), 'paper_dir');
    const materializedAssets: Array<{ id: string; kind: string; localPath: string; sourceUri: string; sha256?: string }> = [];

    if (fs.existsSync(paperDir)) {
      const st = fs.lstatSync(paperDir);
      if (st.isSymbolicLink()) {
        throw invalidParams('Refusing to write into a symlinked output directory (fail-fast)', { run_id: runId, paper_dir: paperDir });
      }
      if (!st.isDirectory()) {
        throw invalidParams('Output path exists and is not a directory (fail-fast)', { run_id: runId, paper_dir: paperDir });
      }
      const entries = fs.readdirSync(paperDir);
      if (entries.length > 0 && !overwrite) {
        throw invalidParams('Output directory already exists and is non-empty (fail-fast)', {
          run_id: runId,
          paper_dir: paperDir,
          overwrite: false,
          next_actions: [
            { tool: 'hep_export_paper_scaffold', args: { run_id: runId, overwrite: true }, reason: 'Overwrite the existing paper/ scaffold.' },
          ],
        });
      }
      if (overwrite) {
        fs.rmSync(paperDir, { recursive: true, force: true });
      }
    }

    const sectionsDir = path.join(paperDir, 'sections');
    const figuresDir = path.join(paperDir, 'figures');
    fs.mkdirSync(sectionsDir, { recursive: true });
    fs.mkdirSync(figuresDir, { recursive: true });

    // Write section files.
    for (const s of sections) {
      const rewritten = rewriteIncludeGraphicsAndMaterialize({
        latex: s.content,
        run_id: runId,
        figures_dir: figuresDir,
        materialized_assets: materializedAssets,
      }).latex;
      const p = path.join(paperDir, s.file);
      writeFileUtf8(p, rewritten);
      failIfContainsHepUri(rewritten, s.file, runId);
    }

    // Bib split.
    writeFileUtf8(path.join(paperDir, 'references_generated.bib'), generatedBib.content);
    const manualBibPath = path.join(paperDir, 'references_manual.bib');
    if (!fs.existsSync(manualBibPath)) {
      writeFileUtf8(manualBibPath, '');
    }

    const mainTex = buildMainTex({
      title: `[DRAFT] ${run.project_id} / ${runId}`,
      sections,
      bibliography_style: 'apsrev4-2',
      bibliography_files: ['references_generated.bib', 'references_manual.bib'],
    });
    writeFileUtf8(path.join(paperDir, 'main.tex'), mainTex);

    const markers = collectStableAssetMarkers(integratedLatex);
    const unverifiedLines: string[] = [];
    unverifiedLines.push('# UNVERIFIED / TODO');
    unverifiedLines.push('');
    if (preamble) {
      unverifiedLines.push('## Unexpected pre-section LaTeX');
      unverifiedLines.push('');
      unverifiedLines.push('The integrated LaTeX contains text before the first `\\\\section{...}`.');
      unverifiedLines.push('This is preserved in the run artifact but not auto-inserted into the paper scaffold.');
      unverifiedLines.push('');
      unverifiedLines.push('Preview:');
      unverifiedLines.push('');
      unverifiedLines.push('```');
      unverifiedLines.push(preamble.slice(0, 800));
      unverifiedLines.push('```');
      unverifiedLines.push('');
    }
    if (markers.equations.length + markers.figures.length + markers.tables.length > 0) {
      unverifiedLines.push('## Stable asset markers found in text');
      unverifiedLines.push('');
      unverifiedLines.push('These markers should be resolved to real LaTeX `\\\\label/\\\\ref` + figures/tables as needed.');
      unverifiedLines.push('');
      if (markers.figures.length > 0) {
        unverifiedLines.push(`- Fig[]: ${markers.figures.join(', ')}`);
      }
      if (markers.tables.length > 0) {
        unverifiedLines.push(`- Table[]: ${markers.tables.join(', ')}`);
      }
      if (markers.equations.length > 0) {
        unverifiedLines.push(`- Eq[]: ${markers.equations.join(', ')}`);
      }
      unverifiedLines.push('');
    }
    writeFileUtf8(path.join(paperDir, 'UNVERIFIED.md'), unverifiedLines.join('\n').trimEnd() + '\n');

    const checksums: Record<string, string> = {};
    for (const p of listPaperFiles(paperDir)) {
      const rel = relPaperPath(paperDir, p);
      if (rel === 'paper_manifest.json') continue;
      checksums[rel] = sha256FileSync(p);
    }

    const paperManifest = {
      schemaVersion: '1.0',
      generatedAt: nowIso(),
      generator: { name: 'hep_export_paper_scaffold' },
      source: {
        hepRunId: runId,
        hepRunUri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
        projectId: run.project_id,
      },
      latex: {
        mainTex: 'main.tex',
        sections: sections.map(s => ({ id: s.id, title: s.title, file: s.file })),
        figuresDir: 'figures',
      },
      bibliography: {
        generated: 'references_generated.bib',
        manual: 'references_manual.bib',
        style: 'apsrev4-2',
      },
      materializedAssets,
      unverified: {
        stable_asset_markers: markers,
      },
      checksums: { algorithm: 'sha256', files: checksums },
    };

    const paperManifestText = JSON.stringify(paperManifest, null, 2) + '\n';
    writeFileUtf8(path.join(paperDir, 'paper_manifest.json'), paperManifestText);

    // Mirror manifest into run artifacts for easy read (no unzip needed).
    artifacts.push(writeRunTextArtifact({
      run_id: runId,
      artifact_name: paperManifestArtifactName,
      content: paperManifestText,
      mimeType: 'application/json',
    }));

    // Zip the paper/ directory (portable export).
    const zipEntries: Record<string, Uint8Array> = {};
    for (const p of listPaperFiles(paperDir)) {
      const rel = relPaperPath(paperDir, p);
      const zipPath = `paper/${rel}`;
      const bytes = fs.readFileSync(p);
      zipEntries[zipPath] = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    const zipBytes = zipSync(zipEntries, { level: 9 });
    artifacts.push(writeRunBinaryArtifact({
      run_id: runId,
      artifact_name: zipArtifactName,
      bytes: zipBytes,
      mimeType: 'application/zip',
    }));

    // Update run manifest step.
    const completedAt = nowIso();
    const stepArtifacts = mergeArtifactRefs(step.artifacts, artifacts);
    const manifestDone = buildManifestAfterStep({
      manifestStart,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts: stepArtifacts,
      now: completedAt,
      notes: `Exported paper scaffold to ${paperDir} and ${zipArtifactName}`,
    });

    await updateRunManifestAtomic({
      run_id: runId,
      tool: { name: 'hep_export_paper_scaffold', args: { run_id: runId } },
      update: _current => manifestDone,
    });

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts,
      summary: {
        paper_dir: paperDir,
        files: Object.keys(checksums).length,
        sections: sections.length,
        cite_keys: citeKeys.length,
        bib_stats: generatedBib.stats,
        zip: { artifact: zipArtifactName, bytes: zipBytes.length, sha256: sha256Bytes(zipBytes) },
      },
    };
  } catch (err) {
    // Best-effort: mark step failed with any produced artifacts so far.
    const completedAt = nowIso();
    const stepArtifacts = mergeArtifactRefs(step.artifacts, artifacts);
    const manifestFailed = buildManifestAfterStep({
      manifestStart,
      stepIndex,
      stepStart: step,
      status: 'failed',
      artifacts: stepArtifacts,
      now: completedAt,
      notes: err instanceof Error ? err.message : String(err),
    });
    try {
      await updateRunManifestAtomic({
        run_id: runId,
        tool: { name: 'hep_export_paper_scaffold', args: { run_id: runId } },
        update: _current => manifestFailed,
      });
    } catch {
      // ignore update errors; original error is more important
    }
    throw err;
  }
}
