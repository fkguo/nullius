import { describe, it, expect, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readPdgResource } from '../src/resources.js';

const ORIGINAL_PDG_DATA_DIR = process.env.PDG_DATA_DIR;

afterEach(() => {
  if (ORIGINAL_PDG_DATA_DIR === undefined) delete process.env.PDG_DATA_DIR;
  else process.env.PDG_DATA_DIR = ORIGINAL_PDG_DATA_DIR;
});

describe('PDG resources', () => {
  it('returns metadata JSON for binary artifacts (no base64 blob)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-resources-'));
    process.env.PDG_DATA_DIR = dataDir;

    const artifactsDir = path.join(dataDir, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });

    const name = 'test.pdf';
    const filePath = path.join(artifactsDir, name);
    const buf = Buffer.from('%PDF-1.4\nhello\n', 'utf-8');
    fs.writeFileSync(filePath, buf);

    const res = readPdgResource(`pdg://artifacts/${encodeURIComponent(name)}`) as any;
    expect(res.blob).toBeUndefined();
    expect(typeof res.text).toBe('string');

    const meta = JSON.parse(res.text) as any;
    expect(meta.file_path).toBe(filePath);
    expect(meta.size_bytes).toBe(buf.length);
    expect(meta.sha256).toBe(crypto.createHash('sha256').update(buf).digest('hex'));
    expect(meta.mimeType).toBe('application/pdf');
  });
});

