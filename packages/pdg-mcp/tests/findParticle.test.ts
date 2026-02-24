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

function makeParticleFixtureDb(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-find-particle-'));
  const dbPath = path.join(tmpDir, 'pdg.sqlite');

  runSqlite(
    dbPath,
    [
      // Minimal tables for pdg_find_particle
      `CREATE TABLE pdgid(
        id INTEGER PRIMARY KEY,
        pdgid VARCHAR NOT NULL,
        parent_id INTEGER,
        parent_pdgid VARCHAR,
        description VARCHAR NOT NULL,
        mode_number INTEGER,
        data_type VARCHAR(4) NOT NULL,
        flags VARCHAR(8) NOT NULL,
        year_added INTEGER,
        sort INTEGER NOT NULL
      );`,
      `CREATE TABLE pdgitem(
        id INTEGER PRIMARY KEY,
        name VARCHAR NOT NULL,
        item_type VARCHAR(1) NOT NULL
      );`,
      `CREATE TABLE pdgitem_map(
        id INTEGER PRIMARY KEY,
        pdgitem_id INTEGER NOT NULL,
        name VARCHAR NOT NULL,
        target_id INTEGER NOT NULL,
        sort INTEGER NOT NULL
      );`,
      `CREATE TABLE pdgparticle(
        id INTEGER PRIMARY KEY,
        pdgid_id INTEGER NOT NULL,
        pdgid VARCHAR NOT NULL,
        pdgitem_id INTEGER NOT NULL,
        name VARCHAR NOT NULL,
        cc_type VARCHAR(1),
        mcid INTEGER,
        charge FLOAT,
        quantum_i VARCHAR(40),
        quantum_g VARCHAR(1),
        quantum_j VARCHAR(40),
        quantum_p VARCHAR(1),
        quantum_c VARCHAR(1)
      );`,

      // PDG IDs
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (54,'S043',NULL,NULL,'W',NULL,'PART','G',NULL,7);",
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (56,'S043M',NULL,'S043','W MASS',NULL,'M','D',NULL,8);",
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (100,'S009',NULL,NULL,'pi0',NULL,'PART','G',NULL,10);",

      // Items
      "INSERT INTO pdgitem(id,name,item_type) VALUES (4,'W','G');",
      "INSERT INTO pdgitem(id,name,item_type) VALUES (5,'W+','P');",
      "INSERT INTO pdgitem(id,name,item_type) VALUES (6,'W-','P');",
      "INSERT INTO pdgitem(id,name,item_type) VALUES (10,'pi0','P');",

      // Mapping W -> W+, W-
      "INSERT INTO pdgitem_map(id,pdgitem_id,name,target_id,sort) VALUES (1,4,'W',5,0);",
      "INSERT INTO pdgitem_map(id,pdgitem_id,name,target_id,sort) VALUES (2,4,'W',6,1);",

      // Particles (share same pdgid_id)
      "INSERT INTO pdgparticle(id,pdgid_id,pdgid,pdgitem_id,name,cc_type,mcid,charge) VALUES (4,54,'S043',5,'W+','P',24,1.0);",
      "INSERT INTO pdgparticle(id,pdgid_id,pdgid,pdgitem_id,name,cc_type,mcid,charge) VALUES (5,54,'S043',6,'W-','A',-24,-1.0);",
      "INSERT INTO pdgparticle(id,pdgid_id,pdgid,pdgitem_id,name,cc_type,mcid,charge) VALUES (10,100,'S009',10,'pi0','S',111,0.0);",
    ].join(' ')
  );

  return dbPath;
}

describe('pdg_find_particle (M2)', () => {
  it('finds mapped charged particles from a generic name', async () => {
    const dbPath = makeParticleFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall('pdg_find_particle', { name: 'W' }, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.candidates?.map((c: any) => c.name).sort()).toEqual(['W+', 'W-']);
  });

  it('supports pagination', async () => {
    const dbPath = makeParticleFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall('pdg_find_particle', { name: 'W', limit: 1, start: 0 }, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.candidates?.length).toBe(1);
    expect(payload.has_more).toBe(true);
  });

  it('finds by mcid', async () => {
    const dbPath = makeParticleFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall('pdg_find_particle', { mcid: 24 }, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.candidates?.length).toBe(1);
    expect(payload.candidates?.[0]?.name).toBe('W+');
  });

  it('accepts pdg_code alias for mcid (including integer strings)', async () => {
    const dbPath = makeParticleFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall('pdg_find_particle', { pdg_code: '24' }, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.candidates?.length).toBe(1);
    expect(payload.candidates?.[0]?.name).toBe('W+');
  });

  it('normalizes non-particle pdgid via parent_pdgid when possible', async () => {
    const dbPath = makeParticleFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall('pdg_find_particle', { pdgid: 'S043M' }, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.normalized?.pdgid).toBe('S043');
    expect(payload.candidates?.map((c: any) => c.name).sort()).toEqual(['W+', 'W-']);
  });

  it('supports unicode aliases like π0', async () => {
    const dbPath = makeParticleFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall('pdg_find_particle', { name: 'π0' }, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.query?.normalized_name).toBe('pi0');
    expect(payload.candidates?.length).toBe(1);
    expect(payload.candidates?.[0]?.name).toBe('pi0');
    expect(payload.candidates?.[0]?.pdgid).toBe('S009');
  });
});
