import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../../../core/atomicWrite.js';
import { getCacheDir } from '../../../data/dataDir.js';
import type { DiscoverySearchLogEntry } from '@autoresearch/shared';
import { DiscoverySearchLogEntrySchema } from '@autoresearch/shared';

export type DiscoveryArtifactRef = { artifact_name: string; file_path: string };

export type DiscoveryArtifactRefs = {
  query_plan: DiscoveryArtifactRef;
  reformulation: DiscoveryArtifactRef;
  candidate_generation: DiscoveryArtifactRef;
  canonical_papers: DiscoveryArtifactRef;
  dedup: DiscoveryArtifactRef;
  rerank: DiscoveryArtifactRef;
  search_log: DiscoveryArtifactRef;
};

function padIndex(requestIndex: number): string {
  return String(requestIndex).padStart(3, '0');
}

export function discoveryDir(): string {
  return path.join(getCacheDir(), 'discovery');
}

export function searchLogPath(dir: string): string {
  return path.join(dir, 'discovery_search_log_v1.jsonl');
}

export function readSearchLogEntries(filePath: string): DiscoverySearchLogEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => DiscoverySearchLogEntrySchema.parse(JSON.parse(line) as unknown));
}

export function writeJsonArtifact(filePath: string, value: unknown): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeSearchLog(filePath: string, entries: DiscoverySearchLogEntry[]): void {
  const payload = `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`;
  atomicWriteFileSync(filePath, payload);
}

export function artifactRefs(dir: string, requestIndex: number): DiscoveryArtifactRefs {
  const suffix = padIndex(requestIndex);
  return {
    query_plan: {
      artifact_name: `discovery_query_plan_${suffix}_v1.json`,
      file_path: path.join(dir, `discovery_query_plan_${suffix}_v1.json`),
    },
    reformulation: {
      artifact_name: `discovery_query_reformulation_${suffix}_v1.json`,
      file_path: path.join(dir, `discovery_query_reformulation_${suffix}_v1.json`),
    },
    candidate_generation: {
      artifact_name: `discovery_candidate_generation_${suffix}_v1.json`,
      file_path: path.join(dir, `discovery_candidate_generation_${suffix}_v1.json`),
    },
    canonical_papers: {
      artifact_name: `discovery_canonical_papers_${suffix}_v1.json`,
      file_path: path.join(dir, `discovery_canonical_papers_${suffix}_v1.json`),
    },
    dedup: {
      artifact_name: `discovery_dedup_${suffix}_v1.json`,
      file_path: path.join(dir, `discovery_dedup_${suffix}_v1.json`),
    },
    rerank: {
      artifact_name: `discovery_rerank_${suffix}_v1.json`,
      file_path: path.join(dir, `discovery_rerank_${suffix}_v1.json`),
    },
    search_log: {
      artifact_name: 'discovery_search_log_v1.jsonl',
      file_path: searchLogPath(dir),
    },
  };
}
