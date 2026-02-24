import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { invalidParams } from '@autoresearch/shared';

import type { RunArtifactRef } from '../runs.js';
import { assertSafePathSegment, getRunArtifactPath, getRunArtifactsDir, getRunManifestPath } from '../paths.js';

export type WritingCheckpointV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  current_step: string;
  round: number;
  last_completed_at: string;
  pointers: Record<string, string>;
  hashes: Record<string, string>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function runArtifactUri(runId: string, artifactName: string): string {
  return `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`;
}

function makeRunArtifactRef(runId: string, artifactName: string, mimeType: string): RunArtifactRef {
  return { name: artifactName, uri: runArtifactUri(runId, artifactName), mimeType };
}

function sha256HexBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256HexString(text: string): string {
  return sha256HexBytes(Buffer.from(text, 'utf-8'));
}

function atomicWriteFileSync(filePath: string, content: string | Uint8Array): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${randomUUID()}`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

export function inferWritingRoundFromArtifacts(runId: string): number {
  const artifactsDir = getRunArtifactsDir(runId);
  if (!fs.existsSync(artifactsDir)) return 1;

  const entries = fs.readdirSync(artifactsDir, { withFileTypes: true });
  let best = 1;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(/^writing_(?:reviewer_report_round|revision_plan_round)_(\d{2})/);
    if (!m?.[1]) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1) best = Math.max(best, n);
  }
  return best;
}

function parseHepRunFileUriOrThrow(uri: string): { runId: string; kind: 'artifact'; artifactName: string } | { runId: string; kind: 'manifest' } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalidParams('Invalid run URI', { uri });
  }
  if (url.protocol !== 'hep:') throw invalidParams('Invalid run URI protocol', { uri, protocol: url.protocol });
  if (url.host !== 'runs') throw invalidParams('Invalid run URI host', { uri, host: url.host });

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  } catch (err) {
    throw invalidParams('Invalid run URI encoding', { uri, error: err instanceof Error ? err.message : String(err) });
  }

  if (segments.length === 2 && segments[1] === 'manifest') {
    const runId = segments[0]!;
    assertSafePathSegment(runId, 'run_id');
    return { runId, kind: 'manifest' };
  }
  if (segments.length === 3 && segments[1] === 'artifact') {
    const runId = segments[0]!;
    const artifactName = segments[2]!;
    assertSafePathSegment(runId, 'run_id');
    assertSafePathSegment(artifactName, 'artifact_name');
    return { runId, kind: 'artifact', artifactName };
  }

  throw invalidParams('Invalid run URI path (expected hep://runs/<run_id>/manifest or hep://runs/<run_id>/artifact/<artifact_name>)', { uri });
}

export function computeUriSha256OrThrow(params: { run_id: string; uri: string }): string {
  const parsed = parseHepRunFileUriOrThrow(params.uri);
  if (parsed.runId !== params.run_id) {
    throw invalidParams('Cross-run URI is not allowed (fail-fast)', { run_id: params.run_id, uri: params.uri });
  }
  const filePath = parsed.kind === 'manifest'
    ? getRunManifestPath(params.run_id)
    : getRunArtifactPath(params.run_id, parsed.artifactName);
  try {
    const bytes = fs.readFileSync(filePath);
    return sha256HexBytes(bytes);
  } catch (err) {
    throw invalidParams('Failed to read artifact for hashing (fail-fast)', {
      run_id: params.run_id,
      uri: params.uri,
      kind: parsed.kind,
      ...(parsed.kind === 'artifact' ? { artifact_name: parsed.artifactName } : {}),
      error: err instanceof Error ? err.message : String(err),
      next_actions: [
        ...(parsed.kind === 'artifact'
          ? [{ tool: 'hep_run_read_artifact_chunk', args: { run_id: params.run_id, artifact_name: parsed.artifactName, offset: 0, length: 1024 }, reason: 'Inspect the artifact bytes to diagnose the IO failure.' }]
          : []),
        { tool: 'hep_export_project', args: { project_id: '<project_id>', include_runs: true, include_artifacts: true }, reason: 'Export the run for manual inspection/recovery if hashing fails due to filesystem issues.' },
      ],
    });
  }
}

export function writeRunJsonArtifactAtomic(runId: string, artifactName: string, data: unknown): RunArtifactRef {
  const artifactPath = getRunArtifactPath(runId, artifactName);
  try {
    atomicWriteFileSync(artifactPath, JSON.stringify(data, null, 2));
  } catch (err) {
    throw invalidParams('Failed to write run artifact (fail-fast)', {
      run_id: runId,
      artifact_name: artifactName,
      error: err instanceof Error ? err.message : String(err),
      next_actions: [
        { tool: 'hep_run_read_artifact_chunk', args: { run_id: runId, artifact_name: artifactName, offset: 0, length: 256 }, reason: 'Verify whether the artifact was partially written.' },
      ],
    });
  }
  return makeRunArtifactRef(runId, artifactName, 'application/json');
}

export function writeRunTextArtifactAtomic(params: { run_id: string; artifact_name: string; content: string; mimeType: string }): RunArtifactRef {
  const artifactPath = getRunArtifactPath(params.run_id, params.artifact_name);
  try {
    atomicWriteFileSync(artifactPath, params.content);
  } catch (err) {
    throw invalidParams('Failed to write run text artifact (fail-fast)', {
      run_id: params.run_id,
      artifact_name: params.artifact_name,
      error: err instanceof Error ? err.message : String(err),
      next_actions: [
        { tool: 'hep_run_read_artifact_chunk', args: { run_id: params.run_id, artifact_name: params.artifact_name, offset: 0, length: 256 }, reason: 'Verify whether the artifact was partially written.' },
      ],
    });
  }
  return makeRunArtifactRef(params.run_id, params.artifact_name, params.mimeType);
}

export function writeWritingCheckpointV1(params: {
  run_id: string;
  current_step: string;
  round?: number;
  pointers?: Record<string, string>;
}): RunArtifactRef {
  const runId = params.run_id;
  const roundRaw = params.round ?? inferWritingRoundFromArtifacts(runId);
  const round = Number(roundRaw);
  if (!Number.isFinite(round) || Math.trunc(round) !== round || round < 1) {
    throw invalidParams('round must be a positive integer', { round: params.round });
  }

  const knownPointers: Record<string, string> = {};
  const known: Array<[string, string, string]> = [
    ['paperset_uri', 'writing_paperset_v1.json', 'application/json'],
    ['outline_uri', 'writing_outline_v2.json', 'application/json'],
    ['packets_uri', 'writing_packets_sections.json', 'application/json'],
    ['integrated_uri', 'writing_integrated.tex', 'text/x-tex'],
    ['reviewer_report_uri', 'writing_reviewer_report.json', 'application/json'],
    ['quality_policy_uri', 'writing_quality_policy_v1.json', 'application/json'],
  ];
  for (const [key, artifactName] of known) {
    const p = getRunArtifactPath(runId, artifactName);
    if (!fs.existsSync(p)) continue;
    knownPointers[key] = runArtifactUri(runId, artifactName);
  }

  const pointers: Record<string, string> = { ...knownPointers, ...(params.pointers ?? {}) };
  const hashes: Record<string, string> = {};
  for (const [key, uri] of Object.entries(pointers)) {
    hashes[key] = computeUriSha256OrThrow({ run_id: runId, uri });
  }

  const now = nowIso();
  const payload: WritingCheckpointV1 = {
    version: 1,
    generated_at: now,
    run_id: runId,
    current_step: params.current_step,
    round,
    last_completed_at: now,
    pointers,
    hashes,
  };

  return writeRunJsonArtifactAtomic(runId, 'writing_checkpoint.json', payload);
}

export function writeWritingJournalMarkdown(params: {
  run_id: string;
  step: string;
  round?: number;
  status: 'success' | 'failed';
  title?: string;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
  decisions?: string[];
  error?: { message: string; data?: Record<string, unknown> };
  next_actions?: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
  artifact_name?: string;
}): RunArtifactRef {
  const runId = params.run_id;
  const roundRaw = params.round ?? inferWritingRoundFromArtifacts(runId);
  const round = Number(roundRaw);
  if (!Number.isFinite(round) || Math.trunc(round) !== round || round < 1) {
    throw invalidParams('round must be a positive integer', { round: params.round });
  }
  const artifactName = params.artifact_name?.trim()
    ? params.artifact_name.trim()
    : `writing_journal_${params.step}_round_${String(round).padStart(2, '0')}.md`;

  const lines: string[] = [];
  lines.push(`# Writing Journal`);
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- step: ${params.step}`);
  lines.push(`- round: ${String(round).padStart(2, '0')}`);
  lines.push(`- status: ${params.status}`);
  lines.push(`- generated_at: ${nowIso()}`);
  if (params.title) lines.push(`- title: ${params.title}`);
  lines.push('');

  const writeUriSection = (header: string, entries: Record<string, string> | undefined) => {
    if (!entries || Object.keys(entries).length === 0) return;
    lines.push(`## ${header}`);
    for (const [key, uri] of Object.entries(entries)) {
      const hash = computeUriSha256OrThrow({ run_id: runId, uri });
      lines.push(`- ${key}: ${uri} (sha256=${hash})`);
    }
    lines.push('');
  };

  writeUriSection('Inputs', params.inputs);
  writeUriSection('Outputs', params.outputs);

  if (params.decisions && params.decisions.length > 0) {
    lines.push('## Decisions');
    for (const d of params.decisions) lines.push(`- ${d}`);
    lines.push('');
  }

  if (params.error) {
    lines.push('## Failure');
    lines.push(`- message: ${params.error.message}`);
    if (params.error.data && Object.keys(params.error.data).length > 0) {
      lines.push('- data:');
      lines.push('```json');
      lines.push(JSON.stringify(params.error.data, null, 2));
      lines.push('```');
    }
    lines.push('');
  }

  if (params.next_actions && params.next_actions.length > 0) {
    lines.push('## Next Actions');
    for (const a of params.next_actions) {
      lines.push(`- tool: ${a.tool}`);
      lines.push(`  reason: ${a.reason}`);
      lines.push('  args:');
      lines.push('  ```json');
      lines.push(JSON.stringify(a.args, null, 2).split('\n').map(l => `  ${l}`).join('\n'));
      lines.push('  ```');
    }
    lines.push('');
  }

  return writeRunTextArtifactAtomic({ run_id: runId, artifact_name: artifactName, content: lines.join('\n'), mimeType: 'text/markdown' });
}

export function writePromptPacketArtifact(params: {
  run_id: string;
  artifact_name: string;
  step: string;
  round?: number;
  prompt_packet: unknown;
  mode_used: 'internal' | 'client';
  tool?: string;
  schema?: string;
  extra?: Record<string, unknown>;
}): RunArtifactRef {
  const now = nowIso();
  return writeRunJsonArtifactAtomic(params.run_id, params.artifact_name, {
    version: 1,
    generated_at: now,
    run_id: params.run_id,
    step: params.step,
    round: params.round ?? inferWritingRoundFromArtifacts(params.run_id),
    mode_used: params.mode_used,
    ...(params.tool ? { tool: params.tool } : {}),
    ...(params.schema ? { schema: params.schema } : {}),
    prompt_packet: params.prompt_packet,
    ...(params.extra ? { extra: params.extra } : {}),
  });
}

export function writeClientLlmResponseArtifact(params: {
  run_id: string;
  artifact_name: string;
  step: string;
  round?: number;
  prompt_packet_uri?: string;
  prompt_packet_sha256?: string;
  client_raw_output_uri?: string;
  client_raw_output_sha256?: string;
  parsed: unknown;
  client_model?: string | null;
  temperature?: number | null;
  seed?: number | string | null;
  cached_response_uri?: string;
  cache_hit?: boolean;
}): RunArtifactRef {
  const promptPacketSha = params.prompt_packet_sha256
    ?? (params.prompt_packet_uri ? computeUriSha256OrThrow({ run_id: params.run_id, uri: params.prompt_packet_uri }) : undefined);
  const rawSha = params.client_raw_output_sha256
    ?? (params.client_raw_output_uri ? computeUriSha256OrThrow({ run_id: params.run_id, uri: params.client_raw_output_uri }) : undefined);

  return writeRunJsonArtifactAtomic(params.run_id, params.artifact_name, {
    version: 1,
    generated_at: nowIso(),
    run_id: params.run_id,
    step: params.step,
    round: params.round ?? inferWritingRoundFromArtifacts(params.run_id),
    mode_used: 'client',
    prompt_packet: params.prompt_packet_uri
      ? { uri: params.prompt_packet_uri, sha256: promptPacketSha ?? null }
      : { uri: null, sha256: null },
    client_raw_output: params.client_raw_output_uri
      ? { uri: params.client_raw_output_uri, sha256: rawSha ?? null }
      : { uri: null, sha256: null },
    client_model: params.client_model ?? null,
    temperature: params.temperature ?? null,
    seed: params.seed ?? 'unknown',
    cache_hit: params.cache_hit ?? false,
    cached_response_uri: params.cached_response_uri ?? null,
    parsed: params.parsed,
  });
}

export function sha256ForJsonValue(value: unknown): string {
  return sha256HexString(JSON.stringify(value, null, 2));
}
