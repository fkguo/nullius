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
const ORIGINAL_PDG_DATA_DIR = process.env.PDG_DATA_DIR;

afterEach(() => {
  if (ORIGINAL_PDG_DB_PATH === undefined) delete process.env.PDG_DB_PATH;
  else process.env.PDG_DB_PATH = ORIGINAL_PDG_DB_PATH;

  if (ORIGINAL_PDG_DATA_DIR === undefined) delete process.env.PDG_DATA_DIR;
  else process.env.PDG_DATA_DIR = ORIGINAL_PDG_DATA_DIR;
});

function makeBatchFixtureDb(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-batch-db-'));
  const dbPath = path.join(tmpDir, 'pdg.sqlite');

  runSqlite(
    dbPath,
    [
      `CREATE TABLE pdginfo(id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, value VARCHAR);`,
      `CREATE TABLE pdgdoc(
        id INTEGER PRIMARY KEY,
        table_name VARCHAR NOT NULL,
        column_name VARCHAR NOT NULL,
        value VARCHAR,
        indicator VARCHAR NOT NULL,
        description VARCHAR NOT NULL,
        comment VARCHAR
      );`,
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
      `CREATE TABLE pdgdata(
        id INTEGER PRIMARY KEY,
        pdgid_id INTEGER NOT NULL,
        pdgid VARCHAR NOT NULL,
        edition VARCHAR,
        value_type VARCHAR(2) NOT NULL,
        in_summary_table BOOLEAN NOT NULL,
        confidence_level FLOAT,
        limit_type VARCHAR(1),
        comment VARCHAR,
        value FLOAT,
        value_text VARCHAR,
        error_positive FLOAT,
        error_negative FLOAT,
        scale_factor FLOAT,
        unit_text VARCHAR NOT NULL,
        display_value_text VARCHAR NOT NULL,
        display_power_of_ten INTEGER NOT NULL,
        display_in_percent BOOLEAN NOT NULL,
        sort INTEGER
      );`,
      `CREATE TABLE pdgdecay(
        id INTEGER PRIMARY KEY,
        pdgid_id INTEGER NOT NULL,
        pdgid VARCHAR NOT NULL,
        pdgitem_id INTEGER NOT NULL,
        name VARCHAR NOT NULL,
        is_outgoing BOOLEAN NOT NULL,
        multiplier INTEGER NOT NULL,
        subdecay_id INTEGER,
        sort INTEGER NOT NULL
      );`,

      "INSERT INTO pdginfo(id,name,value) VALUES (1,'edition','2025');",
      "INSERT INTO pdgdoc(id,table_name,column_name,value,indicator,description,comment) VALUES (1,'PDGDATA','VALUE_TYPE','V','1','evaluated from related quantities',NULL);",

      // Base particle W + mass PDGID
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (54,'S043',NULL,NULL,'W',NULL,'PART','G',NULL,7);",
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (56,'S043M',NULL,'S043','W MASS',NULL,'M','D',NULL,8);",

      // Decay mode PDGID under W
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (1306,'S043.1',NULL,'S043','W+ --> e+ nu',NULL,'BFX','',NULL,100);",

      // Items + mapping for W
      "INSERT INTO pdgitem(id,name,item_type) VALUES (4,'W','G');",
      "INSERT INTO pdgitem(id,name,item_type) VALUES (5,'W+','P');",
      "INSERT INTO pdgitem(id,name,item_type) VALUES (6,'W-','P');",
      "INSERT INTO pdgitem_map(id,pdgitem_id,name,target_id,sort) VALUES (1,4,'W',5,0);",
      "INSERT INTO pdgitem_map(id,pdgitem_id,name,target_id,sort) VALUES (2,4,'W',6,1);",
      "INSERT INTO pdgparticle(id,pdgid_id,pdgid,pdgitem_id,name,cc_type,mcid,charge) VALUES (4,54,'S043',5,'W+','P',24,1.0);",
      "INSERT INTO pdgparticle(id,pdgid_id,pdgid,pdgitem_id,name,cc_type,mcid,charge) VALUES (5,54,'S043',6,'W-','A',-24,-1.0);",

      // pdgdata for mass + branching fraction for decay entry
      "INSERT INTO pdgdata(id,pdgid_id,pdgid,edition,value_type,in_summary_table,limit_type,value,error_positive,error_negative,unit_text,display_value_text,display_power_of_ten,display_in_percent) VALUES (314013,56,'S043M','2025','V',1,NULL,80.377,0.012,0.012,'GeV','80.3692+-0.0133',0,0);",
      "INSERT INTO pdgdata(id,pdgid_id,pdgid,edition,value_type,in_summary_table,limit_type,value,error_positive,error_negative,unit_text,display_value_text,display_power_of_ten,display_in_percent) VALUES (314051,1306,'S043.1','2025','D',1,NULL,0.1071,0.0016,0.0016,'','10.71+-0.16',-2,1);",

      // pdgdecay parts for S043.1
      "INSERT INTO pdgdecay(id,pdgid_id,pdgid,pdgitem_id,name,is_outgoing,multiplier,subdecay_id,sort) VALUES (1,1306,'S043.1',5,'W+',0,1,NULL,1);",
      "INSERT INTO pdgdecay(id,pdgid_id,pdgid,pdgitem_id,name,is_outgoing,multiplier,subdecay_id,sort) VALUES (2,1306,'S043.1',0,'e+',1,1,NULL,2);",
      "INSERT INTO pdgdecay(id,pdgid_id,pdgid,pdgitem_id,name,is_outgoing,multiplier,subdecay_id,sort) VALUES (3,1306,'S043.1',0,'nu',1,1,NULL,3);",
    ].join(' ')
  );

  return dbPath;
}

describe('pdg_batch', () => {
  it('runs multiple calls and writes a JSON artifact with per-call results', async () => {
    const dbPath = makeBatchFixtureDb();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-batch-data-'));
    process.env.PDG_DB_PATH = dbPath;
    process.env.PDG_DATA_DIR = dataDir;

    const res = await handleToolCall(
      'pdg_batch',
      {
        calls: [
          { tool: 'pdg_find_particle', arguments: { name: 'W' } },
          { tool: 'pdg_get_property', arguments: { particle: { name: 'W' }, property: 'mass' } },
          { tool: 'pdg_get_decays', arguments: { particle: { name: 'W' }, limit: 2, start: 0, artifact_name: 'w_decays.jsonl' } },
          { tool: 'pdg_get_property', arguments: {} }, // invalid subcall; should be captured
        ],
        concurrency: 4,
        artifact_name: 'batch.json',
      },
      'full'
    );

    expect(res.isError).not.toBe(true);
    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.uri).toBe('pdg://artifacts/batch.json');
    expect(payload.summary?.calls).toBe(4);
    expect(payload.summary?.ok).toBe(3);
    expect(payload.summary?.errors).toBe(1);

    const artifactPath = path.join(dataDir, 'artifacts', 'batch.json');
    expect(fs.existsSync(artifactPath)).toBe(true);

    const detail = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as any;
    expect(detail.calls?.length).toBe(4);
    const mass = detail.calls.find((c: any) => c.tool === 'pdg_get_property' && c.ok === true)?.result;
    expect(mass?.property?.key).toBe('mass');

    const bad = detail.calls.find((c: any) => c.tool === 'pdg_get_property' && c.ok === false);
    expect(bad?.error?.code).toBe('INVALID_PARAMS');

    const decays = detail.calls.find((c: any) => c.tool === 'pdg_get_decays')?.result;
    expect(decays?.uri).toBe('pdg://artifacts/w_decays.jsonl');
  });
});
