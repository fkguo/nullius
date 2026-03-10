import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDataDir } from '../api/client.js';

const ORIGINAL_OPENALEX_DATA_DIR = process.env.OPENALEX_DATA_DIR;
const ORIGINAL_HEP_DATA_DIR = process.env.HEP_DATA_DIR;

afterEach(() => {
  if (ORIGINAL_OPENALEX_DATA_DIR === undefined) delete process.env.OPENALEX_DATA_DIR;
  else process.env.OPENALEX_DATA_DIR = ORIGINAL_OPENALEX_DATA_DIR;

  if (ORIGINAL_HEP_DATA_DIR === undefined) delete process.env.HEP_DATA_DIR;
  else process.env.HEP_DATA_DIR = ORIGINAL_HEP_DATA_DIR;
});

describe('getDataDir', () => {
  it('prefers OPENALEX_DATA_DIR when set', () => {
    process.env.OPENALEX_DATA_DIR = '~/openalex-explicit';
    process.env.HEP_DATA_DIR = '/tmp/hep-data';

    expect(getDataDir()).toBe(path.resolve(path.join(os.homedir(), 'openalex-explicit')));
  });

  it('falls back to HEP_DATA_DIR/openalex when provider data is colocated with hep-mcp state', () => {
    delete process.env.OPENALEX_DATA_DIR;
    process.env.HEP_DATA_DIR = '~/hep-data';

    expect(getDataDir()).toBe(path.resolve(path.join(os.homedir(), 'hep-data', 'openalex')));
  });

  it('uses a domain-neutral home default when no explicit provider config is set', () => {
    delete process.env.OPENALEX_DATA_DIR;
    delete process.env.HEP_DATA_DIR;

    expect(getDataDir()).toBe(path.resolve(path.join(os.homedir(), '.autoresearch', 'openalex')));
  });
});
