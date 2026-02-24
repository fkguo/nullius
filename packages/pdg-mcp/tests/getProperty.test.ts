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

function makePropertyFixtureDb(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-get-property-'));
  const dbPath = path.join(tmpDir, 'pdg.sqlite');

  runSqlite(
    dbPath,
    [
      // Minimal tables
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

      // Edition default
      "INSERT INTO pdginfo(id,name,value) VALUES (1,'edition','2025');",

      // pdgdoc decode (minimal)
      "INSERT INTO pdgdoc(id,table_name,column_name,value,indicator,description,comment) VALUES (1,'PDGDATA','VALUE_TYPE','V','1','evaluated from related quantities',NULL);",

      // Base particle: W (S043)
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (54,'S043',NULL,NULL,'W',NULL,'PART','G',NULL,7);",
      // Properties: mass/width
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (56,'S043M',NULL,'S043','W MASS',NULL,'M','D',NULL,8);",
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (1213,'S043W',NULL,'S043','W WIDTH',NULL,'G','D',NULL,9);",

      // Items and mapping: W -> W+, W-
      "INSERT INTO pdgitem(id,name,item_type) VALUES (4,'W','G');",
      "INSERT INTO pdgitem(id,name,item_type) VALUES (5,'W+','P');",
      "INSERT INTO pdgitem(id,name,item_type) VALUES (6,'W-','P');",
      "INSERT INTO pdgitem_map(id,pdgitem_id,name,target_id,sort) VALUES (1,4,'W',5,0);",
      "INSERT INTO pdgitem_map(id,pdgitem_id,name,target_id,sort) VALUES (2,4,'W',6,1);",
      "INSERT INTO pdgparticle(id,pdgid_id,pdgid,pdgitem_id,name,cc_type,mcid,charge) VALUES (4,54,'S043',5,'W+','P',24,1.0);",
      "INSERT INTO pdgparticle(id,pdgid_id,pdgid,pdgitem_id,name,cc_type,mcid,charge) VALUES (5,54,'S043',6,'W-','A',-24,-1.0);",

      // Another particle: pi+- (S008) with mean life
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (100,'S008',NULL,NULL,'pi+-',NULL,'PART','G',NULL,10);",
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (101,'S008T',NULL,'S008','pi+- MEAN LIFE',NULL,'T','D1',NULL,11);",
      "INSERT INTO pdgid(id,pdgid,parent_id,parent_pdgid,description,mode_number,data_type,flags,year_added,sort) VALUES (102,'S008M',NULL,'S008','pi+- MASS',NULL,'M','D1',NULL,12);",

      "INSERT INTO pdgitem(id,name,item_type) VALUES (36,'pi+-','B');",
      "INSERT INTO pdgitem(id,name,item_type) VALUES (37,'pi+','P');",
      "INSERT INTO pdgitem(id,name,item_type) VALUES (38,'pi-','P');",
      "INSERT INTO pdgitem_map(id,pdgitem_id,name,target_id,sort) VALUES (10,36,'pi+-',37,0);",
      "INSERT INTO pdgitem_map(id,pdgitem_id,name,target_id,sort) VALUES (11,36,'pi+-',38,1);",
      "INSERT INTO pdgparticle(id,pdgid_id,pdgid,pdgitem_id,name,cc_type,mcid,charge) VALUES (40,100,'S008',37,'pi+','P',211,1.0);",
      "INSERT INTO pdgparticle(id,pdgid_id,pdgid,pdgitem_id,name,cc_type,mcid,charge) VALUES (41,100,'S008',38,'pi-','A',-211,-1.0);",

      // pdgdata rows (W mass + width)
      "INSERT INTO pdgdata(id,pdgid_id,pdgid,edition,value_type,in_summary_table,limit_type,value,error_positive,error_negative,unit_text,display_value_text,display_power_of_ten,display_in_percent) VALUES (314013,56,'S043M','2025','V',1,NULL,80.377,0.012,0.012,'GeV','80.3692+-0.0133',0,0);",
      "INSERT INTO pdgdata(id,pdgid_id,pdgid,edition,value_type,in_summary_table,limit_type,value,error_positive,error_negative,unit_text,display_value_text,display_power_of_ten,display_in_percent) VALUES (314014,56,'S043M','2025','OM',0,NULL,80.4335,0.0094,0.0094,'GeV','80.4335+-0.0094',0,0);",
      "INSERT INTO pdgdata(id,pdgid_id,pdgid,edition,value_type,in_summary_table,limit_type,value,error_positive,error_negative,unit_text,display_value_text,display_power_of_ten,display_in_percent) VALUES (500001,1213,'S043W','2025','V',1,NULL,2.085,0.042,0.042,'GeV','2.085+-0.042',0,0);",

      // pi+- mean life + mass
      "INSERT INTO pdgdata(id,pdgid_id,pdgid,edition,value_type,in_summary_table,limit_type,value,error_positive,error_negative,unit_text,display_value_text,display_power_of_ten,display_in_percent) VALUES (600001,101,'S008T','2025','V',1,NULL,2.6033e-8,0.0005e-8,0.0005e-8,'s','2.6033+-0.0005',-8,0);",
      "INSERT INTO pdgdata(id,pdgid_id,pdgid,edition,value_type,in_summary_table,limit_type,value,error_positive,error_negative,unit_text,display_value_text,display_power_of_ten,display_in_percent) VALUES (600002,102,'S008M','2025','V',1,NULL,0.13957,0.00001,0.00001,'GeV','0.13957+-0.00001',0,0);",
    ].join(' ')
  );

  return dbPath;
}

describe('pdg_get_property (M3)', () => {
  it('returns mass with locator + display value', async () => {
    const dbPath = makePropertyFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall('pdg_get_property', { particle: { name: 'W' }, property: 'mass' }, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.property?.key).toBe('mass');
    expect(payload.property?.pdgid).toBe('S043M');
    expect(payload.edition).toBe('2025');
    expect(payload.value?.unit_text).toBe('GeV');
    expect(payload.value?.display_value_text).toContain('80');
    expect(payload.pdg_locator?.table).toBe('pdgdata');
    expect(typeof payload.pdg_locator?.pdgdata_id).toBe('number');
  });

  it('accepts particle.pdg_code alias (including integer strings)', async () => {
    const dbPath = makePropertyFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall('pdg_get_property', { particle: { pdg_code: '24' }, property: 'mass' }, 'standard');
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.particle?.pdgid).toBe('S043');
    expect(payload.property?.pdgid).toBe('S043M');
  });

  it('returns lifetime (mean life) for pi+-', async () => {
    const dbPath = makePropertyFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall(
      'pdg_get_property',
      { particle: { name: 'pi+-' }, property: 'lifetime' },
      'standard'
    );
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.property?.pdgid).toBe('S008T');
    expect(payload.value?.unit_text).toBe('s');
    expect(payload.value?.display_text).toContain('E-8');
  });

  it('does not derive width by default when missing', async () => {
    const dbPath = makePropertyFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall('pdg_get_property', { particle: { name: 'pi+-' }, property: 'width' }, 'standard');
    expect(res.isError).toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.error?.code).toBe('NOT_FOUND');
  });

  it('can derive width from lifetime when allow_derived=true', async () => {
    const dbPath = makePropertyFixtureDb();
    process.env.PDG_DB_PATH = dbPath;

    const res = await handleToolCall(
      'pdg_get_property',
      { particle: { name: 'pi+-' }, property: 'width', allow_derived: true },
      'standard'
    );
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.property?.key).toBe('width');
    expect(payload.edition).toBe('2025');
    expect(payload.property?.derived?.kind).toBe('width_from_lifetime');
    expect(payload.value?.unit_text).toBe('eV');
    expect(typeof payload.value?.value).toBe('number');
    expect(payload.value?.display_text).toContain('eV');
    expect(payload.pdg_locator?.table).toContain('derived');
  });
});
