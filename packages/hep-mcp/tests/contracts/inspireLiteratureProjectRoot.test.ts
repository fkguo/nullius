import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Ajv from 'ajv';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(async () => ({ recid: '1' })),
  getReferences: vi.fn(async () => []),
  getByDoi: vi.fn(async () => ({ recid: '1' })),
  getByArxiv: vi.fn(async () => ({ recid: '1' })),
  getCitations: vi.fn(async () => ({ total: 0, papers: [], has_more: false })),
  search: vi.fn(async () => ({ total: 0, papers: [], has_more: false })),
  getBibtex: vi.fn(async () => '@article{Example, title={Example}}'),
  getAuthor: vi.fn(async () => ({ bai: 'Example.1' })),
}));

import * as api from '../../src/api/client.js';
import { getToolSpec, getTools, handleToolCall } from '../../src/tools/index.js';

const cases = [
  { mode: 'get_paper', args: { recid: '1', size: 2 }, method: 'getPaper', call: ['1'], forbidden: { sort: 'mostrecent' } },
  { mode: 'get_references', args: { recid: '1', size: 2 }, method: 'getReferences', call: ['1', 2], forbidden: { sort: 'mostrecent' } },
  { mode: 'lookup_by_id', args: { identifier: '10.1000/example', size: 2 }, method: 'getByDoi', call: ['10.1000/example'], forbidden: { sort: 'mostrecent' } },
  { mode: 'get_citations', args: { recid: '1', size: 2, sort: 'mostrecent' }, method: 'getCitations', call: ['1', { size: 2, sort: 'mostrecent' }], forbidden: { identifier: '1' } },
  { mode: 'search_affiliation', args: { affiliation: 'Example', size: 2, sort: 'mostrecent' }, method: 'search', call: ['aff:Example', { size: 2, sort: 'mostrecent' }], forbidden: { recid: '1' } },
  { mode: 'get_bibtex', args: { recids: ['1'] }, method: 'getBibtex', call: [['1']], forbidden: { size: 2 } },
  { mode: 'get_author', args: { identifier: 'Example.1', size: 2 }, method: 'getAuthor', call: ['Example.1'], forbidden: { sort: 'mostrecent' } },
] as const;

describe('INSPIRE literature common project_root contract', () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inspire-project-root-contract-'));
    fs.mkdirSync(path.join(projectRoot, '.nullius'));
  });

  beforeEach(() => vi.clearAllMocks());
  afterAll(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  for (const exposure of ['standard', 'full'] as const) {
    it.each(cases)(`${exposure} catalog and parser both accept project_root for $mode`, ({ mode, args }) => {
      const advertised = getTools(exposure).find(tool => tool.name === 'inspire_literature');
      expect(advertised).toBeDefined();
      expect(advertised!.inputSchema.properties?.project_root).toMatchObject({ type: 'string' });
      const input = { mode, ...args, project_root: projectRoot };
      const validate = new Ajv({ strict: false }).compile(advertised!.inputSchema);
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
      expect(getToolSpec('inspire_literature')!.zodSchema.parse(input)).toEqual(input);
    });
  }

  it.each(cases)('dispatches $mode with project_root without passing it to the provider', async ({ mode, args, method, call }) => {
    const result = await handleToolCall('inspire_literature', { mode, ...args, project_root: projectRoot });
    expect(result.isError, result.content[0]?.text).not.toBe(true);
    expect(api[method]).toHaveBeenCalledExactlyOnceWith(...call);
  });

  it.each(cases)('still rejects mode-specific wrong arguments for $mode before provider dispatch', async ({ mode, args, forbidden }) => {
    const input = { mode, ...args, ...forbidden, project_root: projectRoot };
    const parsed = getToolSpec('inspire_literature')!.zodSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        code: 'unrecognized_keys', keys: Object.keys(forbidden),
      }));
    }
    const result = await handleToolCall('inspire_literature', input);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}').error.code).toBe('INVALID_PARAMS');
    for (const entry of cases) expect(api[entry.method]).not.toHaveBeenCalled();
  });

  it.each(cases)('still requires the mode-specific identifier for $mode', ({ mode }) => {
    expect(getToolSpec('inspire_literature')!.zodSchema.safeParse({ mode, project_root: projectRoot }).success).toBe(false);
  });

  it.each([
    { mode: 'get_paper', args: { recid: 123 }, method: 'getPaper', call: ['123'] },
    { mode: 'get_references', args: { recid: 456, size: 2 }, method: 'getReferences', call: ['456', 2] },
    { mode: 'get_citations', args: { recid: 789 }, method: 'getCitations', call: ['789', { size: 25, sort: undefined }] },
    { mode: 'lookup_by_id', args: { identifier: 123 }, method: 'getPaper', call: ['123'] },
    { mode: 'lookup_by_id', args: { identifier: ' 123 ' }, method: 'getPaper', call: ['123'] },
    { mode: 'get_paper', args: { recid: '9007199254740993' }, method: 'getPaper', call: ['9007199254740993'] },
    { mode: 'get_bibtex', args: { recids: 123 }, method: 'getBibtex', call: [['123']] },
    { mode: 'get_bibtex', args: { recids: [123, '9007199254740993'] }, method: 'getBibtex', call: [['123', '9007199254740993']] },
    { mode: 'get_bibtex', args: { recids: '123, 456' }, method: 'getBibtex', call: [['123', '456']] },
  ] as const)('advertises and dispatches $mode $args with exact string IDs', async ({ mode, args, method, call }) => {
    const input = { mode, ...args, project_root: projectRoot };
    for (const exposure of ['standard', 'full'] as const) {
      const tool = getTools(exposure).find(t => t.name === 'inspire_literature')!;
      const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    }
    const result = await handleToolCall('inspire_literature', input);
    expect(result.isError, result.content[0]?.text).not.toBe(true);
    expect(api[method]).toHaveBeenCalledExactlyOnceWith(...call);
  });

  it('rejects malformed and imprecise IDs before contacting INSPIRE', async () => {
    const tool = getTools('standard').find(t => t.name === 'inspire_literature')!;
    const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
    for (const recid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, null, '', '1.5']) {
      for (const input of [{ mode: 'get_paper', recid }, { mode: 'get_bibtex', recids: [123, recid] }]) {
        expect(validate(input)).toBe(false);
        const result = await handleToolCall('inspire_literature', input);
        expect(JSON.parse(result.content[0]!.text).error.code).toBe('INVALID_PARAMS');
      }
    }
    expect(api.getPaper).not.toHaveBeenCalled();
    expect(api.getBibtex).not.toHaveBeenCalled();
  });

  it.each([0, ' 00 '])('rejects zero as a lookup_by_id record identifier (%j)', async identifier => {
    const result = await handleToolCall('inspire_literature', { mode: 'lookup_by_id', identifier });
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('INVALID_PARAMS');
    expect(api.getPaper).not.toHaveBeenCalled();
    expect(api.getByArxiv).not.toHaveBeenCalled();
  });

  it('keeps author identifiers textual', async () => {
    const result = await handleToolCall('inspire_literature', { mode: 'get_author', identifier: 123 });
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('INVALID_PARAMS');
    expect(api.getAuthor).not.toHaveBeenCalled();
  });

  it('rejects non-string project_root at the shared schema boundary', () => {
    expect(getToolSpec('inspire_literature')!.zodSchema.safeParse({ mode: 'get_paper', recid: '1', project_root: 1 }).success).toBe(false);
  });
});
