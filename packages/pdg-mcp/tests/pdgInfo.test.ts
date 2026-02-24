import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { McpError } from '@autoresearch/shared';

import { getPdgDbPathFromEnv } from '../src/db/pdgDb.js';
import { readPdgInfoMap } from '../src/db/pdgInfo.js';
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

describe('PDG_DB_PATH env validation (M1)', () => {
  it('returns undefined when not set', () => {
    delete process.env.PDG_DB_PATH;
    expect(getPdgDbPathFromEnv()).toBeUndefined();
  });

  it('rejects relative paths', () => {
    process.env.PDG_DB_PATH = 'relative.sqlite';
    expect(() => getPdgDbPathFromEnv()).toThrowError(McpError);
  });

  it('rejects non-existent files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-dbpath-missing-'));
    const missing = path.join(tmpDir, 'missing.sqlite');
    process.env.PDG_DB_PATH = missing;
    expect(() => getPdgDbPathFromEnv()).toThrowError(McpError);
  });

  it('rejects directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-dbpath-dir-'));
    process.env.PDG_DB_PATH = tmpDir;
    expect(() => getPdgDbPathFromEnv()).toThrowError(McpError);
  });

  it('accepts absolute file paths', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-dbpath-ok-'));
    const filePath = path.join(tmpDir, 'ok.sqlite');
    fs.writeFileSync(filePath, '');
    process.env.PDG_DB_PATH = filePath;
    expect(getPdgDbPathFromEnv()).toBe(filePath);
  });
});

describe('pdginfo reading (M1)', () => {
  it('reads pdginfo from sqlite', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-info-test-'));
    const dbPath = path.join(tmpDir, 'pdg.sqlite');

    runSqlite(
      dbPath,
      [
        'CREATE TABLE pdginfo(id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, value VARCHAR);',
        "INSERT INTO pdginfo(id,name,value) VALUES (1,'producer','Particle Data Group (PDG)');",
        "INSERT INTO pdginfo(id,name,value) VALUES (2,'edition','2025');",
        "INSERT INTO pdginfo(id,name,value) VALUES (3,'license','CC BY 4.0');",
        "INSERT INTO pdginfo(id,name,value) VALUES (4,'data_release','123.45');",
        "INSERT INTO pdginfo(id,name,value) VALUES (5,'data_release_timestamp','2025-11-26 19:33:17 PST');",
        "INSERT INTO pdginfo(id,name,value) VALUES (6,'citation','Test Citation');",
      ].join(' ')
    );

    const info = await readPdgInfoMap(dbPath);
    expect(info.producer).toBe('Particle Data Group (PDG)');
    expect(info.edition).toBe('2025');
    expect(info.license).toBe('CC BY 4.0');
    expect(info.data_release).toBe('123.45');
  });

  it('pdg_info returns db metadata when configured', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-tool-info-'));
    const dbPath = path.join(tmpDir, 'pdg.sqlite');

    runSqlite(
      dbPath,
      [
        'CREATE TABLE pdginfo(id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, value VARCHAR);',
        "INSERT INTO pdginfo(id,name,value) VALUES (1,'edition','2025');",
        "INSERT INTO pdginfo(id,name,value) VALUES (2,'license','CC BY 4.0');",
        "INSERT INTO pdginfo(id,name,value) VALUES (3,'data_release','123.45');",
      ].join(' ')
    );

    process.env.PDG_DB_PATH = dbPath;
    const res = await handleToolCall('pdg_info', {}, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.db?.configured).toBe(true);
    expect(payload.db?.edition).toBe('2025');
    expect(payload.db?.license).toBe('CC BY 4.0');
    expect(payload.db?.data_release).toBe(123.45);
    expect(typeof payload.db?.file?.sha256).toBe('string');
  });

  it('pdg_info returns configured=false when PDG_DB_PATH missing', async () => {
    delete process.env.PDG_DB_PATH;
    const res = await handleToolCall('pdg_info', {}, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.db?.configured).toBe(false);
  });
});
