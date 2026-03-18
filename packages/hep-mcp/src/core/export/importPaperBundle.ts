import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { invalidParams } from '@autoresearch/shared';
import { zipSync } from 'fflate';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { assertSafePathSegment, getRunArtifactPath, getRunDir } from '../paths.js';
import { isPathInside, resolvePathWithinParent } from '../../data/pathGuard.js';
import { HEP_EXPORT_PAPER_SCAFFOLD, HEP_IMPORT_PAPER_BUNDLE } from '../../tool-names.js';
import { createHepRunArtifactRef, makeHepRunManifestUri } from '../runArtifactUri.js';

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Bytes(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
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
  const now = nowIso();
  const manifestStart = await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: HEP_IMPORT_PAPER_BUNDLE, args: { run_id: runId } },
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

function makeRunArtifactRef(runId: string, artifactName: string, mimeType: string): RunArtifactRef {
  return createHepRunArtifactRef(runId, artifactName, mimeType);
}

function writeRunTextArtifact(params: { run_id: string; artifact_name: string; content: string; mimeType: string }): RunArtifactRef {
  fs.writeFileSync(getRunArtifactPath(params.run_id, params.artifact_name), params.content, 'utf-8');
  return makeRunArtifactRef(params.run_id, params.artifact_name, params.mimeType);
}

function writeRunBinaryArtifact(params: { run_id: string; artifact_name: string; bytes: Uint8Array; mimeType: string }): RunArtifactRef {
  fs.writeFileSync(getRunArtifactPath(params.run_id, params.artifact_name), Buffer.from(params.bytes));
  return makeRunArtifactRef(params.run_id, params.artifact_name, params.mimeType);
}

function relPaperPath(paperDir: string, filePath: string): string {
  return path.relative(paperDir, filePath).replaceAll(path.sep, '/');
}

function readJsonFileOrFail(filePath: string, label: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as any;
  } catch (err) {
    throw invalidParams(`Invalid JSON: ${label} (fail-fast)`, {
      file_path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function ensureNoHepUrisInTexFiles(paperDir: string, files: string[]): void {
  for (const p of files) {
    if (!p.toLowerCase().endsWith('.tex')) continue;
    const text = fs.readFileSync(p, 'utf-8');
    if (text.includes('hep://')) {
      throw invalidParams('Refusing to import LaTeX containing hep:// URIs (must be portable) (fail-fast)', {
        file: relPaperPath(paperDir, p),
        hint: 'Rewrite hep://runs/<run_id>/artifact/... to local paths (e.g., figures/plot.pdf) before importing.',
      });
    }
  }
}

export interface ImportPaperBundleParams {
  run_id: string;
  paper_dir_name?: string;
  version?: number;
  zip_artifact_name?: string;
  bundle_manifest_artifact_name?: string;
  pdf_artifact_name?: string;
  overwrite?: boolean;
  dereference_symlinks?: boolean;
  allow_external_symlink_targets?: boolean;
}

export interface ImportPaperBundleResult {
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
}

export async function importPaperBundleForRun(params: ImportPaperBundleParams): Promise<ImportPaperBundleResult> {
  const runId = params.run_id;
  const run = getRun(runId);

  const paperDirName = params.paper_dir_name?.trim() || 'paper';
  assertSafePathSegment(paperDirName, 'paper_dir_name');

  const zipName = params.zip_artifact_name?.trim() || 'paper_bundle.zip';
  assertSafePathSegment(zipName, 'zip_artifact_name');

  const bundleManifestName = params.bundle_manifest_artifact_name?.trim() || 'paper_bundle_manifest.json';
  assertSafePathSegment(bundleManifestName, 'bundle_manifest_artifact_name');

  const pdfArtifactName = params.pdf_artifact_name?.trim() || 'paper_final.pdf';
  assertSafePathSegment(pdfArtifactName, 'pdf_artifact_name');

  const overwrite = Boolean(params.overwrite);
  const dereferenceSymlinks = Boolean(params.dereference_symlinks);
  const allowExternalSymlinkTargets = Boolean(params.allow_external_symlink_targets);
  const version = params.version;
  if (version !== undefined) {
    if (!Number.isInteger(version) || version < 1) {
      throw invalidParams('version must be an integer >= 1', { run_id: runId, version });
    }
  }

  const { manifestStart, stepIndex, step } = await startRunStep(runId, 'import_paper_bundle');
  const artifacts: RunArtifactRef[] = [];

  try {
    const runDir = getRunDir(runId);
    const basePaperDir = resolvePathWithinParent(runDir, path.join(runDir, paperDirName), 'paper_dir');
    const paperDir = version === undefined
      ? basePaperDir
      : resolvePathWithinParent(basePaperDir, path.join(basePaperDir, `v${version}`), 'paper_version_dir');

    if (!fs.existsSync(paperDir)) {
      throw invalidParams('paper_dir does not exist (fail-fast)', {
        run_id: runId,
        paper_dir: paperDir,
        next_actions: [
          { tool: HEP_EXPORT_PAPER_SCAFFOLD, args: { run_id: runId }, reason: 'Create a starting paper/ scaffold inside the run directory.' },
        ],
      });
    }

    const paperDirStat = fs.lstatSync(paperDir);
    if (paperDirStat.isSymbolicLink()) {
      throw invalidParams('Refusing to import from a symlinked paper_dir (fail-fast)', {
        run_id: runId,
        paper_dir: paperDir,
      });
    }
    if (!paperDirStat.isDirectory()) {
      throw invalidParams('paper_dir exists but is not a directory (fail-fast)', { run_id: runId, paper_dir: paperDir });
    }

    const paperManifestPath = path.join(paperDir, 'paper_manifest.json');
    if (!fs.existsSync(paperManifestPath)) {
      throw invalidParams('Missing paper_manifest.json (fail-fast)', {
        run_id: runId,
        paper_dir: paperDir,
        expected: 'paper_manifest.json',
        next_actions: [
          { tool: HEP_EXPORT_PAPER_SCAFFOLD, args: { run_id: runId, overwrite: true }, reason: 'Recreate a valid paper scaffold and re-apply changes.' },
        ],
      });
    }

    const paperManifest = readJsonFileOrFail(paperManifestPath, 'paper_manifest.json');
    const rawSchemaVersion = paperManifest?.schemaVersion;
    const schemaVersion =
      (typeof rawSchemaVersion === 'number' && Number.isInteger(rawSchemaVersion))
      || (typeof rawSchemaVersion === 'string' && rawSchemaVersion.trim().length > 0)
        ? rawSchemaVersion
        : null;
    if (schemaVersion === null) {
      throw invalidParams('paper_manifest.json missing schemaVersion (fail-fast)', { run_id: runId, paper_dir: paperDir });
    }
    const mainTexRel = typeof paperManifest?.latex?.mainTex === 'string' ? paperManifest.latex.mainTex : 'main.tex';
    const mainTexPath = resolvePathWithinParent(paperDir, path.join(paperDir, mainTexRel), 'main.tex');
    if (!fs.existsSync(mainTexPath)) {
      throw invalidParams('paper_manifest.json references missing mainTeX file (fail-fast)', {
        run_id: runId,
        paper_dir: paperDir,
        main_tex: mainTexRel,
      });
    }

    if (fs.existsSync(getRunArtifactPath(runId, zipName)) && !overwrite) {
      throw invalidParams('paper bundle artifact already exists (fail-fast)', {
        run_id: runId,
        artifact: zipName,
        overwrite: false,
        next_actions: [
          { tool: HEP_IMPORT_PAPER_BUNDLE, args: { run_id: runId, overwrite: true }, reason: 'Overwrite the existing paper bundle artifacts.' },
        ],
      });
    }

    const paperDirReal = fs.realpathSync(paperDir);
    const symlinks: Array<{ rel: string; target: string; resolved?: string | null; kind?: 'file' | 'dir' | 'other' }> = [];
    const filesToZip: string[] = [];
    const visitedDirs = new Set<string>();

    const walk = (dir: string): void => {
      let real: string;
      try {
        real = fs.realpathSync(dir);
      } catch {
        real = dir;
      }
      if (visitedDirs.has(real)) return;
      visitedDirs.add(real);

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        const rel = relPaperPath(paperDir, p);
        if (rel === '.' || rel === '') continue;

        // Always enforce the discovered path is within paperDir (defense-in-depth).
        if (!isPathInside(paperDir, p)) {
          throw invalidParams('Internal: discovered path outside paper_dir (fail-fast)', { run_id: runId, paper_dir: paperDir, path: p });
        }

        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) {
          const target = fs.readlinkSync(p);
          let resolved: string | null = null;
          let kind: 'file' | 'dir' | 'other' = 'other';

          try {
            resolved = fs.realpathSync(p);
            const follow = fs.statSync(p);
            if (follow.isFile()) kind = 'file';
            else if (follow.isDirectory()) kind = 'dir';
          } catch {
            resolved = null;
            kind = 'other';
          }

          symlinks.push({ rel, target, resolved, kind });

          if (!dereferenceSymlinks) {
            throw invalidParams('Refusing to import paper/ containing symlinks (fail-fast)', {
              run_id: runId,
              paper_dir: paperDir,
              symlink: { path: rel, target, resolved, kind },
              hint: 'Either materialize symlink targets into paper/, or re-run with dereference_symlinks=true (and review safety implications).',
            });
          }

          if (resolved === null) {
            throw invalidParams('Refusing to import broken symlink (fail-fast)', { run_id: runId, paper_dir: paperDir, symlink: { path: rel, target } });
          }

          if (!allowExternalSymlinkTargets && !isPathInside(paperDirReal, resolved)) {
            throw invalidParams('Refusing to dereference symlink pointing outside paper_dir (fail-fast)', {
              run_id: runId,
              paper_dir: paperDir,
              paper_dir_realpath: paperDirReal,
              symlink: { path: rel, target, resolved, kind },
              hint: 'Copy the target into paper/ (recommended), or re-run with allow_external_symlink_targets=true.',
            });
          }

          if (kind === 'dir') {
            walk(p);
            continue;
          }
          if (kind === 'file') {
            filesToZip.push(p);
            continue;
          }
          throw invalidParams('Refusing to import unsupported symlink (fail-fast)', {
            run_id: runId,
            paper_dir: paperDir,
            symlink: { path: rel, target, resolved, kind },
          });
        }

        if (st.isDirectory()) {
          walk(p);
          continue;
        }
        if (st.isFile()) {
          filesToZip.push(p);
        }
      }
    };

    walk(paperDir);
    filesToZip.sort((a, b) => relPaperPath(paperDir, a).localeCompare(relPaperPath(paperDir, b)));

    ensureNoHepUrisInTexFiles(paperDir, filesToZip);

    const checksums: Record<string, { sha256: string; size_bytes: number }> = {};
    const pdfs: string[] = [];
    let totalBytes = 0;

    const zipEntries: Record<string, Uint8Array> = {};
    for (const p of filesToZip) {
      const rel = relPaperPath(paperDir, p);
      const zipPath = `paper/${rel}`;
      const bytes = fs.readFileSync(p);
      const b = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      zipEntries[zipPath] = b;

      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const sizeBytes = bytes.byteLength;
      totalBytes += sizeBytes;
      checksums[rel] = { sha256, size_bytes: sizeBytes };

      if (rel.toLowerCase().endsWith('.pdf')) pdfs.push(rel);
    }

    const bundleManifest = {
      schemaVersion: '1.0',
      importedAt: nowIso(),
      importer: { name: HEP_IMPORT_PAPER_BUNDLE },
      source: {
        hepRunId: runId,
        hepRunUri: makeHepRunManifestUri(runId),
        projectId: run.project_id,
        paperDir,
        paperManifest: { schemaVersion, mainTex: mainTexRel },
      },
      options: {
        dereference_symlinks: dereferenceSymlinks,
        allow_external_symlink_targets: allowExternalSymlinkTargets,
      },
      symlinks,
      stats: {
        files: Object.keys(checksums).length,
        total_bytes: totalBytes,
        pdfs: pdfs.length,
      },
      pdfs,
      checksums: { algorithm: 'sha256', files: checksums },
    };

    const bundleManifestText = JSON.stringify(bundleManifest, null, 2) + '\n';
    artifacts.push(writeRunTextArtifact({
      run_id: runId,
      artifact_name: bundleManifestName,
      content: bundleManifestText,
      mimeType: 'application/json',
    }));

    const zipBytes = zipSync(zipEntries, { level: 9 });
    artifacts.push(writeRunBinaryArtifact({
      run_id: runId,
      artifact_name: zipName,
      bytes: zipBytes,
      mimeType: 'application/zip',
    }));

    const mainPdfPath = path.join(paperDir, 'main.pdf');
    if (fs.existsSync(mainPdfPath)) {
      const bytes = fs.readFileSync(mainPdfPath);
      artifacts.push(writeRunBinaryArtifact({
        run_id: runId,
        artifact_name: pdfArtifactName,
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        mimeType: 'application/pdf',
      }));
    }

    const completedAt = nowIso();
    const stepArtifacts = mergeArtifactRefs(step.artifacts, artifacts);
    const manifestDone = buildManifestAfterStep({
      manifestStart,
      stepIndex,
      stepStart: step,
      status: 'done',
      artifacts: stepArtifacts,
      now: completedAt,
      notes: `Imported paper bundle from ${paperDir} into ${zipName}`,
    });

    await updateRunManifestAtomic({
      run_id: runId,
      tool: { name: HEP_IMPORT_PAPER_BUNDLE, args: { run_id: runId } },
      update: _current => manifestDone,
    });

    const pdfIncluded = artifacts.some(a => a.name === pdfArtifactName);

    return {
      run_id: runId,
      project_id: run.project_id,
      manifest_uri: makeHepRunManifestUri(runId),
      artifacts,
      summary: {
        paper_dir: paperDir,
        files: Object.keys(checksums).length,
        total_bytes: totalBytes,
        pdfs,
        pdf_artifact_written: pdfIncluded ? pdfArtifactName : null,
        bundle: { artifact: zipName, bytes: zipBytes.length, sha256: sha256Bytes(zipBytes) },
        bundle_manifest: { artifact: bundleManifestName },
      },
    };
  } catch (err) {
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
        tool: { name: HEP_IMPORT_PAPER_BUNDLE, args: { run_id: runId } },
        update: _current => manifestFailed,
      });
    } catch {
      // ignore update errors; original error is more important
    }
    throw err;
  }
}
