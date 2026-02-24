import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { cleanupDownloads } from '../../src/tools/research/cleanupDownloads.js';
import { getWritingProgressDir } from '../../src/data/dataDir.js';
import { writeDirectoryMarker } from '../../src/data/markers.js';
import { assertSafePathSegment } from '../../src/vnext/paths.js';

describe('Path safety + marker cleanup (M1)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects out-of-bounds output_dir with UNSAFE_FS', async () => {
    const result = await handleToolCall('inspire_paper_source', {
      identifier: 'arxiv:1234.56789',
      mode: 'urls',
      options: {
        output_dir: os.tmpdir(),
      },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as { error: { code: string; message?: string; data?: any } };
    expect(parsed.error.code).toBe('UNSAFE_FS');
    expect(parsed.error.message).toContain('HEP_DATA_DIR');
    expect(parsed.error.message).toContain('set HEP_DATA_DIR');
    expect(parsed.error.data?.hep_data_dir).toBe(dataDir);
  });

  it('rejects symlink escape within data dir (realpath guard)', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outside-'));
    try {
      const linkPath = path.join(dataDir, 'writing_progress');
      fs.symlinkSync(outsideDir, linkPath, 'dir');

      try {
        getWritingProgressDir();
        throw new Error('Expected UNSAFE_FS');
      } catch (err) {
        expect((err as { code?: unknown }).code).toBe('UNSAFE_FS');
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('cleanupDownloads only deletes marked directories', async () => {
    const downloadsDir = path.join(dataDir, 'downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });

    const marked = path.join(downloadsDir, 'arxiv-1111.11111');
    const unmarked = path.join(downloadsDir, 'arxiv-2222.22222');
    fs.mkdirSync(marked, { recursive: true });
    fs.mkdirSync(unmarked, { recursive: true });
    writeDirectoryMarker(marked, 'download_dir');

    const res = await cleanupDownloads({ dry_run: false });

    expect(fs.existsSync(marked)).toBe(false);
    expect(fs.existsSync(unmarked)).toBe(true);
    expect(res.deleted_count).toBe(1);
    expect(res.skipped_unmarked).toBe(1);
  });

  it('rejects null byte in path segments', () => {
    try {
      assertSafePathSegment('run\u0000id', 'run_id');
      throw new Error('Expected INVALID_PARAMS');
    } catch (err) {
      expect((err as any)?.code).toBe('INVALID_PARAMS');
    }
  });
});
