import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HEP_DISCOVERY_TTL_HOURS_ENV,
  cleanupOldDiscoveryArtifacts,
} from '../../src/tools/research/discovery/ttlCleanup.js';

const ENV_VARS_TO_RESET = ['HEP_DATA_DIR', HEP_DISCOVERY_TTL_HOURS_ENV] as const;

describe('cleanupOldDiscoveryArtifacts', () => {
  let tmpDataRoot: string;
  let discoveryDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_VARS_TO_RESET) originalEnv[k] = process.env[k];
    tmpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-discovery-ttl-'));
    process.env.HEP_DATA_DIR = tmpDataRoot;
    discoveryDir = path.join(tmpDataRoot, 'cache', 'discovery');
    fs.mkdirSync(discoveryDir, { recursive: true });
  });

  afterEach(() => {
    for (const k of ENV_VARS_TO_RESET) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    fs.rmSync(tmpDataRoot, { recursive: true, force: true });
  });

  function writeArtifact(name: string, ageHours = 0): string {
    const p = path.join(discoveryDir, name);
    fs.writeFileSync(p, '{}');
    if (ageHours > 0) {
      const past = (Date.now() - ageHours * 3600 * 1000) / 1000;
      fs.utimesSync(p, past, past);
    }
    return p;
  }

  it('deletes per-request artifacts older than the default 24h TTL', () => {
    const old = writeArtifact('discovery_query_plan_001_v1.json', 48);
    const fresh = writeArtifact('discovery_query_plan_002_v1.json', 1);
    const result = cleanupOldDiscoveryArtifacts();
    expect(result.deleted_files).toBe(1);
    expect(result.scanned_files).toBe(2);
    expect(result.ttl_source).toBe('default');
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('preserves the append-only search log even when older than TTL', () => {
    const logPath = writeArtifact('discovery_search_log_v1.jsonl', 100);
    const oldArtifact = writeArtifact('discovery_rerank_005_v1.json', 100);
    const result = cleanupOldDiscoveryArtifacts();
    expect(result.preserved_search_log).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(oldArtifact)).toBe(false);
    expect(result.deleted_files).toBe(1);
  });

  it('honors the HEP_DISCOVERY_TTL_HOURS env override', () => {
    process.env[HEP_DISCOVERY_TTL_HOURS_ENV] = '1';
    const old = writeArtifact('discovery_dedup_010_v1.json', 2);
    const fresh = writeArtifact('discovery_dedup_011_v1.json', 0.25);
    const result = cleanupOldDiscoveryArtifacts();
    expect(result.ttl_source).toBe('env');
    expect(result.ttl_hours).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('disables cleanup when the env var is 0/off/disabled', () => {
    for (const flag of ['0', 'off', 'disabled', 'FALSE']) {
      process.env[HEP_DISCOVERY_TTL_HOURS_ENV] = flag;
      const stale = writeArtifact(`discovery_canonical_papers_${flag}_v1.json`, 9999);
      const result = cleanupOldDiscoveryArtifacts();
      expect(result.ttl_hours).toBeNull();
      expect(result.ttl_source).toBe('disabled');
      expect(fs.existsSync(stale)).toBe(true);
      fs.rmSync(stale);
    }
  });

  it('treats invalid env values as disabled (no accidental deletion)', () => {
    process.env[HEP_DISCOVERY_TTL_HOURS_ENV] = 'forever';
    const stale = writeArtifact('discovery_query_reformulation_999_v1.json', 9999);
    const result = cleanupOldDiscoveryArtifacts();
    expect(result.ttl_hours).toBeNull();
    expect(result.ttl_source).toBe('invalid');
    expect(fs.existsSync(stale)).toBe(true);
  });

  it('ignores files that do not match the per-request artifact name pattern', () => {
    // Foreign noise dropped by an unrelated process must not be deleted.
    const foreign = writeArtifact('README.md', 9999);
    const looksClose = writeArtifact('discovery_something_else.json', 9999);
    const result = cleanupOldDiscoveryArtifacts();
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(looksClose)).toBe(true);
    expect(result.scanned_files).toBe(0);
  });

  it('is a no-op when the discovery dir does not exist', () => {
    fs.rmSync(discoveryDir, { recursive: true, force: true });
    const result = cleanupOldDiscoveryArtifacts();
    expect(result.deleted_files).toBe(0);
    expect(result.scanned_files).toBe(0);
  });

  it('deletes all 6 per-request step types in one sweep', () => {
    const steps = [
      'query_plan',
      'query_reformulation',
      'candidate_generation',
      'canonical_papers',
      'dedup',
      'rerank',
    ];
    for (const s of steps) writeArtifact(`discovery_${s}_042_v1.json`, 48);
    const result = cleanupOldDiscoveryArtifacts();
    expect(result.deleted_files).toBe(steps.length);
    expect(result.scanned_files).toBe(steps.length);
  });
});
