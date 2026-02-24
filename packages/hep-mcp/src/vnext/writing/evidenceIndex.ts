import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import * as tar from 'tar';
import { latexParser } from 'latex-utensils';
import {
  HEP_RUN_BUILD_EVIDENCE_INDEX_V1,
  HEP_RUN_READ_ARTIFACT_CHUNK,
  INSPIRE_LITERATURE,
  invalidParams,
} from '@autoresearch/shared';

import * as api from '../../api/client.js';
import { arxivFetch } from '../../api/rateLimiter.js';
import { writeRunJsonArtifact } from '../citations.js';
import { cachedExternalApiJsonCall } from '../cache/externalApiCache.js';
import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getProjectPaperJsonPath, getProjectPaperLatexExtractedDir, getRunArtifactPath, getRunDir } from '../paths.js';
import { stableHash } from '../../tools/writing/contentIndex/fingerprint.js';
import { buildIndex, serializeIndex } from '../../tools/writing/rag/retriever.js';
import {
  estimateTokens,
  stripLatexPreserveHEP,
} from '../../tools/writing/rag/hepTokenizer.js';
import type { ChunkType, EvidenceChunk, ChunkLocator, SerializedIndex } from '../../tools/writing/rag/types.js';
import {
  buildMacroWrappedEnvironmentPairsFromContent,
  extractText,
  extractCitations,
  extractEnhancedEquations,
  extractFigures,
  extractTables,
  extractTheorems,
  matchMacroWrappedEnvironmentAt,
  nodeToLocator,
  type LatexAst,
  type LatexNode,
  type Locator,
} from '../../tools/research/latex/index.js';

const ARXIV_EXPORT_BASE = 'https://export.arxiv.org';

const EVIDENCE_INDEX_PARSER_VERSION = 'm03_evidence_ingestion_chunking_v1';

export interface EvidenceIndexBuildErrorArtifactV1 {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  step: 'evidence_ingestion';
  failures: Array<{
    paper_id?: string;
    stage: string;
    message: string;
  }>;
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
}

export interface EvidencePaperChunkCacheArtifactV1 {
  version: 1;
  generated_at: string;
  paper_id: string;
  parser_version: string;
  merged_tex_artifact_name: string;
  merged_tex_sha256: string;
  cache_key: string;
  chunks: EvidenceChunk[];
}

export interface EvidenceIndexMetricsArtifactV1 {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  parser_version: string;
  paper_ids: string[];
  cache: {
    papers_total: number;
    papers_cache_hit: number;
    papers_cache_miss: number;
    index_cache_hit: boolean;
  };
  chunks: {
    total: number;
    total_token_estimate: number;
    by_type: Record<string, number>;
    by_paper: Array<{ paper_id: string; chunk_count: number; token_estimate: number }>;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256HexBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256HexString(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function runArtifactUri(runId: string, artifactName: string): string {
  return `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`;
}

function writeRunTextArtifact(params: {
  runId: string;
  artifactName: string;
  content: string;
  mimeType: string;
}): RunArtifactRef {
  const artifactPath = getRunArtifactPath(params.runId, params.artifactName);
  fs.writeFileSync(artifactPath, params.content, 'utf-8');
  return { name: params.artifactName, uri: runArtifactUri(params.runId, params.artifactName), mimeType: params.mimeType };
}

function computeRunStatus(manifest: RunManifest): RunManifest['status'] {
  const statuses = manifest.steps.map(s => s.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('pending') || statuses.includes('in_progress')) return 'running';
  return 'done';
}

async function startRunStep(runId: string, stepName: string): Promise<{ manifestStart: RunManifest; stepIndex: number; step: RunStep }> {
  const now = nowIso();
  const manifestStart = await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: HEP_RUN_BUILD_EVIDENCE_INDEX_V1, args: { run_id: runId } },
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

function mergeArtifactRefs(existing: RunStep['artifacts'] | undefined, added: RunArtifactRef[]): RunArtifactRef[] {
  const byName = new Map<string, RunArtifactRef>();
  for (const a of existing ?? []) byName.set(a.name, a);
  for (const a of added) byName.set(a.name, a);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function finishRunStep(params: {
  runId: string;
  stepIndex: number;
  stepStart: RunStep;
  status: 'done' | 'failed';
  artifacts: RunArtifactRef[];
  notes?: string;
}): Promise<void> {
  const now = nowIso();
  await updateRunManifestAtomic({
    run_id: params.runId,
    tool: { name: HEP_RUN_BUILD_EVIDENCE_INDEX_V1, args: { run_id: params.runId } },
    update: current => {
      const idx = current.steps[params.stepIndex]?.step === params.stepStart.step
        ? params.stepIndex
        : current.steps.findIndex(s => s.step === params.stepStart.step && s.started_at === params.stepStart.started_at);
      if (idx < 0) {
        throw invalidParams('Internal: unable to locate run step for completion (fail-fast)', {
          run_id: params.runId,
          step: params.stepStart.step,
          started_at: params.stepStart.started_at ?? null,
        });
      }
      const merged = mergeArtifactRefs(current.steps[idx]?.artifacts, params.artifacts);
      const step: RunStep = {
        ...current.steps[idx]!,
        status: params.status,
        started_at: current.steps[idx]!.started_at ?? params.stepStart.started_at,
        completed_at: now,
        artifacts: merged,
        notes: params.notes,
      };
      const next: RunManifest = {
        ...current,
        updated_at: now,
        steps: current.steps.map((s, i) => (i === idx ? step : s)),
      };
      return { ...next, status: computeRunStatus(next) };
    },
  });
}

function normalizePaperIdToken(raw: string): string {
  const t = raw.trim();
  if (!t) throw invalidParams('paper_ids cannot contain empty strings');

  const recid = t.match(/^(?:inspire:)?(\d+)$/)?.[1];
  if (recid) return `inspire:${recid}`;

  const arxiv = t.match(/^arxiv:(.+)$/i)?.[1]?.trim();
  if (arxiv) return `arxiv:${arxiv}`;

  return t;
}

function stableChunkId(params: { paper_id: string; file_path: string; byte_start: number; byte_end: number; type: ChunkType }): string {
  return stableHash(`${params.paper_id}:${params.file_path}:${params.byte_start}:${params.byte_end}:${params.type}`);
}

function stableContentHash(contentLatex: string): string {
  return stableHash(contentLatex);
}

function ensureReplayableLocator(locator: ChunkLocator, contentLength: number): void {
  if (!locator.paper_id) throw new Error('chunk locator missing paper_id');
  if (!locator.file_path) throw new Error('chunk locator missing file_path');
  if (locator.byte_start === undefined || locator.byte_end === undefined) {
    throw new Error('chunk locator missing byte range');
  }
  if (!Number.isFinite(locator.byte_start) || !Number.isFinite(locator.byte_end)) {
    throw new Error('chunk locator byte range not finite');
  }
  if (locator.byte_start < 0 || locator.byte_end <= locator.byte_start) {
    throw new Error(`chunk locator invalid byte range: ${locator.byte_start}..${locator.byte_end}`);
  }
  if (locator.byte_end > contentLength) {
    throw new Error(`chunk locator byte_end out of bounds: ${locator.byte_end} > ${contentLength}`);
  }
  if (!Number.isFinite(locator.line_start) || !Number.isFinite(locator.line_end)) {
    throw new Error('chunk locator line range not finite');
  }
  if (locator.line_start <= 0 || locator.line_end < locator.line_start) {
    throw new Error(`chunk locator invalid line range: ${locator.line_start}..${locator.line_end}`);
  }
}

function stripAfterEndDocument(content: string): string {
  const endDocMatch = content.match(/\\end\s*\{\s*document\s*\}/);
  if (endDocMatch && endDocMatch.index !== undefined) {
    return content.slice(0, endDocMatch.index + endDocMatch[0].length);
  }
  return content;
}

function getDocumentContent(ast: LatexAst): LatexNode[] {
  if (ast.kind !== 'ast.root') return [];
  for (const node of ast.content) {
    if (latexParser.isEnvironment(node) && node.name === 'document') {
      return node.content;
    }
  }
  return ast.content;
}

function hasLocation(node: LatexNode): boolean {
  return Boolean((node as { location?: { start?: { offset?: number } } }).location?.start?.offset !== undefined);
}

function firstLocated(nodes: LatexNode[]): LatexNode | null {
  for (const node of nodes) {
    if (hasLocation(node)) return node;
  }
  return null;
}

function lastLocated(nodes: LatexNode[]): LatexNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node && hasLocation(node)) return node;
  }
  return null;
}

function mergeSpanLocator(start: Locator, end: Locator): Locator {
  const endOffset = end.endOffset ?? end.offset;
  const endLine = end.endLine ?? end.line;
  const endColumn = end.endColumn ?? end.column;
  return { ...start, endOffset, endLine, endColumn };
}

function extractRefsFromLatex(latex: string): { labels: string[]; refs: string[]; cites: string[] } {
  const labels: string[] = [];
  const refs: string[] = [];
  const cites: string[] = [];

  const labelPattern = /\\label\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = labelPattern.exec(latex)) !== null) labels.push(match[1] ?? '');

  const refPattern = /\\(?:ref|eqref|autoref|cref|Cref)\{([^}]+)\}/g;
  while ((match = refPattern.exec(latex)) !== null) {
    const raw = match[1] ?? '';
    refs.push(...raw.split(',').map(t => t.trim()).filter(Boolean));
  }

  const citePattern = /\\cite(?:p|t|alp|alt|author|year)?\{([^}]+)\}/g;
  while ((match = citePattern.exec(latex)) !== null) {
    const raw = match[1] ?? '';
    cites.push(...raw.split(',').map(t => t.trim()).filter(Boolean));
  }

  return {
    labels: labels.map(s => s.trim()).filter(Boolean),
    refs: refs.map(s => s.trim()).filter(Boolean),
    cites: cites.map(s => s.trim()).filter(Boolean),
  };
}

function chunkFromSpan(params: {
  paper_id: string;
  canonical_file_path: string;
  canonical_content: string;
  type: ChunkType;
  span: Locator;
  section_path: string[];
  label?: string;
  forced_outgoing_cites?: string[];
}): EvidenceChunk {
  const byteStart = params.span.offset;
  const byteEnd = params.span.endOffset ?? params.span.offset;
  if (!Number.isFinite(byteStart) || !Number.isFinite(byteEnd) || byteEnd <= byteStart) {
    throw new Error(`Invalid span offsets for chunk: ${byteStart}..${byteEnd}`);
  }

  const contentLatex = params.canonical_content.slice(byteStart, byteEnd);
  const text = stripLatexPreserveHEP(contentLatex).trim();
  const tokenEstimate = estimateTokens(contentLatex);
  if (!Number.isFinite(tokenEstimate) || tokenEstimate <= 0) {
    throw new Error(`token_estimate invalid (${tokenEstimate}) for chunk type=${params.type}`);
  }

  const { labels, refs, cites } = extractRefsFromLatex(contentLatex);
  const outgoingCites = params.forced_outgoing_cites ? params.forced_outgoing_cites : cites;

  const locator: ChunkLocator = {
    paper_id: params.paper_id,
    file_path: params.canonical_file_path,
    section_path: params.section_path,
    label: params.label ?? labels[0],
    byte_start: byteStart,
    byte_end: byteEnd,
    line_start: params.span.line,
    line_end: params.span.endLine ?? params.span.line,
  };

  ensureReplayableLocator(locator, params.canonical_content.length);

  const id = stableChunkId({
    paper_id: locator.paper_id,
    file_path: locator.file_path,
    byte_start: locator.byte_start ?? 0,
    byte_end: locator.byte_end ?? 0,
    type: params.type,
  });

  return {
    id,
    content_hash: stableContentHash(contentLatex),
    type: params.type,
    content_latex: contentLatex,
    text,
    locator,
    refs: {
      outgoing: refs,
      outgoing_cites: outgoingCites,
      incoming: [],
    },
    navigation: {},
    metadata: {
      has_math: /\$|\\\[|\\begin\{(equation|align|gather|multline|eqnarray)/.test(contentLatex),
      has_citation: /\\cite/.test(contentLatex),
      word_count: text ? text.split(/\s+/).filter(Boolean).length : 0,
      token_estimate: tokenEstimate,
    },
  };
}

function buildSectionTimeline(canonicalContent: string, ast: LatexAst, canonicalFileLabel: string): Array<{ offset: number; section_path: string[] }> {
  const docContent = getDocumentContent(ast);
  const sectionCmdLevels: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 1,
    subsection: 2,
    subsubsection: 3,
    paragraph: 4,
    subparagraph: 5,
  };

  const sectionStack: Array<{ level: number; title: string }> = [];
  const timeline: Array<{ offset: number; section_path: string[] }> = [];

  const extractTitle = (cmd: LatexNode): string => {
    if (!latexParser.isCommand(cmd)) return '';
    const nodes = cmd.args.flatMap(arg => (latexParser.isGroup(arg) ? arg.content : []));
    return extractText(nodes).trim() || '';
  };

  for (const node of docContent) {
    if (!latexParser.isCommand(node)) continue;
    if (!(node.name in sectionCmdLevels)) continue;
    const loc = nodeToLocator(node, canonicalFileLabel, canonicalContent);
    if (loc.unknown) continue;

    const level = sectionCmdLevels[node.name];
    const title = extractTitle(node);
    while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1]!.level >= level) {
      sectionStack.pop();
    }
    sectionStack.push({ level, title });
    timeline.push({ offset: loc.offset, section_path: sectionStack.map(s => s.title).filter(Boolean) });
  }

  timeline.sort((a, b) => a.offset - b.offset);
  return timeline;
}

function sectionPathAtOffset(timeline: Array<{ offset: number; section_path: string[] }>, offset: number): string[] {
  if (timeline.length === 0) return [];
  let lo = 0;
  let hi = timeline.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = timeline[mid]!;
    if (m.offset <= offset) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 ? timeline[best]!.section_path : [];
}

function applyNavigation(chunks: EvidenceChunk[]): EvidenceChunk[] {
  const sorted = [...chunks].sort((a, b) => {
    const aStart = a.locator.byte_start ?? 0;
    const bStart = b.locator.byte_start ?? 0;
    if (aStart !== bStart) return aStart - bStart;
    const aEnd = a.locator.byte_end ?? 0;
    const bEnd = b.locator.byte_end ?? 0;
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.id.localeCompare(b.id);
  });

  const byId = new Map(sorted.map(c => [c.id, c]));
  for (let i = 0; i < sorted.length; i++) {
    const prev = i > 0 ? sorted[i - 1] : undefined;
    const next = i < sorted.length - 1 ? sorted[i + 1] : undefined;
    const cur = sorted[i]!;
    const updated: EvidenceChunk = {
      ...cur,
      navigation: {
        prev_id: prev?.id,
        next_id: next?.id,
      },
    };
    byId.set(cur.id, updated);
  }

  return chunks.map(c => byId.get(c.id) ?? c);
}

function applyIncomingRefs(chunks: EvidenceChunk[]): EvidenceChunk[] {
  const labelToIncoming = new Map<string, string[]>();

  for (const chunk of chunks) {
    for (const label of chunk.refs.outgoing) {
      if (!label) continue;
      const existing = labelToIncoming.get(label) ?? [];
      existing.push(chunk.id);
      labelToIncoming.set(label, existing);
    }
  }

  return chunks.map(chunk => {
    const label = chunk.locator.label;
    const incoming = label ? labelToIncoming.get(label) ?? [] : [];
    return {
      ...chunk,
      refs: {
        ...chunk.refs,
        incoming,
      },
    };
  });
}

function generateContextChunks(params: { chunks: EvidenceChunk[]; windowSize: number; canonical_content: string }): EvidenceChunk[] {
  const byOrder = [...params.chunks].sort((a, b) => {
    const aStart = a.locator.byte_start ?? 0;
    const bStart = b.locator.byte_start ?? 0;
    if (aStart !== bStart) return aStart - bStart;
    const aEnd = a.locator.byte_end ?? 0;
    const bEnd = b.locator.byte_end ?? 0;
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.id.localeCompare(b.id);
  });

  const out: EvidenceChunk[] = [...params.chunks];
  const windowSize = Math.max(0, Math.floor(params.windowSize));

  for (let i = 0; i < byOrder.length; i++) {
    const chunk = byOrder[i]!;
    if (chunk.type !== 'equation' && chunk.type !== 'table' && chunk.type !== 'figure') continue;

    const contextParagraphs: EvidenceChunk[] = [];

    for (let j = i - 1; j >= Math.max(0, i - windowSize); j--) {
      if (byOrder[j]!.type === 'paragraph') contextParagraphs.unshift(byOrder[j]!);
    }
    for (let j = i + 1; j <= Math.min(byOrder.length - 1, i + windowSize); j++) {
      if (byOrder[j]!.type === 'paragraph') contextParagraphs.push(byOrder[j]!);
    }

    if (contextParagraphs.length === 0) continue;

    const contextType = `${chunk.type}_context` as ChunkType;
    const rangeCandidates = [chunk, ...contextParagraphs];
    const byteStarts = rangeCandidates.map(c => c.locator.byte_start);
    const byteEnds = rangeCandidates.map(c => c.locator.byte_end);
    if (byteStarts.some(v => v === undefined) || byteEnds.some(v => v === undefined)) {
      throw new Error(`Context chunk range missing byte range for ${contextType}`);
    }
    const startByte = Math.min(...(byteStarts as number[]));
    const endByte = Math.max(...(byteEnds as number[]));
    if (!Number.isFinite(startByte) || !Number.isFinite(endByte) || endByte <= startByte) {
      throw new Error(`Context chunk invalid byte range for ${contextType}: ${startByte}..${endByte}`);
    }

    const startChunk = rangeCandidates.find(c => c.locator.byte_start === startByte) ?? chunk;
    const endChunk = rangeCandidates.find(c => c.locator.byte_end === endByte) ?? chunk;

    const span: Locator = {
      file: chunk.locator.file_path,
      offset: startByte,
      line: startChunk.locator.line_start,
      column: 1,
      endOffset: endByte,
      endLine: endChunk.locator.line_end,
      endColumn: 1,
    };

    const ctxChunk = chunkFromSpan({
      paper_id: chunk.locator.paper_id,
      canonical_file_path: chunk.locator.file_path,
      canonical_content: params.canonical_content,
      type: contextType,
      span,
      section_path: chunk.locator.section_path,
      label: chunk.locator.label,
    });
    out.push(ctxChunk);
  }

  return out;
}

function assertUniqueChunkIds(chunks: EvidenceChunk[]): void {
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) throw new Error(`Duplicate chunk id: ${chunk.id}`);
    seen.add(chunk.id);
  }
}

async function downloadFileToPath(url: string, destPath: string): Promise<{ status: number; headers: Record<string, string> }> {
  const response = await arxivFetch(url);
  if (!response.ok) {
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  const tmpPath = `${destPath}.tmp-${randomUUID()}`;
  try {
    const fileStream = fs.createWriteStream(tmpPath);
    const readable = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(readable, fileStream);

    try {
      fs.renameSync(tmpPath, destPath);
    } catch (err) {
      if (fs.existsSync(destPath)) {
        fs.rmSync(destPath, { force: true });
        fs.renameSync(tmpPath, destPath);
      } else {
        throw err;
      }
    }
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }

  return { status: response.status, headers };
}

async function isTarArchive(filePath: string): Promise<boolean> {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(512);
    fs.readSync(fd, buffer, 0, 512, 0);
    fs.closeSync(fd);
    const magic = buffer.slice(257, 262).toString('ascii');
    if (magic === 'ustar') return true;
    const checksum = buffer.slice(148, 156).toString('ascii').trim();
    return Boolean(checksum && /^[0-7\s]+$/.test(checksum));
  } catch {
    return false;
  }
}

async function extractTarGz(archivePath: string, destDir: string): Promise<string[]> {
  const files: string[] = [];
  await tar.extract({
    file: archivePath,
    cwd: destDir,
    filter: (entryPath, entry) => {
      const entryType = (entry as { type?: string } | undefined)?.type;
      if (entryType !== 'File' && entryType !== 'Directory') return false;
      const resolved = path.resolve(destDir, entryPath);
      const root = path.resolve(destDir);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) return false;
      return true;
    },
    onentry: entry => {
      if (entry.type === 'File') files.push(entry.path);
    },
  });
  return files;
}

async function extractGz(archivePath: string, destPath: string): Promise<void> {
  const input = fs.createReadStream(archivePath);
  const output = fs.createWriteStream(destPath);
  const gunzip = zlib.createGunzip();
  await pipeline(input, gunzip, output);
}

function findMainTexFile(destDir: string, files: string[]): string | undefined {
  let texFiles = files.filter(f => f.endsWith('.tex'));
  if (texFiles.length === 0) {
    const potentialTexFiles: string[] = [];
    for (const f of files) {
      if (/\.(pdf|png|jpg|jpeg|gif|eps|bib|bbl|cls|sty|bst|aux|log|out|toc|lof|lot|idx|ind|glo|gls|nav|snm|vrb|gz|tar|zip)$/i.test(f)) {
        continue;
      }
      if (path.basename(f).startsWith('.')) continue;

      try {
        const filePath = path.join(destDir, f);
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, 5000);
        if (/\\documentclass/i.test(content)) potentialTexFiles.push(f);
      } catch {
        continue;
      }
    }

    if (potentialTexFiles.length === 0) return undefined;
    texFiles = potentialTexFiles;
  }
  if (texFiles.length === 1) return texFiles[0];

  const fullCandidates: string[] = [];
  const docclassCandidates: string[] = [];

  for (const tex of texFiles) {
    try {
      const content = fs.readFileSync(path.join(destDir, tex), 'utf-8');
      const hasDocclass = /\\documentclass/i.test(content);
      const hasBeginDoc = /\\begin\{document\}/i.test(content);
      if (hasDocclass && hasBeginDoc) fullCandidates.push(tex);
      else if (hasDocclass) docclassCandidates.push(tex);
    } catch {
      // Ignore unreadable candidates
    }
  }

  if (fullCandidates.length === 1) return fullCandidates[0];

  const commonNames = [
    'main.tex',
    'paper.tex',
    'article.tex',
    'manuscript.tex',
    'draft.tex',
    'thesis.tex',
    'report.tex',
    'document.tex',
  ];
  const searchIn = fullCandidates.length > 0 ? fullCandidates : texFiles;
  for (const name of commonNames) {
    const match = searchIn.find(f => f.toLowerCase() === name);
    if (match) return match;
  }

  if (fullCandidates.length > 1) {
    let largest = fullCandidates[0];
    let maxSize = 0;
    for (const tex of fullCandidates) {
      try {
        const size = fs.statSync(path.join(destDir, tex)).size;
        if (size > maxSize) {
          maxSize = size;
          largest = tex;
        }
      } catch {
        // Ignore
      }
    }
    return largest;
  }

  return fullCandidates[0] || docclassCandidates[0] || texFiles.sort()[0];
}

function resolveArxivIdFromPaperId(paperId: string): string | null {
  const m = paperId.match(/^arxiv:(.+)$/i);
  if (m?.[1]) return m[1].trim();
  return null;
}

function normalizeArxivIdForFs(arxivId: string): string {
  return arxivId.replace(/[/.]/g, '_');
}

function resolveRecidFromPaperId(paperId: string): string | null {
  const m = paperId.match(/^inspire:(\d+)$/);
  return m?.[1] ?? null;
}

function candidateProjectPaperIds(paperId: string): string[] {
  const candidates: string[] = [paperId];

  const recid = paperId.match(/^inspire:(\d+)$/)?.[1];
  if (recid) candidates.push(`recid_${recid}`);

  const arxiv = paperId.match(/^arxiv:(.+)$/i)?.[1]?.trim();
  if (arxiv) candidates.push(`arxiv_${normalizeArxivIdForFs(arxiv)}`);

  return Array.from(new Set(candidates));
}

function tryResolveProjectPaperMainTexPath(params: { projectId: string; paperId: string }): { paper_id: string; main_tex_path: string } | null {
  for (const candidate of candidateProjectPaperIds(params.paperId)) {
    const paperJsonPath = getProjectPaperJsonPath(params.projectId, candidate);
    if (!fs.existsSync(paperJsonPath)) continue;

    let paper: any;
    try {
      paper = JSON.parse(fs.readFileSync(paperJsonPath, 'utf-8')) as any;
    } catch (err) {
      throw new Error(`Failed to read project paper.json: ${paperJsonPath} (${err instanceof Error ? err.message : String(err)})`);
    }

    const mainTexRel = String(paper?.source?.main_tex ?? '').trim();
    const kind = String(paper?.source?.kind ?? '').trim();
    if (kind !== 'latex' || !mainTexRel) {
      throw new Error(`Project paper missing LaTeX source.main_tex (project_id=${params.projectId}, paper_id=${candidate})`);
    }

    const extractedDir = getProjectPaperLatexExtractedDir(params.projectId, candidate);
    const mainTexPath = path.resolve(extractedDir, mainTexRel);
    const root = path.resolve(extractedDir);
    if (!mainTexPath.startsWith(root + path.sep) && mainTexPath !== root) {
      throw new Error(`Project paper main_tex escapes extracted dir: ${mainTexRel}`);
    }
    if (!fs.existsSync(mainTexPath)) {
      throw new Error(`Project paper main_tex not found: ${mainTexPath}`);
    }

    return { paper_id: candidate, main_tex_path: mainTexPath };
  }

  return null;
}

async function resolvePaperToArxivIdOrThrow(params: { runId: string; paper_id: string }): Promise<{ arxiv_id: string; artifacts: RunArtifactRef[] }> {
  const directArxiv = resolveArxivIdFromPaperId(params.paper_id);
  if (directArxiv) return { arxiv_id: directArxiv, artifacts: [] };

  const recid = resolveRecidFromPaperId(params.paper_id);
  if (!recid) {
    throw invalidParams('Unsupported paper_id format; expected inspire:<recid> or arxiv:<id>', { paper_id: params.paper_id });
  }

  const cached = await cachedExternalApiJsonCall({
    run_id: params.runId,
    namespace: 'inspire',
    operation: 'getPaper',
    request: { recid, paper_id: params.paper_id },
    fetch: () => api.getPaper(recid),
  });
  const paper = cached.response;

  const arxivId = paper.arxiv_id?.trim();
  if (!arxivId) {
    throw invalidParams('INSPIRE record missing arXiv id', { paper_id: params.paper_id, recid });
  }

  return { arxiv_id: arxivId, artifacts: cached.artifacts };
}

async function materializeMergedLatexForPaper(params: {
  runId: string;
  paper_id: string;
  merged_tex_artifact_name: string;
  force: boolean;
}): Promise<{ merged: string; merged_sha256: string; artifacts: RunArtifactRef[]; cache_hit: boolean }> {
  const artifacts: RunArtifactRef[] = [];
  const existingPath = getRunArtifactPath(params.runId, params.merged_tex_artifact_name);
  if (!params.force && fs.existsSync(existingPath)) {
    const merged = fs.readFileSync(existingPath, 'utf-8');
    return { merged, merged_sha256: sha256HexString(merged), artifacts, cache_hit: true };
  }

  // Zotero/local attachments priority (via project paper sources): if a LaTeX source exists in the project, use it.
  // Fail-fast: do not silently fall back to network if a local source is present but broken.
  const run = getRun(params.runId);
  const local = tryResolveProjectPaperMainTexPath({ projectId: run.project_id, paperId: params.paper_id });
  if (local) {
    const merged = mergeLatexProjectStrict(local.main_tex_path, { maxDepth: 25 });
    const canonical = stripAfterEndDocument(merged);
    const mergedSha256 = sha256HexString(canonical);
    const mergedRef = writeRunTextArtifact({
      runId: params.runId,
      artifactName: params.merged_tex_artifact_name,
      content: canonical,
      mimeType: 'text/x-tex',
    });
    artifacts.push(mergedRef);

    const srcMeta = writeRunJsonArtifact(params.runId, `evidence_source_project_${stableHash(params.paper_id)}.json`, {
      version: 1,
      generated_at: nowIso(),
      paper_id: params.paper_id,
      project_id: run.project_id,
      source_mode: 'project_paper_latex',
      project_paper_id: local.paper_id,
      main_tex: local.main_tex_path,
      merged_tex: { artifact_name: params.merged_tex_artifact_name, uri: mergedRef.uri, sha256: mergedSha256 },
      parser_version: EVIDENCE_INDEX_PARSER_VERSION,
    });
    artifacts.push(srcMeta);

    return { merged: canonical, merged_sha256: mergedSha256, artifacts, cache_hit: false };
  }

  const { arxiv_id, artifacts: resolveArtifacts } = await resolvePaperToArxivIdOrThrow({
    runId: params.runId,
    paper_id: params.paper_id,
  });
  artifacts.push(...resolveArtifacts);

  // Download arXiv source (store as run artifact)
  const sourceUrl = `${ARXIV_EXPORT_BASE}/src/${encodeURIComponent(arxiv_id)}`;
  const headResponse = await arxivFetch(sourceUrl, { method: 'HEAD' });
  const headHeaders: Record<string, string> = {};
  headResponse.headers.forEach((v, k) => {
    headHeaders[k.toLowerCase()] = v;
  });
  const headArtifact = writeRunJsonArtifact(params.runId, `evidence_arxiv_src_head_${stableHash(params.paper_id)}.json`, {
    version: 1,
    generated_at: nowIso(),
    request: { url: sourceUrl, method: 'HEAD', paper_id: params.paper_id, arxiv_id },
    response: { status: headResponse.status, headers: headHeaders },
  });
  artifacts.push(headArtifact);

  const contentType = (headHeaders['content-type'] ?? '').toLowerCase();
  const looksLikePdf = contentType.includes('pdf');
  const looksLikeSource = contentType.includes('gzip') || contentType.includes('x-eprint') || contentType.includes('x-tar');
  if (headResponse.status >= 400 || looksLikePdf || !looksLikeSource) {
    throw new Error(`arXiv source not available as LaTeX archive (content-type=${contentType || 'unknown'}, status=${headResponse.status})`);
  }

  const archiveArtifactName = `evidence_arxiv_src_${stableHash(params.paper_id)}.tar.gz`;
  const archivePath = getRunArtifactPath(params.runId, archiveArtifactName);
  const getMeta = await downloadFileToPath(sourceUrl, archivePath);
  const archiveSha256 = sha256HexBytes(fs.readFileSync(archivePath));
  const getArtifact = writeRunJsonArtifact(params.runId, `evidence_arxiv_src_get_${stableHash(params.paper_id)}.json`, {
    version: 1,
    generated_at: nowIso(),
    request: { url: sourceUrl, method: 'GET', paper_id: params.paper_id, arxiv_id },
    response: {
      status: getMeta.status,
      headers: getMeta.headers,
      archive: { artifact_name: archiveArtifactName, uri: runArtifactUri(params.runId, archiveArtifactName), sha256: archiveSha256 },
    },
  });
  artifacts.push({ name: archiveArtifactName, uri: runArtifactUri(params.runId, archiveArtifactName), mimeType: 'application/gzip' });
  artifacts.push(getArtifact);

  // Extract to temp dir (strict, fail-fast). Canonical output is merged.tex artifact.
  const runDir = getRunDir(params.runId);
  const tmpRoot = path.join(runDir, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const extractDir = fs.mkdtempSync(path.join(tmpRoot, `evidence-${stableHash(params.paper_id)}-`));

  try {
    let files: string[];
    // arXiv /src is gzip; may contain tar or single file.
    const innerPath = path.join(extractDir, 'src_payload');
    await extractGz(archivePath, innerPath);
    if (await isTarArchive(innerPath)) {
      files = await extractTarGz(innerPath, extractDir);
      fs.rmSync(innerPath, { force: true });
    } else {
      const texPath = path.join(extractDir, 'main.tex');
      fs.renameSync(innerPath, texPath);
      files = ['main.tex'];
    }

    const mainRel = findMainTexFile(extractDir, files);
    if (!mainRel) {
      throw new Error(`Could not identify main .tex file in arXiv source (files_total=${files.length})`);
    }

    const mainPath = path.join(extractDir, mainRel);
    const merged = mergeLatexProjectStrict(mainPath, { maxDepth: 25 });
    const canonical = stripAfterEndDocument(merged);
    const mergedSha256 = sha256HexString(canonical);
    const mergedRef = writeRunTextArtifact({
      runId: params.runId,
      artifactName: params.merged_tex_artifact_name,
      content: canonical,
      mimeType: 'text/x-tex',
    });
    artifacts.push(mergedRef);

    const srcMeta = writeRunJsonArtifact(params.runId, `evidence_source_meta_${stableHash(params.paper_id)}.json`, {
      version: 1,
      generated_at: nowIso(),
      paper_id: params.paper_id,
      arxiv_id,
      source_archive: { artifact_name: archiveArtifactName, uri: runArtifactUri(params.runId, archiveArtifactName), sha256: archiveSha256 },
      merged_tex: { artifact_name: params.merged_tex_artifact_name, uri: mergedRef.uri, sha256: mergedSha256 },
      extracted: { main_tex: mainRel, files_total: files.length },
      parser_version: EVIDENCE_INDEX_PARSER_VERSION,
    });
    artifacts.push(srcMeta);

    return { merged: canonical, merged_sha256: mergedSha256, artifacts, cache_hit: false };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function resolveTexPath(basePath: string, includePath: string): string | null {
  if (path.isAbsolute(includePath)) return null;
  let resolved = path.resolve(basePath, includePath);
  if (fs.existsSync(resolved)) return resolved;
  if (!resolved.endsWith('.tex')) {
    resolved = `${resolved}.tex`;
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

function isSafeProjectFile(projectRoot: string, candidatePath: string): boolean {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(candidatePath);
  if (!candidate.startsWith(root + path.sep) && candidate !== root) return false;
  try {
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink()) return false;
    return st.isFile();
  } catch {
    return false;
  }
}

function stripSubfilePreamble(content: string): string {
  const docMatch = content.match(/\\begin\{document\}[\s\S]*?\\end\{document\}/);
  if (!docMatch || docMatch.index === undefined) return content;
  // Keep content between begin/end for subfiles/standalone.
  const beginIdx = content.indexOf('\\begin{document}');
  if (beginIdx < 0) return content;
  const afterBegin = beginIdx + '\\begin{document}'.length;
  const endIdx = content.lastIndexOf('\\end{document}');
  if (endIdx < 0 || endIdx <= afterBegin) return content;
  return content.slice(afterBegin, endIdx);
}

function mergeLatexProjectStrict(mainFilePath: string, options?: { maxDepth?: number }): string {
  const maxDepth = options?.maxDepth ?? 25;
  if (!fs.existsSync(mainFilePath)) throw new Error(`Main tex not found: ${mainFilePath}`);

  const baseDir = path.dirname(path.resolve(mainFilePath));
  const visited = new Set<string>();

  const includeRegex =
    /\\(input|include)\{([^}]+)\}|\\subfile\{([^}]+)\}|\\includestandalone(?:\[[^\]]*\])?\{([^}]+)\}|\\import\{([^}]*)\}\{([^}]+)\}|\\subimport\{([^}]*)\}\{([^}]+)\}/g;

  type IncludeMatch = {
    raw: string;
    start: number;
    end: number;
    type: 'input' | 'include' | 'subfile' | 'standalone' | 'import' | 'subimport';
    path: string;
    importDir?: string;
  };

  function extractIncludes(content: string): IncludeMatch[] {
    const matches: IncludeMatch[] = [];
    let match: RegExpExecArray | null;
    while ((match = includeRegex.exec(content)) !== null) {
      const raw = match[0];
      const start = match.index;
      const end = match.index + raw.length;

      if (match[1] && match[2]) {
        matches.push({ raw, start, end, type: match[1] as IncludeMatch['type'], path: match[2] });
        continue;
      }
      if (match[3]) {
        matches.push({ raw, start, end, type: 'subfile', path: match[3] });
        continue;
      }
      if (match[4]) {
        matches.push({ raw, start, end, type: 'standalone', path: match[4] });
        continue;
      }
      if (match[6] !== undefined) {
        matches.push({ raw, start, end, type: 'import', importDir: match[5] || '', path: match[6] });
        continue;
      }
      if (match[8] !== undefined) {
        matches.push({ raw, start, end, type: 'subimport', importDir: match[7] || '', path: match[8] });
      }
    }
    return matches;
  }

  function mergeFile(filePath: string, includeType?: IncludeMatch['type'], depth = maxDepth): string {
    if (depth <= 0) {
      throw invalidParams('LaTeX include recursion limit exceeded', { file_path: filePath, max_depth: maxDepth });
    }
    if (visited.has(filePath)) {
      return `% [skipped repeated include: ${path.basename(filePath)}]\n`;
    }
    visited.add(filePath);

    let original: string;
    try {
      original = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read LaTeX file: ${filePath} (${err instanceof Error ? err.message : String(err)})`);
    }

    let content = original;
    if (includeType === 'subfile' || includeType === 'standalone') {
      content = stripSubfilePreamble(original);
    }

    const includes = extractIncludes(content);
    if (includes.length === 0) return content;

    const fileDir = path.dirname(filePath);
    let merged = '';
    let cursor = 0;

    for (const inc of includes) {
      merged += content.slice(cursor, inc.start);

      let resolved: string | null = null;
      if (inc.type === 'import') {
        const importBase = path.resolve(baseDir, inc.importDir || '');
        if (importBase.startsWith(baseDir + path.sep) || importBase === baseDir) {
          resolved = resolveTexPath(importBase, inc.path);
        }
      } else if (inc.type === 'subimport') {
        const importBase = path.resolve(fileDir, inc.importDir || '');
        if (importBase.startsWith(baseDir + path.sep) || importBase === baseDir) {
          resolved = resolveTexPath(importBase, inc.path);
        }
      } else {
        resolved = resolveTexPath(fileDir, inc.path);
      }

      if (!resolved) {
        throw invalidParams('Unresolved LaTeX include', { file_path: filePath, include_type: inc.type, include_raw: inc.raw });
      }
      if (!isSafeProjectFile(baseDir, resolved)) {
        throw invalidParams('Unsafe LaTeX include path rejected', { file_path: filePath, include_raw: inc.raw, resolved_path: resolved });
      }

      merged += mergeFile(resolved, inc.type, depth - 1);
      cursor = inc.end;
    }

    merged += content.slice(cursor);
    return merged;
  }

  return mergeFile(path.resolve(mainFilePath));
}

function buildEvidenceChunksFromMergedLatex(params: {
  paper_id: string;
  canonical_file_path: string;
  canonical_content: string;
}): EvidenceChunk[] {
  const canonicalContent = params.canonical_content;
  const ast = latexParser.parse(canonicalContent, { enableComment: true }) as unknown as LatexAst;

  const sectionTimeline = buildSectionTimeline(canonicalContent, ast, params.canonical_file_path);

  const macroWrappedMathPairs = buildMacroWrappedEnvironmentPairsFromContent(canonicalContent, {
    allowedEnvNames: new Set(
      [
        'equation', 'equation*',
        'align', 'align*',
        'gather', 'gather*',
        'multline', 'multline*',
        'eqnarray', 'eqnarray*',
        'flalign', 'flalign*',
      ].map(n => n.toLowerCase())
    ),
  });

  const majorEnvNames = new Set<string>([
    'equation', 'equation*',
    'align', 'align*',
    'gather', 'gather*',
    'multline', 'multline*',
    'eqnarray', 'eqnarray*',
    'flalign', 'flalign*',
    'figure', 'figure*',
    'table', 'table*',
    'theorem', 'lemma', 'proposition', 'corollary',
    'definition', 'remark', 'example', 'proof',
    'conjecture', 'claim',
    'thebibliography',
  ]);

  // Paragraphs (single pass)
  const docContent = getDocumentContent(ast);
  const paragraphs: EvidenceChunk[] = [];
  let paraNodes: LatexNode[] = [];

  const flushParagraph = () => {
    if (paraNodes.length === 0) return;

    const startNode = firstLocated(paraNodes);
    const endNode = lastLocated(paraNodes);
    if (!startNode || !endNode) {
      throw new Error('Paragraph has no locatable nodes (cannot build replayable locator)');
    }

    const startLoc = nodeToLocator(startNode, params.canonical_file_path, canonicalContent);
    const endLoc = nodeToLocator(endNode, params.canonical_file_path, canonicalContent);
    if (startLoc.unknown || endLoc.unknown) {
      throw new Error('Paragraph locator unknown (cannot build replayable locator)');
    }

    const span = mergeSpanLocator(startLoc, endLoc);
    const sectionPath = sectionPathAtOffset(sectionTimeline, span.offset);
    const chunk = chunkFromSpan({
      paper_id: params.paper_id,
      canonical_file_path: params.canonical_file_path,
      canonical_content: canonicalContent,
      type: 'paragraph',
      span,
      section_path: sectionPath,
    });

    if (chunk.text.trim()) paragraphs.push(chunk);
    paraNodes = [];
  };

  for (let nodeIndex = 0; nodeIndex < docContent.length; nodeIndex++) {
    const node = docContent[nodeIndex]!;
    const wrapped = matchMacroWrappedEnvironmentAt(docContent, nodeIndex, macroWrappedMathPairs);
    if (wrapped) {
      flushParagraph();
      nodeIndex = wrapped.endIndex;
      continue;
    }

    if (latexParser.isParbreak(node)) {
      flushParagraph();
      continue;
    }

    if (latexParser.isCommand(node)) {
      const name = node.name.replace(/\*+$/, '').toLowerCase();
      if (name === 'part' || name === 'chapter' || name === 'section' || name === 'subsection' || name === 'subsubsection') {
        flushParagraph();
        continue;
      }
    }

    if (latexParser.isEnvironment(node) && majorEnvNames.has(node.name.toLowerCase())) {
      flushParagraph();
      continue;
    }

    paraNodes.push(node);
  }

  flushParagraph();

  // Equations
  const equations = extractEnhancedEquations(ast, {
    file: params.canonical_file_path,
    includeInline: false,
    content: canonicalContent,
    documentContent: canonicalContent,
    contextWindow: 500,
  });
  const equationChunks: EvidenceChunk[] = [];
  for (const eq of equations) {
    if (!eq.location || eq.location.unknown) continue;
    const sectionPath = sectionPathAtOffset(sectionTimeline, eq.location.offset);
    const span = eq.location;
    const chunk = chunkFromSpan({
      paper_id: params.paper_id,
      canonical_file_path: params.canonical_file_path,
      canonical_content: canonicalContent,
      type: 'equation',
      span,
      section_path: sectionPath,
      label: eq.label,
    });
    equationChunks.push(chunk);
  }

  // Figures
  const figures = extractFigures(ast, { file: params.canonical_file_path });
  const figureChunks: EvidenceChunk[] = [];
  for (const fig of figures) {
    if (!fig.location || fig.location.unknown) continue;
    const sectionPath = sectionPathAtOffset(sectionTimeline, fig.location.offset);
    const chunk = chunkFromSpan({
      paper_id: params.paper_id,
      canonical_file_path: params.canonical_file_path,
      canonical_content: canonicalContent,
      type: 'figure',
      span: fig.location,
      section_path: sectionPath,
      label: fig.label,
    });
    figureChunks.push(chunk);
  }

  // Tables
  const tables = extractTables(ast, { file: params.canonical_file_path, parse_data: false });
  const tableChunks: EvidenceChunk[] = [];
  for (const table of tables) {
    if (!table.location || table.location.unknown) continue;
    const sectionPath = sectionPathAtOffset(sectionTimeline, table.location.offset);
    const chunk = chunkFromSpan({
      paper_id: params.paper_id,
      canonical_file_path: params.canonical_file_path,
      canonical_content: canonicalContent,
      type: 'table',
      span: table.location,
      section_path: sectionPath,
      label: table.label,
    });
    tableChunks.push(chunk);
  }

  // Theorems/definitions
  const theorems = extractTheorems(ast, { file: params.canonical_file_path, include_proofs: false });
  const defChunks: EvidenceChunk[] = [];
  for (const thm of theorems) {
    if (!thm.location || thm.location.unknown) continue;
    const sectionPath = sectionPathAtOffset(sectionTimeline, thm.location.offset);
    const chunk = chunkFromSpan({
      paper_id: params.paper_id,
      canonical_file_path: params.canonical_file_path,
      canonical_content: canonicalContent,
      type: 'definition',
      span: thm.location,
      section_path: sectionPath,
      label: thm.label,
    });
    defChunks.push(chunk);
  }

  // Citation contexts
  const citations = extractCitations(ast, canonicalContent, { file: params.canonical_file_path, include_cross_refs: false });
  const citationChunks: EvidenceChunk[] = [];
  for (const cit of citations) {
    if (!cit.location || cit.location.unknown) continue;
    const sectionPath = sectionPathAtOffset(sectionTimeline, cit.location.offset);
    const chunk = chunkFromSpan({
      paper_id: params.paper_id,
      canonical_file_path: params.canonical_file_path,
      canonical_content: canonicalContent,
      type: 'citation_context',
      span: cit.location,
      section_path: sectionPath,
      forced_outgoing_cites: cit.keys,
    });
    citationChunks.push(chunk);
  }

  // Bibliography entries (thebibliography env)
  const bibliographyChunks: EvidenceChunk[] = [];
  const bibItems: Array<{ key: string; span: Locator }> = [];
  const traverseBib = (nodes: LatexNode[]) => {
    for (const node of nodes) {
      if (latexParser.isEnvironment(node) && node.name === 'thebibliography') {
        let currentKey = '';
        let currentStart: Locator | null = null;
        let currentEnd: Locator | null = null;

        for (const child of node.content) {
          if (latexParser.isCommand(child) && child.name === 'bibitem') {
            if (currentKey && currentStart && currentEnd) {
              bibItems.push({ key: currentKey, span: mergeSpanLocator(currentStart, currentEnd) });
            }

            currentKey = '';
            currentStart = null;
            currentEnd = null;

            const keyArg = child.args?.[0];
            if (keyArg && latexParser.isGroup(keyArg)) {
              const key = extractText(keyArg.content).trim();
              currentKey = key;
            }

            const loc = nodeToLocator(child, params.canonical_file_path, canonicalContent);
            if (!loc.unknown) {
              currentStart = loc;
              currentEnd = loc;
            }
            continue;
          }

          if (currentStart && hasLocation(child)) {
            const loc = nodeToLocator(child, params.canonical_file_path, canonicalContent);
            if (!loc.unknown) currentEnd = loc;
          }
        }

        if (currentKey && currentStart && currentEnd) {
          bibItems.push({ key: currentKey, span: mergeSpanLocator(currentStart, currentEnd) });
        }
        continue;
      }

      if (latexParser.isEnvironment(node)) traverseBib(node.content);
      if (latexParser.isGroup(node)) traverseBib(node.content);
    }
  };

  traverseBib(getDocumentContent(ast));

  for (const bi of bibItems) {
    const sectionPath = sectionPathAtOffset(sectionTimeline, bi.span.offset);
    const chunk = chunkFromSpan({
      paper_id: params.paper_id,
      canonical_file_path: params.canonical_file_path,
      canonical_content: canonicalContent,
      type: 'bibliography_entry',
      span: bi.span,
      section_path: sectionPath,
      label: bi.key || undefined,
      forced_outgoing_cites: [],
    });
    // Locator label is used for sticky lookups; for bibliography entries, set to citekey.
    chunk.locator.label = bi.key || chunk.locator.label;
    bibliographyChunks.push(chunk);
  }

  const hasCitations = citationChunks.some(c => c.refs.outgoing_cites.length > 0);
  if (hasCitations && bibliographyChunks.length === 0) {
    throw invalidParams('Citations found but no bibliography entries extracted (missing thebibliography/.bbl?)', {
      paper_id: params.paper_id,
    });
  }

  let all = [
    ...paragraphs,
    ...equationChunks,
    ...figureChunks,
    ...tableChunks,
    ...defChunks,
    ...citationChunks,
    ...bibliographyChunks,
  ];

  all = applyNavigation(all);
  all = applyIncomingRefs(all);

  all = generateContextChunks({ chunks: all, windowSize: 2, canonical_content: canonicalContent });
  assertUniqueChunkIds(all);

  return all;
}

function computePaperCacheKey(params: { paper_id: string; merged_sha256: string; parser_version: string }): string {
  return stableHash(`${params.paper_id}:${params.merged_sha256}:${params.parser_version}`);
}

function readPaperChunkCacheIfValid(params: {
  runId: string;
  paper_id: string;
  cache_artifact_name: string;
  merged_sha256: string;
  merged_tex_artifact_name: string;
}): EvidenceChunk[] | null {
  const p = getRunArtifactPath(params.runId, params.cache_artifact_name);
  if (!fs.existsSync(p)) return null;
  let parsed: EvidencePaperChunkCacheArtifactV1;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as EvidencePaperChunkCacheArtifactV1;
  } catch {
    return null;
  }
  if (parsed?.version !== 1) return null;
  if (parsed.paper_id !== params.paper_id) return null;
  if (parsed.parser_version !== EVIDENCE_INDEX_PARSER_VERSION) return null;
  if (parsed.merged_tex_artifact_name !== params.merged_tex_artifact_name) return null;
  if (parsed.merged_tex_sha256 !== params.merged_sha256) return null;
  if (parsed.cache_key !== computePaperCacheKey({ paper_id: params.paper_id, merged_sha256: params.merged_sha256, parser_version: EVIDENCE_INDEX_PARSER_VERSION })) {
    return null;
  }
  if (!Array.isArray(parsed.chunks)) return null;
  return parsed.chunks as EvidenceChunk[];
}

export async function buildRunEvidenceIndexV1(params: {
  run_id: string;
  paper_ids: string[];
  output_artifact_name?: string;
  metrics_artifact_name?: string;
  paper_cache_prefix?: string;
  force_rebuild?: boolean;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: {
    paper_ids: string[];
    chunks_total: number;
    by_type: Record<string, number>;
    total_token_estimate: number;
    parser_version: string;
    cache: EvidenceIndexMetricsArtifactV1['cache'];
    artifacts: {
      evidence_index_uri: string;
      evidence_metrics_uri: string;
    };
  };
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
}> {
  const runId = params.run_id;
  const run = getRun(runId);
  const projectId = run.project_id;

  const paperIds = params.paper_ids.map(normalizePaperIdToken).filter(Boolean);
  if (paperIds.length === 0) throw invalidParams('paper_ids cannot be empty', { paper_ids: params.paper_ids });

  const outputArtifactName = params.output_artifact_name ?? 'evidence_index_v1.json';
  const metricsArtifactName = params.metrics_artifact_name ?? 'evidence_index_metrics_v1.json';
  const paperCachePrefix = params.paper_cache_prefix ?? 'evidence_paper';
  const force = params.force_rebuild ?? false;

  const { stepIndex, step } = await startRunStep(runId, 'evidence_ingestion');
  const artifacts: RunArtifactRef[] = [];

  const errorArtifactName = 'evidence_ingestion_error_v1.json';

  let failurePaperId: string | undefined;
  let failureStage: string = 'evidence_ingestion';

  try {
    // Index cache hit: if output + metrics exist and not forcing, return immediately.
    const existingIndexPath = getRunArtifactPath(runId, outputArtifactName);
    const existingMetricsPath = getRunArtifactPath(runId, metricsArtifactName);
    if (!force && fs.existsSync(existingIndexPath) && fs.existsSync(existingMetricsPath)) {
      let metrics: EvidenceIndexMetricsArtifactV1 | null = null;
      try {
        metrics = JSON.parse(fs.readFileSync(existingMetricsPath, 'utf-8')) as EvidenceIndexMetricsArtifactV1;
      } catch {
        metrics = null;
      }

      if (metrics) {
        const indexRef: RunArtifactRef = { name: outputArtifactName, uri: runArtifactUri(runId, outputArtifactName), mimeType: 'application/json' };
        const metricsRef: RunArtifactRef = { name: metricsArtifactName, uri: runArtifactUri(runId, metricsArtifactName), mimeType: 'application/json' };
        const mergedArtifacts = mergeArtifactRefs(step.artifacts, [indexRef, metricsRef]);

        await finishRunStep({
          runId,
          stepIndex,
          stepStart: step,
          status: 'done',
          artifacts: mergedArtifacts,
          notes: 'cache_hit: evidence_index_v1.json',
        });

        return {
          run_id: runId,
          project_id: projectId,
          manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
          artifacts: mergedArtifacts,
          summary: {
            paper_ids: metrics.paper_ids ?? paperIds,
            chunks_total: metrics.chunks?.total ?? 0,
            by_type: metrics.chunks?.by_type ?? {},
            total_token_estimate: metrics.chunks?.total_token_estimate ?? 0,
            parser_version: metrics.parser_version ?? EVIDENCE_INDEX_PARSER_VERSION,
            cache: {
              ...(metrics.cache ?? { papers_total: paperIds.length, papers_cache_hit: 0, papers_cache_miss: paperIds.length, index_cache_hit: true }),
              index_cache_hit: true,
            },
            artifacts: {
              evidence_index_uri: indexRef.uri,
              evidence_metrics_uri: metricsRef.uri,
            },
          },
          next_actions: [
            {
              tool: HEP_RUN_READ_ARTIFACT_CHUNK,
              args: { run_id: runId, artifact_name: outputArtifactName, offset: 0, length: 4096 },
              reason: 'Inspect evidence_index_v1.json (large; use chunked read or MCP Resources).',
            },
          ],
        };
      }
    }

    // Build per-paper chunks
    const perPaper: Array<{ paper_id: string; merged_sha256: string; chunks: EvidenceChunk[]; cache_hit: boolean }> = [];

    let papersCacheHit = 0;
    let papersCacheMiss = 0;

    for (const paperId of paperIds) {
      failurePaperId = paperId;
      failureStage = 'paper_ingestion';

      const paperKey = stableHash(paperId);
      const mergedTexArtifactName = `${paperCachePrefix}_${paperKey}_merged.tex`;
      const chunkCacheArtifactName = `${paperCachePrefix}_${paperKey}_chunks_v1.json`;

      const mergedResult = await materializeMergedLatexForPaper({
        runId,
        paper_id: paperId,
        merged_tex_artifact_name: mergedTexArtifactName,
        force,
      });
      artifacts.push(...mergedResult.artifacts);
      artifacts.push({
        name: mergedTexArtifactName,
        uri: runArtifactUri(runId, mergedTexArtifactName),
        mimeType: 'text/x-tex',
      });

      const cachedChunks = !force
        ? readPaperChunkCacheIfValid({
            runId,
            paper_id: paperId,
            cache_artifact_name: chunkCacheArtifactName,
            merged_sha256: mergedResult.merged_sha256,
            merged_tex_artifact_name: mergedTexArtifactName,
          })
        : null;

      if (cachedChunks) {
        papersCacheHit += 1;
        artifacts.push({
          name: chunkCacheArtifactName,
          uri: runArtifactUri(runId, chunkCacheArtifactName),
          mimeType: 'application/json',
        });
        perPaper.push({ paper_id: paperId, merged_sha256: mergedResult.merged_sha256, chunks: cachedChunks, cache_hit: true });
        continue;
      }

      papersCacheMiss += 1;
      const chunks = buildEvidenceChunksFromMergedLatex({
        paper_id: paperId,
        canonical_file_path: mergedTexArtifactName,
        canonical_content: mergedResult.merged,
      });

      // Paper-level cache artifact
      const cacheKey = computePaperCacheKey({ paper_id: paperId, merged_sha256: mergedResult.merged_sha256, parser_version: EVIDENCE_INDEX_PARSER_VERSION });
      const cacheArtifact = writeRunJsonArtifact(runId, chunkCacheArtifactName, {
        version: 1,
        generated_at: nowIso(),
        paper_id: paperId,
        parser_version: EVIDENCE_INDEX_PARSER_VERSION,
        merged_tex_artifact_name: mergedTexArtifactName,
        merged_tex_sha256: mergedResult.merged_sha256,
        cache_key: cacheKey,
        chunks,
      } satisfies EvidencePaperChunkCacheArtifactV1);
      artifacts.push(cacheArtifact);

      perPaper.push({ paper_id: paperId, merged_sha256: mergedResult.merged_sha256, chunks, cache_hit: false });
    }

    failurePaperId = undefined;
    failureStage = 'evidence_ingestion';

    const allChunks = perPaper.flatMap(p => p.chunks);

    // Run-level index artifact
    const index = buildIndex(allChunks);
    const serialized = serializeIndex(index, paperIds) as SerializedIndex & Record<string, unknown>;

    // Embed ingestion metadata (deserializeIndex ignores unknown keys).
    (serialized as any).run_id = runId;
    (serialized as any).project_id = projectId;
    (serialized as any).parser_version = EVIDENCE_INDEX_PARSER_VERSION;
    (serialized as any).source_mode = 'latex_canonical_merged_v1';
    (serialized as any).input_fingerprints = Object.fromEntries(perPaper.map(p => [p.paper_id, { merged_sha256: p.merged_sha256 }]));

    const indexRef = writeRunJsonArtifact(runId, outputArtifactName, serialized);
    artifacts.push(indexRef);

    // Metrics artifact
    const byType: Record<string, number> = {};
    let totalTokens = 0;
    const byPaper: Array<{ paper_id: string; chunk_count: number; token_estimate: number }> = [];
    for (const p of perPaper) {
      const tokenEstimate = p.chunks.reduce((sum, c) => sum + (c.metadata.token_estimate ?? 0), 0);
      byPaper.push({ paper_id: p.paper_id, chunk_count: p.chunks.length, token_estimate: tokenEstimate });
    }
    for (const chunk of allChunks) {
      byType[chunk.type] = (byType[chunk.type] ?? 0) + 1;
      totalTokens += chunk.metadata.token_estimate;
    }
    byPaper.sort((a, b) => b.chunk_count - a.chunk_count || a.paper_id.localeCompare(b.paper_id));

    const metrics: EvidenceIndexMetricsArtifactV1 = {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      project_id: projectId,
      parser_version: EVIDENCE_INDEX_PARSER_VERSION,
      paper_ids: paperIds,
      cache: {
        papers_total: paperIds.length,
        papers_cache_hit: papersCacheHit,
        papers_cache_miss: papersCacheMiss,
        index_cache_hit: false,
      },
      chunks: {
        total: allChunks.length,
        total_token_estimate: totalTokens,
        by_type: byType,
        by_paper: byPaper,
      },
    };

    const metricsRef = writeRunJsonArtifact(runId, metricsArtifactName, metrics);
    artifacts.push(metricsRef);

    const mergedArtifacts = mergeArtifactRefs(step.artifacts, artifacts);

    await finishRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts: mergedArtifacts,
    });

    return {
      run_id: runId,
      project_id: projectId,
      manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
      artifacts: mergedArtifacts,
      summary: {
        paper_ids: paperIds,
        chunks_total: allChunks.length,
        by_type: byType,
        total_token_estimate: totalTokens,
        parser_version: EVIDENCE_INDEX_PARSER_VERSION,
        cache: metrics.cache,
        artifacts: {
          evidence_index_uri: indexRef.uri,
          evidence_metrics_uri: metricsRef.uri,
        },
      },
      next_actions: [
        {
          tool: HEP_RUN_READ_ARTIFACT_CHUNK,
          args: { run_id: runId, artifact_name: outputArtifactName, offset: 0, length: 4096 },
          reason: 'Inspect evidence index (large; use chunked read or MCP Resources).',
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const paperId = failurePaperId;
    const stage = failureStage;

    const nextActions: EvidenceIndexBuildErrorArtifactV1['next_actions'] = [];

    const recid = paperId ? resolveRecidFromPaperId(paperId) : null;
    if (recid) {
      nextActions.push({
        tool: INSPIRE_LITERATURE,
        args: { mode: 'get_paper', recid },
        reason: 'Inspect INSPIRE record and confirm it has an arXiv eprint.',
      });
    }

    nextActions.push({
      tool: HEP_RUN_BUILD_EVIDENCE_INDEX_V1,
      args: { run_id: runId, paper_ids: paperIds, force_rebuild: true },
      reason: 'Re-run evidence ingestion after fixing the source (force rebuild).',
    });

    const errorArtifact: EvidenceIndexBuildErrorArtifactV1 = {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      project_id: projectId,
      step: 'evidence_ingestion',
      failures: [
        {
          paper_id: paperId,
          stage,
          message,
        },
      ],
      next_actions: nextActions,
    };

    const errRef = writeRunJsonArtifact(runId, errorArtifactName, errorArtifact);
    artifacts.push(errRef);

    const mergedArtifacts = mergeArtifactRefs(step.artifacts, artifacts);

    await finishRunStep({
      runId,
      stepIndex,
      stepStart: step,
      status: 'failed',
      artifacts: mergedArtifacts,
      notes: message,
    });

    throw err;
  }
}
