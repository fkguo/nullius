import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { handleToolCall } from '../src/tools/index.js';

function runSqlite(dbPath: string, sql: string): void {
  const res = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf-8' });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(res.stderr?.trim() || 'sqlite3 failed');
  }
}

const ORIGINAL_PDG_DB_PATH = process.env.PDG_DB_PATH;

afterEach(() => {
  if (ORIGINAL_PDG_DB_PATH === undefined) {
    delete process.env.PDG_DB_PATH;
  } else {
    process.env.PDG_DB_PATH = ORIGINAL_PDG_DB_PATH;
  }
});

describe('PDG references tools (R1/R2)', () => {
  function makeDb(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-ref-test-'));
    const dbPath = path.join(tmpDir, 'pdg.sqlite');

    runSqlite(
      dbPath,
      [
        'CREATE TABLE pdgreference(',
        '  id INTEGER PRIMARY KEY,',
        '  document_id VARCHAR NOT NULL,',
        '  publication_name VARCHAR,',
        '  publication_year INTEGER,',
        '  doi VARCHAR(240),',
        '  inspire_id VARCHAR(16),',
        '  title VARCHAR',
        ');',
        "INSERT INTO pdgreference(id,document_id,publication_name,publication_year,doi,inspire_id,title) VALUES (1,'GINTSBURG 1964 ','Phys.Rev.',1964,'','42302','Structure of the Equations of Cosmic Electrodynamics');",
        "INSERT INTO pdgreference(id,document_id,publication_name,publication_year,doi,inspire_id,title) VALUES (2,'PATEL 1965 ','Phys.Lett.',1965,'10.1016/0031-9163(65)90438-5','48875','Structure of the Equations of Cosmic Electrodynamics and the Photon Rest Mass');",
        "INSERT INTO pdgreference(id,document_id,publication_name,publication_year,doi,inspire_id,title) VALUES (3,'TEST 1970','JHEP',1970,NULL,NULL,'A Study of Something');",
      ].join(' ')
    );

    return dbPath;
  }

  it('pdg_find_reference finds by DOI (exact) and emits inspire lookup ids', async () => {
    process.env.PDG_DB_PATH = makeDb();

    const res = await handleToolCall(
      'pdg_find_reference',
      {
        doi: '10.1016/0031-9163(65)90438-5',
        match: 'exact',
      },
      'standard'
    );
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.references).toHaveLength(1);
    expect(payload.references[0].id).toBe(2);
    expect(payload.references[0].doi).toBe('10.1016/0031-9163(65)90438-5');
    expect(payload.references[0].inspire_lookup_by_id).toEqual(['10.1016/0031-9163(65)90438-5', '48875']);
  });

  it('pdg_find_reference supports pagination (has_more)', async () => {
    process.env.PDG_DB_PATH = makeDb();

    const res = await handleToolCall(
      'pdg_find_reference',
      {
        title: 'Structure',
        match: 'contains',
        start: 0,
        limit: 1,
      },
      'standard'
    );
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.references).toHaveLength(1);
    expect(payload.has_more).toBe(true);
  });

  it('pdg_get_reference fetches by id', async () => {
    process.env.PDG_DB_PATH = makeDb();

    const res = await handleToolCall('pdg_get_reference', { id: 2 }, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.reference.id).toBe(2);
    expect(payload.reference.document_id).toBe('PATEL 1965');
    expect(payload.reference.inspire_lookup_by_id).toEqual(['10.1016/0031-9163(65)90438-5', '48875']);
    expect(payload.pdg_locator).toEqual({ table: 'pdgreference', pdgreference_id: 2 });
  });

  it('pdg_get_reference fetches by document_id (trim-insensitive)', async () => {
    process.env.PDG_DB_PATH = makeDb();

    const res = await handleToolCall('pdg_get_reference', { document_id: 'GINTSBURG 1964' }, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.reference.id).toBe(1);
    expect(payload.reference.document_id).toBe('GINTSBURG 1964');
    expect(payload.reference.doi).toBe(null);
    expect(payload.reference.inspire_lookup_by_id).toEqual(['42302']);
  });
});

