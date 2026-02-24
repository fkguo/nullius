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

function makeR3FixtureDb(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-r3-db-'));
  const dbPath = path.join(tmpDir, 'pdg.sqlite');

  runSqlite(
    dbPath,
    [
      `CREATE TABLE pdgid(
        id INTEGER PRIMARY KEY,
        pdgid VARCHAR NOT NULL,
        parent_pdgid VARCHAR,
        description VARCHAR,
        data_type VARCHAR(4),
        flags VARCHAR(8),
        sort INTEGER
      );`,
      `CREATE TABLE pdgreference(
        id INTEGER PRIMARY KEY,
        document_id VARCHAR NOT NULL,
        publication_name VARCHAR,
        publication_year INTEGER,
        doi VARCHAR(240),
        inspire_id VARCHAR(16),
        title VARCHAR
      );`,
      `CREATE TABLE pdgmeasurement(
        id INTEGER PRIMARY KEY,
        pdgid_id INTEGER NOT NULL,
        pdgid VARCHAR NOT NULL,
        pdgreference_id INTEGER NOT NULL,
        event_count VARCHAR(20),
        confidence_level FLOAT,
        place VARCHAR(1),
        technique VARCHAR(4),
        charge VARCHAR(3),
        changebar BOOLEAN,
        comment VARCHAR,
        sort INTEGER NOT NULL
      );`,
      `CREATE TABLE pdgmeasurement_values(
        id INTEGER PRIMARY KEY,
        pdgmeasurement_id INTEGER NOT NULL,
        column_name VARCHAR,
        value_text VARCHAR,
        unit_text VARCHAR,
        display_value_text VARCHAR,
        display_power_of_ten INTEGER,
        display_in_percent BOOLEAN,
        limit_type VARCHAR(1),
        used_in_average BOOLEAN,
        used_in_fit BOOLEAN,
        value FLOAT,
        error_positive FLOAT,
        error_negative FLOAT,
        stat_error_positive FLOAT,
        stat_error_negative FLOAT,
        syst_error_positive FLOAT,
        syst_error_negative FLOAT,
        sort INTEGER NOT NULL
      );`,
      `CREATE TABLE pdgfootnote(
        id INTEGER PRIMARY KEY,
        pdgid VARCHAR,
        text VARCHAR,
        footnote_index INTEGER,
        changebar BOOLEAN
      );`,
      `CREATE TABLE pdgmeasurement_footnote(
        id INTEGER PRIMARY KEY,
        pdgmeasurement_id INTEGER NOT NULL,
        pdgfootnote_id INTEGER NOT NULL
      );`,

      "INSERT INTO pdgid(id,pdgid,parent_pdgid,description,data_type,flags,sort) VALUES (11,'S000M','S000','Test Mass','M','D',1);",

      "INSERT INTO pdgreference(id,document_id,publication_name,publication_year,doi,inspire_id,title) VALUES (1,'PATEL 1965','Phys.Lett.',1965,'10.1016/0031-9163(65)90438-5','48875','Photon Rest Mass');",
      "INSERT INTO pdgreference(id,document_id,publication_name,publication_year,doi,inspire_id,title) VALUES (2,'GINTSBURG 1964','Phys.Rev.',1964,'','42302','Cosmic Electrodynamics');",

      "INSERT INTO pdgmeasurement(id,pdgid_id,pdgid,pdgreference_id,event_count,confidence_level,place,technique,charge,changebar,comment,sort) VALUES (101,11,'S000M',1,'100',0.95,'T','LHC','+',0,'test',1);",
      "INSERT INTO pdgmeasurement(id,pdgid_id,pdgid,pdgreference_id,event_count,confidence_level,place,technique,charge,changebar,comment,sort) VALUES (102,11,'S000M',2,NULL,NULL,NULL,NULL,NULL,0,NULL,2);",

      "INSERT INTO pdgmeasurement_values(id,pdgmeasurement_id,column_name,value_text,unit_text,display_value_text,display_power_of_ten,display_in_percent,limit_type,used_in_average,used_in_fit,value,error_positive,error_negative,sort) VALUES (1001,101,'VALUE',NULL,'GeV','1.23',0,0,NULL,1,1,1.23,0.01,0.01,1);",
      "INSERT INTO pdgmeasurement_values(id,pdgmeasurement_id,column_name,value_text,unit_text,display_value_text,display_power_of_ten,display_in_percent,limit_type,used_in_average,used_in_fit,value,sort) VALUES (1002,102,'LIMIT','< 0.1','GeV','< 0.1',0,0,'U',0,0,NULL,1);",

      "INSERT INTO pdgfootnote(id,pdgid,text,footnote_index,changebar) VALUES (201,'S000M','systematic dominated',1,0);",
      "INSERT INTO pdgmeasurement_footnote(id,pdgmeasurement_id,pdgfootnote_id) VALUES (1,101,201);",
    ].join(' ')
  );

  return dbPath;
}

describe('pdg_get_measurements (R3)', () => {
  it('writes JSONL artifact and includes reference/value/footnote joins', async () => {
    const dbPath = makeR3FixtureDb();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-r3-data-'));
    process.env.PDG_DB_PATH = dbPath;
    process.env.PDG_DATA_DIR = dataDir;

    const res = await handleToolCall(
      'pdg_get_measurements',
      { pdgid: 'S000M', artifact_name: 'test_measurements.jsonl', limit: 10, start: 0 },
      'standard'
    );
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.uri).toBe('pdg://artifacts/test_measurements.jsonl');
    expect(payload.summary?.pdgid).toBe('S000M');
    expect(payload.summary?.measurements).toBe(2);
    expect(payload.summary?.references).toBe(2);

    const artifactPath = path.join(dataDir, 'artifacts', 'test_measurements.jsonl');
    expect(fs.existsSync(artifactPath)).toBe(true);
    const lines = fs.readFileSync(artifactPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0] ?? '{}') as any;
    expect(first.measurement?.id).toBe(101);
    expect(first.reference?.id).toBe(1);
    expect(first.reference?.doi).toBe('10.1016/0031-9163(65)90438-5');
    expect(first.reference?.inspire_lookup_by_id).toEqual(['10.1016/0031-9163(65)90438-5', '48875']);
    expect(first.values?.[0]?.display_text).toContain('GeV');
    expect(first.footnotes?.[0]?.text).toBe('systematic dominated');

    const second = JSON.parse(lines[1] ?? '{}') as any;
    expect(second.measurement?.id).toBe(102);
    expect(second.reference?.id).toBe(2);
    expect(second.reference?.doi).toBe(null);
    expect(second.reference?.inspire_lookup_by_id).toEqual(['42302']);
  });

  function makeMcidFixtureDb(opts: { seriesCount: 1 | 2 }): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-r3-mcid-db-'));
    const dbPath = path.join(tmpDir, 'pdg.sqlite');

    const series2 = opts.seriesCount === 2;

    runSqlite(
      dbPath,
      [
        `CREATE TABLE pdgid(
          id INTEGER PRIMARY KEY,
          pdgid VARCHAR NOT NULL,
          parent_pdgid VARCHAR,
          description VARCHAR,
          data_type VARCHAR(4),
          flags VARCHAR(8),
          sort INTEGER
        );`,
        `CREATE TABLE pdgparticle(
          id INTEGER PRIMARY KEY,
          pdgid_id INTEGER NOT NULL,
          name VARCHAR NOT NULL,
          cc_type VARCHAR(1),
          mcid INTEGER,
          charge FLOAT
        );`,
        `CREATE TABLE pdgmeasurement(
          id INTEGER PRIMARY KEY,
          pdgid_id INTEGER NOT NULL,
          pdgid VARCHAR NOT NULL,
          pdgreference_id INTEGER NOT NULL,
          event_count VARCHAR(20),
          confidence_level FLOAT,
          place VARCHAR(1),
          technique VARCHAR(4),
          charge VARCHAR(3),
          changebar BOOLEAN,
          comment VARCHAR,
          sort INTEGER NOT NULL
        );`,

        // Base particle (pi0) + one or two measurement series
        "INSERT INTO pdgid(id,pdgid,parent_pdgid,description,data_type,flags,sort) VALUES (1,'S009',NULL,'pi0','PART','M',1);",
        "INSERT INTO pdgid(id,pdgid,parent_pdgid,description,data_type,flags,sort) VALUES (2,'S009T','S009','pi0 MEAN LIFE','T','D0',2);",
        series2
          ? "INSERT INTO pdgid(id,pdgid,parent_pdgid,description,data_type,flags,sort) VALUES (3,'S009R1','S009','ratio test','BR','',3);"
          : '',
        "INSERT INTO pdgparticle(id,pdgid_id,name,cc_type,mcid,charge) VALUES (1,1,'pi0','S',111,0.0);",

        // Measurements (one row per series)
        "INSERT INTO pdgmeasurement(id,pdgid_id,pdgid,pdgreference_id,changebar,sort) VALUES (101,2,'S009T',1,0,1);",
        series2 ? "INSERT INTO pdgmeasurement(id,pdgid_id,pdgid,pdgreference_id,changebar,sort) VALUES (102,3,'S009R1',1,0,1);" : '',
      ]
        .filter(s => s.length > 0)
        .join(' ')
    );

    return dbPath;
  }

  it('accepts numeric MCID via pdgid and auto-selects the only measurement series', async () => {
    const dbPath = makeMcidFixtureDb({ seriesCount: 1 });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-r3-mcid-data-'));
    process.env.PDG_DB_PATH = dbPath;
    process.env.PDG_DATA_DIR = dataDir;

    const res = await handleToolCall(
      'pdg_get_measurements',
      {
        pdgid: '111',
        include_values: false,
        include_reference: false,
        include_footnotes: false,
        artifact_name: 'mcid_measurements.jsonl',
        limit: 10,
      },
      'standard'
    );
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.summary?.pdgid).toBe('S009T');
    expect(payload.summary?.measurements).toBe(1);

    const artifactPath = path.join(dataDir, 'artifacts', 'mcid_measurements.jsonl');
    expect(fs.existsSync(artifactPath)).toBe(true);
  });

  it('returns series options when numeric MCID maps to multiple measurement series', async () => {
    const dbPath = makeMcidFixtureDb({ seriesCount: 2 });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-r3-mcid-data-'));
    process.env.PDG_DB_PATH = dbPath;
    process.env.PDG_DATA_DIR = dataDir;

    const res = await handleToolCall(
      'pdg_get_measurements',
      {
        pdgid: '111',
        include_values: false,
        include_reference: false,
        include_footnotes: false,
        artifact_name: 'mcid_series.jsonl',
        limit: 10,
      },
      'standard'
    );
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.summary?.kind).toBe('series_options');
    expect(payload.summary?.series).toBe(2);

    const artifactPath = path.join(dataDir, 'artifacts', 'mcid_series.json');
    expect(fs.existsSync(artifactPath)).toBe(true);
    const obj = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as any;
    expect(obj.kind).toBe('measurement_series_options');
    expect(obj.series).toHaveLength(2);
  });

  it('supports disambiguation by data_type when multiple measurement series exist', async () => {
    const dbPath = makeMcidFixtureDb({ seriesCount: 2 });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-r3-mcid-data-'));
    process.env.PDG_DB_PATH = dbPath;
    process.env.PDG_DATA_DIR = dataDir;

    const res = await handleToolCall(
      'pdg_get_measurements',
      {
        pdgid: '111',
        data_type: 'T',
        include_values: false,
        include_reference: false,
        include_footnotes: false,
        artifact_name: 'mcid_measurements_T.jsonl',
        limit: 10,
      },
      'standard'
    );
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.summary?.pdgid).toBe('S009T');
    expect(payload.summary?.measurements).toBe(1);

    const artifactPath = path.join(dataDir, 'artifacts', 'mcid_measurements_T.jsonl');
    expect(fs.existsSync(artifactPath)).toBe(true);
  });

  it('accepts particle.pdg_code alias (preferred) for mcid-based measurement lookup', async () => {
    const dbPath = makeMcidFixtureDb({ seriesCount: 1 });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdg-r3-mcid-data-'));
    process.env.PDG_DB_PATH = dbPath;
    process.env.PDG_DATA_DIR = dataDir;

    const res = await handleToolCall(
      'pdg_get_measurements',
      {
        particle: { pdg_code: 111 },
        include_values: false,
        include_reference: false,
        include_footnotes: false,
        artifact_name: 'mcid_measurements_particle.jsonl',
        limit: 10,
      },
      'standard'
    );
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.summary?.pdgid).toBe('S009T');
    expect(payload.summary?.measurements).toBe(1);

    const artifactPath = path.join(dataDir, 'artifacts', 'mcid_measurements_particle.jsonl');
    expect(fs.existsSync(artifactPath)).toBe(true);
  });
});
