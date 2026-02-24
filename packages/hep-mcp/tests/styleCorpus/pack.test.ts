import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { strToU8, unzipSync, zipSync } from 'fflate';

import { defaultRmpProfile } from '../../src/corpora/profiles/rmp.js';
import { exportStyleCorpusPackToZip, importStyleCorpusPackFromZip } from '../../src/corpora/style/pack.js';
import { writeStyleProfile, writeCorpusManifest } from '../../src/corpora/style/storage.js';

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('StyleCorpus pack export/import (R6)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-style-pack-'));
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

  it('exports a pack zip with pack_manifest.json and can import it', async () => {
    writeStyleProfile(defaultRmpProfile());
    writeCorpusManifest('rmp', [
      { version: 1, style_id: 'rmp', recid: '1', title: 'Test', status: 'planned' },
    ] as any);

    const zipPath = path.join(os.tmpdir(), `hep-style-pack-${Date.now()}.zip`);
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });

    const exported = await exportStyleCorpusPackToZip({
      style_id: 'rmp',
      zip_path: zipPath,
      include_sources: false,
      include_pdf: false,
      include_evidence: false,
      include_index: false,
      include_artifacts: false,
      compression_level: 6,
    });

    expect(fs.existsSync(zipPath)).toBe(true);
    expect(exported.manifest.style_id).toBe('rmp');
    expect(exported.manifest.files.map(f => f.path).sort()).toEqual([
      'corpora/rmp/manifest.jsonl',
      'corpora/rmp/profile.json',
    ]);

    const zipBytes = fs.readFileSync(zipPath);
    const unpacked = unzipSync(new Uint8Array(zipBytes));
    expect(unpacked['pack_manifest.json']).toBeTruthy();

    // Import into a clean data dir
    const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-style-pack-import-'));
    const prev = process.env.HEP_DATA_DIR;
    process.env.HEP_DATA_DIR = dataDir2;
    try {
      const imported = await importStyleCorpusPackFromZip({ zip_path: zipPath, overwrite: false });
      expect(imported.style_id).toBe('rmp');
      expect(imported.imported_files).toBe(2);
      expect(fs.existsSync(path.join(dataDir2, 'corpora', 'rmp', 'profile.json'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir2, 'corpora', 'rmp', 'manifest.jsonl'))).toBe(true);
    } finally {
      process.env.HEP_DATA_DIR = prev;
      fs.rmSync(dataDir2, { recursive: true, force: true });
      fs.rmSync(zipPath, { force: true });
    }
  });

  it('rejects corrupted packs (sha mismatch)', async () => {
    const profileBytes = strToU8(JSON.stringify({ ok: true }) + '\n');
    const wrongSha = '0'.repeat(64);

    const badManifest = {
      version: 1,
      kind: 'style_corpus_pack',
      style_id: 'rmp',
      exported_at: new Date().toISOString(),
      includes: { sources: false, pdf: false, evidence: false, index: false, artifacts: false },
      files: [
        {
          path: 'corpora/rmp/profile.json',
          sha256: wrongSha,
          size_bytes: profileBytes.length,
          mimeType: 'application/json',
        },
      ],
    };

    const zipBytes = zipSync({
      'pack_manifest.json': strToU8(JSON.stringify(badManifest) + '\n'),
      'corpora/rmp/profile.json': profileBytes,
    });

    const zipPath = path.join(os.tmpdir(), `hep-style-pack-bad-${Date.now()}.zip`);
    fs.writeFileSync(zipPath, Buffer.from(zipBytes));

    await expect(importStyleCorpusPackFromZip({ zip_path: zipPath, overwrite: false }))
      .rejects
      .toThrow(/hash mismatch/i);

    fs.rmSync(zipPath, { force: true });
  });

  it('accepts correct sha256 in pack_manifest.json', async () => {
    const profileBytes = strToU8(JSON.stringify({ ok: true }) + '\n');
    const manifest = {
      version: 1,
      kind: 'style_corpus_pack',
      style_id: 'rmp',
      exported_at: new Date().toISOString(),
      includes: { sources: false, pdf: false, evidence: false, index: false, artifacts: false },
      files: [
        {
          path: 'corpora/rmp/profile.json',
          sha256: sha256Hex(profileBytes),
          size_bytes: profileBytes.length,
          mimeType: 'application/json',
        },
      ],
    };

    const zipBytes = zipSync({
      'pack_manifest.json': strToU8(JSON.stringify(manifest) + '\n'),
      'corpora/rmp/profile.json': profileBytes,
    });

    const zipPath = path.join(os.tmpdir(), `hep-style-pack-ok-${Date.now()}.zip`);
    fs.writeFileSync(zipPath, Buffer.from(zipBytes));

    const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-style-pack-import-'));
    const prev = process.env.HEP_DATA_DIR;
    process.env.HEP_DATA_DIR = dataDir2;
    try {
      const imported = await importStyleCorpusPackFromZip({ zip_path: zipPath, overwrite: false });
      expect(imported.imported_files).toBe(1);
      expect(fs.existsSync(path.join(dataDir2, 'corpora', 'rmp', 'profile.json'))).toBe(true);
    } finally {
      process.env.HEP_DATA_DIR = prev;
      fs.rmSync(dataDir2, { recursive: true, force: true });
      fs.rmSync(zipPath, { force: true });
    }
  });
});
