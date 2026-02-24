import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { StyleProfileSchema } from '../../src/corpora/style/schemas.js';
import { assertSafeStyleId } from '../../src/corpora/style/paths.js';
import {
  readStyleProfile,
  writeStyleProfile,
  readCorpusManifest,
  writeCorpusManifest,
  upsertCorpusManifestEntries,
} from '../../src/corpora/style/storage.js';
import { getCorpusManifestPath, getCorpusProfilePath } from '../../src/corpora/style/paths.js';

describe('StyleCorpus schemas + storage (R0)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-style-corpus-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects unsafe style_id segments', () => {
    expect(() => assertSafeStyleId('')).toThrow();
    expect(() => assertSafeStyleId('..')).toThrow();
    expect(() => assertSafeStyleId('../rmp')).toThrow();
    expect(() => assertSafeStyleId('rmp/evil')).toThrow();
    expect(() => assertSafeStyleId('rmp\\evil')).toThrow();
  });

  it('writes/reads profile deterministically', () => {
    const profile = StyleProfileSchema.parse({
      version: 1,
      style_id: 'rmp',
      title: 'Rev. Mod. Phys.',
      inspire_query: 'j:Rev.Mod.Phys.',
      selection: {
        strategy: 'stratified_v1',
        target_categories: ['hep-ph'],
        year_bins: [{ id: '2010s', start_year: 2010, end_year: 2019 }],
      },
      defaults: {},
    });

    writeStyleProfile(profile);
    const loaded = readStyleProfile('rmp');
    expect(loaded).toEqual(profile);

    const p = getCorpusProfilePath('rmp');
    const first = fs.readFileSync(p, 'utf-8');
    writeStyleProfile(profile);
    const second = fs.readFileSync(p, 'utf-8');
    expect(second).toEqual(first);
  });

  it('writes/reads manifest deterministically (sorted by recid)', () => {
    writeCorpusManifest('rmp', [
      {
        version: 1,
        style_id: 'rmp',
        recid: '20',
        title: 'B',
        status: 'planned',
      },
      {
        version: 1,
        style_id: 'rmp',
        recid: '3',
        title: 'A',
        status: 'planned',
      },
    ]);

    const loaded = readCorpusManifest('rmp');
    expect(loaded.map(e => e.recid)).toEqual(['3', '20']);

    const manifestPath = getCorpusManifestPath('rmp');
    const first = fs.readFileSync(manifestPath, 'utf-8');
    writeCorpusManifest('rmp', loaded);
    const second = fs.readFileSync(manifestPath, 'utf-8');
    expect(second).toEqual(first);
  });

  it('upserts manifest entries by recid', () => {
    writeCorpusManifest('rmp', [
      {
        version: 1,
        style_id: 'rmp',
        recid: '3',
        title: 'A',
        status: 'planned',
      },
    ]);

    upsertCorpusManifestEntries('rmp', [
      {
        version: 1,
        style_id: 'rmp',
        recid: '3',
        title: 'A (updated)',
        status: 'downloaded',
      },
      {
        version: 1,
        style_id: 'rmp',
        recid: '4',
        title: 'B',
        status: 'planned',
      },
    ]);

    const loaded = readCorpusManifest('rmp');
    expect(loaded.map(e => `${e.recid}:${e.status}:${e.title}`)).toEqual([
      '3:downloaded:A (updated)',
      '4:planned:B',
    ]);
  });
});
