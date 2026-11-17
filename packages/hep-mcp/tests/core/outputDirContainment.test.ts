import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/api/client.js', () => ({
  search: vi.fn(),
  searchByUrl: vi.fn(),
  getPaper: vi.fn(),
  getByDoi: vi.fn(),
  getByArxiv: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { handleToolCall } = await import('../../src/tools/index.js');
const { makeProjectRoot } = await import('../support/projectFiles.js');
const { withHepDataRoot } = await import('../../src/data/dataDir.js');
const { OutputBatch, resolveOutputDir } = await import('../../src/core/outputDir.js');
const { describeExternalApiRequest } = await import('../../src/core/cache/externalApiCache.js');
const { McpError, upstreamError } = await import('@nullius/shared');

type ToolResult = Awaited<ReturnType<typeof handleToolCall>>;

/** Every file below `dir`, at any depth (none if `dir` does not exist). */
function filesBelow(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter(entry => fs.lstatSync(path.join(dir, entry)).isFile())
    .sort();
}

function errorOf(result: ToolResult): { code: string; message: string; data?: Record<string, unknown> } {
  expect(result.isError).toBe(true);
  return (JSON.parse(result.content[0]!.text) as { error: { code: string; message: string; data?: Record<string, unknown> } }).error;
}

/**
 * Every case names the project through an explicit symlinked alias, so the
 * alias-versus-canonical distinction is exercised on every platform (on
 * macOS the temp directory is itself an alias of /private/var, on Linux it
 * is not).
 */
describe('output_dir lies inside the admitted project root, through real directories only', () => {
  let tmpDir: string;
  let projectRoot: string;
  let alias: string;

  async function resolveIds(args: Record<string, unknown>): Promise<ToolResult> {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    return handleToolCall('hep_inspire_resolve_identifiers', { identifiers: ['123'], ...args });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-')));
    projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a root named through an alias above it and writes under the canonical root', async () => {
    const result = await resolveIds({ project_root: alias, output_dir: path.join(alias, 'out', 'ids') });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { output_dir: string; mapping_path: string };
    expect(payload.output_dir).toBe('out/ids');
    expect(fs.existsSync(path.join(projectRoot, payload.mapping_path))).toBe(true);
    expect(fs.lstatSync(path.join(projectRoot, 'out')).isDirectory()).toBe(true);
  });

  it('accepts an absolute output_dir spelled through the alias when the root is given canonically', async () => {
    const result = await resolveIds({ project_root: projectRoot, output_dir: path.join(alias, 'notes') });
    expect(result.isError).toBeFalsy();
    expect((JSON.parse(result.content[0]!.text) as { output_dir: string }).output_dir).toBe('notes');
    expect(fs.readdirSync(path.join(projectRoot, 'notes')).some(name => name.endsWith('.jsonl'))).toBe(true);
  });

  it('refuses a relative output_dir that leaves the root, and creates nothing outside', async () => {
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: '../outside' }));
    expect(error.message).toMatch(/inside project_root/);
    expect(fs.existsSync(path.join(tmpDir, 'outside'))).toBe(false);
  });

  it('refuses an absolute output_dir outside the root', async () => {
    const outside = path.join(tmpDir, 'elsewhere');
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: outside }));
    expect(error.message).toMatch(/inside project_root/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('refuses a symlink below the root even when it points inside the project', async () => {
    fs.mkdirSync(path.join(projectRoot, 'real'));
    fs.symlinkSync(path.join(projectRoot, 'real'), path.join(projectRoot, 'linked'), 'dir');
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: 'linked/sub' }));
    expect(error.code).toBe('UNSAFE_FS');
    expect(error.message).toMatch(/symbolic link/);
    expect(fs.existsSync(path.join(projectRoot, 'real', 'sub'))).toBe(false);
  });

  it('refuses a symlink below the root that leads outside, and writes nothing there', async () => {
    const elsewhere = path.join(tmpDir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(projectRoot, 'escape'), 'dir');
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: path.join(alias, 'escape', 'sub') }));
    expect(error.message).toMatch(/symbolic link/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a dangling symlink below the root instead of creating its target', async () => {
    const missing = path.join(tmpDir, 'missing');
    fs.symlinkSync(missing, path.join(projectRoot, 'dangling'), 'dir');
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: 'dangling' }));
    expect(error.message).toMatch(/symbolic link/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('refuses a file where a directory is needed', async () => {
    fs.writeFileSync(path.join(projectRoot, 'notes.txt'), 'x');
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: 'notes.txt/sub' }));
    expect(error.message).toMatch(/must name a directory/);
  });

  it.each([
    '.nullius/out',
    'team/runs/r1',
    'artifacts/hep-mcp/runs/run_x',
    'artifacts/hep-mcp',
    'Artifacts/HEP-MCP/x',
  ])('refuses the reserved location %s', async outputDir => {
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: outputDir }));
    expect(error.message).toMatch(/must not lie under/);
  });

  it('accepts a sibling whose name only begins like a reserved directory', async () => {
    const result = await resolveIds({ project_root: alias, output_dir: 'artifacts/hep-mcp-notes' });
    expect(result.isError).toBeFalsy();
  });

  it('refuses the project root itself named as "."', async () => {
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: '.' }));
    expect(error.message).toMatch(/not the root itself/);
  });

  it('refuses a blank output_dir at argument validation', async () => {
    const result = await resolveIds({ project_root: alias, output_dir: '' });
    expect(errorOf(result).code).toBe('INVALID_PARAMS');
    expect(result.content[0]!.text).toContain('output_dir');
  });

  it.each([
    ['hep_inspire_search_export', { query: 't:x' }, '../escape.jsonl'],
    ['hep_inspire_search_export', { query: 't:x' }, 'a/b.jsonl'],
    ['hep_inspire_resolve_identifiers', { identifiers: ['1'] }, '..'],
    ['hep_inspire_resolve_identifiers', { identifiers: ['1'] }, 'a\\b.jsonl'],
  ])('%s refuses the output file name %j before any provider call', async (tool, args, name) => {
    const result = await handleToolCall(tool, { project_root: alias, output_dir: 'out', artifact_name: name, ...args });
    expect(errorOf(result).code).toBe('INVALID_PARAMS');
    expect(api.search).not.toHaveBeenCalled();
    expect(api.getPaper).not.toHaveBeenCalled();
    // '../escape.jsonl' under output_dir 'out' would land in the project root.
    expect(fs.existsSync(path.join(projectRoot, 'escape.jsonl'))).toBe(false);
  });

  it('refuses the project root itself spelled through the alias', async () => {
    const error = errorOf(await resolveIds({ project_root: projectRoot, output_dir: alias }));
    expect(error.message).toMatch(/not the root itself/);
  });

  it('requires project_root', async () => {
    const error = errorOf(await resolveIds({ output_dir: 'out' }));
    expect(error.message).toMatch(/output_dir requires project_root/);
  });

  it('refuses to write through a symlink planted at the output file, leaving its target untouched', async () => {
    const victim = path.join(tmpDir, 'victim.jsonl');
    fs.writeFileSync(victim, 'original\n');
    fs.mkdirSync(path.join(projectRoot, 'out'));
    fs.symlinkSync(victim, path.join(projectRoot, 'out', 'map.jsonl'), 'file');
    const error = errorOf(await resolveIds({
      project_root: alias,
      output_dir: 'out',
      artifact_name: 'map.jsonl',
      meta_artifact_name: 'map_meta.json',
    }));
    expect(error.message).toMatch(/symbolic link/);
    expect(api.getPaper).not.toHaveBeenCalled();
    expect(fs.readFileSync(victim, 'utf-8')).toBe('original\n');
  });

  it('records each external API call under external_api/ in the output directory', async () => {
    const result = await resolveIds({ project_root: alias, output_dir: 'out' });
    expect(result.isError).toBeFalsy();
    const records = fs.readdirSync(path.join(projectRoot, 'out', 'external_api')).sort();
    expect(records.some(name => name.startsWith('external_api_request_inspire_getPaper_'))).toBe(true);
    expect(records.some(name => name.startsWith('external_api_response_inspire_getPaper_'))).toBe(true);
  });
});

describe('output files are checked again at write time and streamed outputs fail cleanly', () => {
  let tmpDir: string;
  let projectRoot: string;
  let alias: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-write-')));
    projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function temporaryFiles(dir: string): string[] {
    return fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
  }

  it('refuses a write after the admitted directory was swapped for a symlink', async () => {
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    await withHepDataRoot(alias, async () => {
      const batch = new OutputBatch(resolveOutputDir('out/sub'));
      fs.renameSync(path.join(projectRoot, 'out'), path.join(tmpDir, 'moved-away'));
      fs.symlinkSync(outside, path.join(projectRoot, 'out'), 'dir');
      expect(() => batch.json('late.json', { x: 1 })).toThrow(/symbolic link/);
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses to publish after the admitted directory was swapped for a symlink, and leaves nothing behind it', async () => {
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    await withHepDataRoot(alias, async () => {
      const batch = new OutputBatch(resolveOutputDir('pub'));
      batch.json('a.json', { x: 1 });
      fs.renameSync(path.join(projectRoot, 'pub'), path.join(tmpDir, 'pub-moved'));
      fs.symlinkSync(outside, path.join(projectRoot, 'pub'), 'dir');
      await expect(batch.publish()).rejects.toThrow(/symbolic link/);
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  // Root ignores directory permissions, so the read-only-directory case cannot be built there.
  it('reports a name too long for the file system as an environment failure, with no residue', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('long-names');
      // ASCII names, so the 255 limit for a file name is exceeded whether the
      // file system counts it in bytes or in characters.
      // The final name itself is too long:
      expect(() => new OutputBatch(out).json(`${'a'.repeat(260)}.json`, {}))
        .toThrow(expect.objectContaining({
          code: 'UNSAFE_FS', message: expect.stringMatching(/^looking up .* failed/), data: expect.objectContaining({ errno: 'ENAMETOOLONG' }),
        }));
      // The final name fits (225 characters), its staging name does not:
      expect(() => new OutputBatch(out).json(`${'a'.repeat(220)}.json`, {}))
        .toThrow(expect.objectContaining({
          code: 'UNSAFE_FS',
          message: expect.stringMatching(/^creating a staging file failed/),
          data: expect.objectContaining({ errno: 'ENAMETOOLONG' }),
        }));
      expect(fs.readdirSync(out.dir)).toEqual([]);
    });
  });

  it.skipIf(process.getuid?.() === 0)('reports an output directory that cannot be created as an environment failure', async () => {
    await withHepDataRoot(alias, async () => {
      const locked = path.join(projectRoot, 'locked');
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0o555);
      try {
        expect(() => resolveOutputDir('locked/sub'))
          .toThrow(expect.objectContaining({ code: 'UNSAFE_FS', data: expect.objectContaining({ errno: 'EACCES' }) }));
      } finally {
        fs.chmodSync(locked, 0o755);
      }
      expect(fs.readdirSync(locked)).toEqual([]);
    });
  });

  it.skipIf(process.getuid?.() === 0)('refuses a piecewise output in a directory it cannot write, with no residue', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('locked');
      const batch = new OutputBatch(out);
      fs.chmodSync(out.dir, 0o555);
      try {
        // The environment refused the write: UNSAFE_FS, keeping the system's code.
        expect(() => batch.openFile('records.jsonl', 'application/x-ndjson'))
          .toThrow(expect.objectContaining({ code: 'UNSAFE_FS', data: expect.objectContaining({ errno: 'EACCES' }) }));
      } finally {
        fs.chmodSync(out.dir, 0o755);
      }
      expect(temporaryFiles(out.dir)).toEqual([]);
      expect(fs.existsSync(path.join(out.dir, 'records.jsonl'))).toBe(false);
    });
  });

  it('refuses to publish when an entry appeared at the final name, and removes its staging file', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('final');
      const batch = new OutputBatch(out);
      const file = batch.openFile('records.jsonl', 'application/x-ndjson');
      file.write('{"a":1}\n');
      file.finish();
      fs.mkdirSync(path.join(out.dir, 'records.jsonl'));
      await expect(batch.publish()).rejects.toThrow(/non-file entry/);
      expect(temporaryFiles(out.dir)).toEqual([]);
      expect(fs.statSync(path.join(out.dir, 'records.jsonl')).isDirectory()).toBe(true);
    });
  });

  it('refuses a write when the directory is swapped while the data is being serialized', async () => {
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    await withHepDataRoot(alias, async () => {
      const batch = new OutputBatch(resolveOutputDir('serial'));
      const data = {
        toJSON: () => {
          fs.renameSync(path.join(projectRoot, 'serial'), path.join(tmpDir, 'serial-moved'));
          fs.symlinkSync(outside, path.join(projectRoot, 'serial'), 'dir');
          return { x: 1 };
        },
      };
      expect(() => batch.json('late.json', data)).toThrow(/symbolic link/);
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('does not publish or delete through a directory swapped for a symlink after the file was written', async () => {
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('swap');
      const batch = new OutputBatch(out);
      const file = batch.openFile('records.jsonl', 'application/x-ndjson');
      file.write('{"a":1}\n');
      file.finish();
      const temp = temporaryFiles(out.dir)[0]!;
      const moved = path.join(tmpDir, 'swap-moved');
      fs.renameSync(out.dir, moved);
      fs.symlinkSync(outside, out.dir, 'dir');
      fs.writeFileSync(path.join(outside, temp), 'sentinel');
      const error = await batch.publish().then(() => null, (e: unknown) => e as Error & { data?: { staging_left?: string[] } });
      expect(error?.message).toMatch(/symbolic link/);
      // The staging file could not be removed through the symlink, so it is named.
      expect(error?.data?.staging_left).toEqual([`swap/${temp}`]);
      // The same-named file behind the symlink is untouched; the real
      // staging file stays where it was created.
      expect(fs.readFileSync(path.join(outside, temp), 'utf-8')).toBe('sentinel');
      expect(fs.existsSync(path.join(moved, temp))).toBe(true);
      expect(fs.existsSync(path.join(outside, 'records.jsonl'))).toBe(false);
    });
  });

  it('never publishes or deletes a same-named file in a real directory that replaced the output directory', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('replaced');
      const batch = new OutputBatch(out);
      const file = batch.openFile('records.jsonl', 'application/x-ndjson');
      file.write('{"genuine":true}\n');
      file.finish();
      const temp = temporaryFiles(out.dir)[0]!;
      const moved = path.join(tmpDir, 'replaced-moved');
      fs.renameSync(out.dir, moved);
      fs.mkdirSync(out.dir);
      fs.writeFileSync(path.join(out.dir, temp), '{"stale":true}\n');
      const error = await batch.publish().then(() => null, (e: unknown) => e as Error & { data?: { staging_left?: string[] } });
      expect(error?.message).toMatch(/staged output file was replaced/);
      // This call's staging file left output_dir with the moved directory; the
      // stale file now at its name is not this call's, so nothing is reported.
      expect(error?.data?.staging_left).toBeUndefined();
      expect(fs.existsSync(path.join(out.dir, 'records.jsonl'))).toBe(false);
      expect(fs.readFileSync(path.join(out.dir, temp), 'utf-8')).toBe('{"stale":true}\n');
      expect(fs.existsSync(path.join(moved, temp))).toBe(true);
    });
  });

  it('leaves no staging file when discarded right after opening or while writing', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('early');
      const first = new OutputBatch(out);
      first.openFile('records.jsonl', 'application/x-ndjson');
      expect(temporaryFiles(out.dir)).toHaveLength(1);
      first.discard();
      expect(temporaryFiles(out.dir)).toEqual([]);
      const second = new OutputBatch(out);
      second.openFile('records.jsonl', 'application/x-ndjson').write('{"a":1}\n');
      second.discard();
      expect(fs.readdirSync(out.dir)).toEqual([]);
    });
  });

  it('refuses to write or finish a file of a discarded call', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('gone');
      const batch = new OutputBatch(out);
      const file = batch.openFile('records.jsonl', 'application/x-ndjson');
      file.write('{"a":1}\n');
      batch.discard();
      expect(() => file.write('{"b":2}\n')).toThrow(/already finished or discarded/);
      expect(() => file.finish()).toThrow(/already finished or discarded/);
      expect(temporaryFiles(out.dir)).toEqual([]);
    });
  });

  it('flushes every directory from the project root down to each published file', async () => {
    const { _setAtomicWriteAuditHook } = await import('@nullius/shared');
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('deep/er/out');
      const batch = new OutputBatch(out);
      batch.json('a.json', { x: 1 });
      batch.json('external_api/r.json', { x: 2 });
      const fsynced = new Set<string>();
      const opened = new Map<number, string>();
      const restore = _setAtomicWriteAuditHook(event => {
        if (event.kind === 'open') opened.set(event.fd, event.path);
        if (event.kind === 'fsync' && opened.has(event.fd)) fsynced.add(opened.get(event.fd)!);
      });
      try {
        await batch.publish();
      } finally {
        restore();
      }
      for (const rel of ['', 'deep', 'deep/er', 'deep/er/out', 'deep/er/out/external_api']) {
        expect(fsynced.has(path.join(projectRoot, rel)), rel || '(project root)').toBe(true);
      }
    });
  });

  it('flushes the directories it removed files from when a publication is rolled back', async () => {
    const { _setAtomicWriteAuditHook } = await import('@nullius/shared');
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('undo/out');
      const batch = new OutputBatch(out);
      batch.json('a.json', { x: 1 });
      const opened = new Map<number, string>();
      const fsyncs: string[] = [];
      let failedRoot = false;
      const restore = _setAtomicWriteAuditHook(event => {
        if (event.kind === 'open') opened.set(event.fd, event.path);
        if (event.kind !== 'fsync' || !opened.has(event.fd)) return;
        const dir = opened.get(event.fd)!;
        fsyncs.push(dir);
        // The output directory is flushed first; the project root's flush then fails once.
        if (dir === projectRoot && !failedRoot) {
          failedRoot = true;
          throw new Error('simulated directory flush failure');
        }
      });
      let error: (Error & { data?: Record<string, unknown> }) | null = null;
      try {
        error = await batch.publish().then(() => null, (e: unknown) => e as Error & { data?: Record<string, unknown> });
      } finally {
        restore();
      }
      expect(error).toMatchObject({ code: 'UNSAFE_FS', message: 'flushing a directory failed: simulated directory flush failure' });
      // The failing flush is the project root's, named '.'.
      expect(error?.data).toMatchObject({ path: '.' });
      expect(fs.readdirSync(out.dir)).toEqual([]);
      // Flushed once by publication and once more after the rollback removed a.json.
      expect(fsyncs.filter(dir => dir === out.dir)).toHaveLength(2);
    });
  });

  it('reports a rollback whose removals could not be flushed to disk', async () => {
    const { _setAtomicWriteAuditHook } = await import('@nullius/shared');
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('undo2/out');
      const batch = new OutputBatch(out);
      batch.json('a.json', { x: 1 });
      const opened = new Map<number, string>();
      let publicationFlushed = false;
      const restore = _setAtomicWriteAuditHook(event => {
        if (event.kind === 'open') opened.set(event.fd, event.path);
        if (event.kind !== 'fsync' || !opened.has(event.fd)) return;
        const dir = opened.get(event.fd)!;
        if (dir === out.dir && !publicationFlushed) {
          publicationFlushed = true;
          return;
        }
        // Fail the project root's flush during publication and every later flush of output_dir.
        if (dir === projectRoot || dir === out.dir) throw new Error('simulated directory flush failure');
      });
      let error: (Error & { code?: string; data?: { unflushed_directories?: string[]; error?: string } }) | null = null;
      try {
        error = await batch.publish().then(() => null, (e: unknown) => e as typeof error);
      } finally {
        restore();
      }
      expect(error?.code).toBe('UNSAFE_FS');
      expect(error?.message).toMatch(/cleanup could not be flushed to disk/);
      expect(error?.data?.unflushed_directories).toEqual(['undo2/out']);
      expect(error?.data?.error).toBe('flushing a directory failed: simulated directory flush failure');
    });
  });

  it('caches a provider response that is absent as null, so the next identical call is a clean cache hit', async () => {
    const { cachedExternalApiJsonCall } = await import('../../src/core/cache/externalApiCache.js');
    await withHepDataRoot(alias, async () => {
      const call = (dir: string) => {
        const batch = new OutputBatch(resolveOutputDir(dir));
        return cachedExternalApiJsonCall({
          batch,
          namespace: 'inspire',
          operation: 'getByDoi',
          request: { doi: '10.1/absent' },
          fetch: async () => undefined,
          validate: response => response ?? null,
        }).then(result => { batch.discard(); return result; });
      };
      expect((await call('first')).cache_hit).toBe(false);
      const second = await call('second');
      expect(second.cache_hit).toBe(true);
      expect(second.response).toBeNull();
    });
  });

  it('publishes a piecewise-written file and leaves no staging file', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('ok');
      const batch = new OutputBatch(out);
      const file = batch.openFile('records.jsonl', 'application/x-ndjson');
      file.write('{"a":1}\n');
      file.write('{"b":2}\n');
      file.finish();
      expect(() => file.write('late')).toThrow(/already finished or discarded/);
      expect(fs.existsSync(path.join(out.dir, 'records.jsonl'))).toBe(false);
      await batch.publish();
      expect(fs.readFileSync(path.join(out.dir, 'records.jsonl'), 'utf-8')).toBe('{"a":1}\n{"b":2}\n');
      expect(temporaryFiles(out.dir)).toEqual([]);
    });
  });
});

describe('a call writes all of its files or none, and never replaces an existing file', () => {
  let tmpDir: string;
  let projectRoot: string;
  let alias: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-batch-')));
    projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function filesUnder(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return (fs.readdirSync(dir, { recursive: true }) as string[])
      .filter(entry => fs.lstatSync(path.join(dir, entry)).isFile())
      .sort();
  }

  it('refuses a second call naming files that exist, before any provider call, and keeps their bytes', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    const args = { project_root: alias, output_dir: 'ids', identifiers: ['123'], artifact_name: 'map.jsonl', meta_artifact_name: 'meta.json' };
    expect((await handleToolCall('hep_inspire_resolve_identifiers', args)).isError).toBeFalsy();
    const before = fs.readFileSync(path.join(projectRoot, 'ids', 'meta.json'), 'utf-8');
    vi.mocked(api.getPaper).mockClear();

    const error = errorOf(await handleToolCall('hep_inspire_resolve_identifiers', args));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toMatch(/already exists/);
    expect(api.getPaper).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(projectRoot, 'ids', 'meta.json'), 'utf-8')).toBe(before);
  });

  it('publishes nothing when the call fails after earlier lookups were recorded', async () => {
    vi.mocked(api.getPaper).mockImplementation(async (recid: string) => (recid === '1' ? { recid: '1' } : null) as any);
    const error = errorOf(await handleToolCall('hep_inspire_resolve_identifiers', {
      project_root: alias, output_dir: 'partial', identifiers: ['1', '2'],
    }));
    expect(error.message).toMatch(/non-object response/);
    expect(api.getPaper).toHaveBeenCalledTimes(2);
    expect(filesUnder(path.join(projectRoot, 'partial'))).toEqual([]);
  });

  it('removes what it already published when a later name is taken at publish time', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('race');
      const batch = new OutputBatch(out);
      batch.json('a.json', { mine: 'a' });
      batch.json('b.json', { mine: 'b' });
      fs.writeFileSync(path.join(out.dir, 'b.json'), 'earlier');
      await expect(batch.publish()).rejects.toThrow(/already exists/);
      expect(filesUnder(out.dir)).toEqual(['b.json']);
      expect(fs.readFileSync(path.join(out.dir, 'b.json'), 'utf-8')).toBe('earlier');
    });
  });

  it('lets only one of two calls that name the same files publish, and the other leaves nothing of its own', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('both');
      const first = new OutputBatch(out);
      const second = new OutputBatch(out);
      first.reserve({ a: 'a.json', b: 'b.json' });
      second.reserve({ a: 'a.json', b: 'b.json' });
      first.json('a.json', { call: 1 });
      first.json('b.json', { call: 1 });
      second.json('a.json', { call: 2 });
      second.json('b.json', { call: 2 });
      await first.publish();
      await expect(second.publish()).rejects.toThrow(/already exists/);
      expect(filesUnder(out.dir)).toEqual(['a.json', 'b.json']);
      for (const name of ['a.json', 'b.json']) {
        expect(JSON.parse(fs.readFileSync(path.join(out.dir, name), 'utf-8'))).toEqual({ call: 1 });
      }
    });
  });

  it('refuses an output file named like the external_api/ record directory, in any case', async () => {
    await withHepDataRoot(alias, async () => {
      const batch = new OutputBatch(resolveOutputDir('recdir'));
      expect(() => batch.json('external_api', { x: 1 })).toThrow(/external_api\/ record directory/);
      expect(() => batch.json('External_API', { x: 1 })).toThrow(/external_api\/ record directory/);
      batch.discard();
      expect(fs.readdirSync(path.join(projectRoot, 'recdir'))).toEqual([]);
    });
  });

  it('refuses two outputs of one call that name the same file', async () => {
    await withHepDataRoot(alias, async () => {
      const batch = new OutputBatch(resolveOutputDir('twice'));
      batch.json('a.json', { x: 1 });
      expect(() => batch.json('A.json', { x: 2 })).toThrow(/name the same file/);
    });
  });

  it('records a request made twice in one call once', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    const result = await handleToolCall('hep_inspire_resolve_identifiers', {
      project_root: alias, output_dir: 'dup', identifiers: ['123', '123'],
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { summary: { matched: number } };
    expect(payload.summary.matched).toBe(2);
    const records = fs.readdirSync(path.join(projectRoot, 'dup', 'external_api'));
    expect(records.filter(name => name.startsWith('external_api_request_inspire_getPaper_'))).toHaveLength(1);
    expect(api.getPaper).toHaveBeenCalledTimes(1);
    const indexName = fs.readdirSync(path.join(projectRoot, 'dup')).find(name => name.startsWith('external_api_calls_'))!;
    const index = JSON.parse(fs.readFileSync(path.join(projectRoot, 'dup', indexName), 'utf-8')) as { calls: unknown[]; stats: { calls_total: number; cache_misses: number } };
    expect(index.calls).toHaveLength(1);
    expect(index.stats).toMatchObject({ calls_total: 1, cache_misses: 1 });
  });
});

describe('identifier resolution does not turn a refused write into a per-identifier failure', () => {
  let tmpDir: string;
  let projectRoot: string;
  let alias: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-ids-')));
    projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails the call when an external API record path is a planted symlink', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    const recordDir = path.join(projectRoot, 'ids', 'external_api');
    fs.mkdirSync(recordDir, { recursive: true });
    const request = describeExternalApiRequest({ namespace: 'inspire', operation: 'getPaper', request: { recid: '123' } }).request_name;
    const victim = path.join(tmpDir, 'victim.json');
    fs.writeFileSync(victim, 'original');
    fs.symlinkSync(victim, path.join(projectRoot, 'ids', request), 'file');

    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(errorOf(result).code).toBe('UNSAFE_FS');
    expect(api.getPaper).not.toHaveBeenCalled();
    expect(fs.readFileSync(victim, 'utf-8')).toBe('original');
  });

  it('fails the call when a cached response is malformed, naming the cache entry, and publishes nothing', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    const first = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(first.isError).toBeFalsy();
    const cacheRoot = path.join(projectRoot, 'artifacts', 'hep-mcp', 'cache', 'external_api_v1', 'inspire', 'getPaper');
    const shard = fs.readdirSync(cacheRoot)[0]!;
    const entryPath = path.join(cacheRoot, shard, fs.readdirSync(path.join(cacheRoot, shard))[0]!);
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(entryPath, JSON.stringify({ ...entry, response: null }));

    const second = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids2', identifiers: ['123'] });
    const error = errorOf(second);
    expect(error.message).toMatch(/Cached external API response is malformed/);
    expect(JSON.stringify(error)).toContain(entryPath);
    expect(filesBelow(path.join(projectRoot, 'ids2'))).toEqual([]);
  });

  it('fails the call when a cache entry is not an entry at all', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    expect((await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] })).isError).toBeFalsy();
    const cacheRoot = path.join(projectRoot, 'artifacts', 'hep-mcp', 'cache', 'external_api_v1', 'inspire', 'getPaper');
    const shard = fs.readdirSync(cacheRoot)[0]!;
    const entryPath = path.join(cacheRoot, shard, fs.readdirSync(path.join(cacheRoot, shard))[0]!);
    fs.writeFileSync(entryPath, 'null');

    const error = errorOf(await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids2', identifiers: ['123'] }));
    // A cache entry this call cannot use is an environment failure.
    expect(error.code).toBe('UNSAFE_FS');
    expect(error.message).toMatch(/not an entry for this request/);
  });

  it('does not cache a malformed fresh response, so a retry asks INSPIRE again', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce(null as any).mockResolvedValueOnce({ recid: '123' } as any);
    expect(errorOf(await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] })).message)
      .toMatch(/non-object response/);
    const retry = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(retry.isError).toBeFalsy();
    expect(api.getPaper).toHaveBeenCalledTimes(2);
    expect((JSON.parse(retry.content[0]!.text) as { summary: { matched: number } }).summary.matched).toBe(1);
  });

  it('does not report a recid lookup as matched when the record carries no recid', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({} as any);
    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { summary: { matched: number; not_found: number }; mapping_path: string };
    expect(payload.summary).toMatchObject({ matched: 0, not_found: 1 });
    const row = JSON.parse(fs.readFileSync(path.join(projectRoot, payload.mapping_path), 'utf-8').trim()) as { status: string; recid?: string };
    expect(row.status).toBe('not_found');
    expect(row.recid).toBeUndefined();
  });

  it('reports an INSPIRE NOT_FOUND as not found, and lists the failed lookup in the call index', async () => {
    vi.mocked(api.getPaper).mockRejectedValue(new McpError('NOT_FOUND', 'no such record'));
    const result = await handleToolCall('hep_inspire_resolve_identifiers', {
      project_root: alias, output_dir: 'ids', identifiers: ['123'], meta_artifact_name: 'meta.json',
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { summary: { not_found: number; errors: number }; artifacts: Array<{ path: string }> };
    expect(payload.summary).toMatchObject({ not_found: 1, errors: 0 });
    const indexPath = payload.artifacts.map(ref => ref.path).find(p => p.includes('external_api_calls_'))!;
    const index = JSON.parse(fs.readFileSync(path.join(projectRoot, indexPath), 'utf-8')) as {
      calls: Array<{ outcome: string; request_path: string; response_path: string | null; error?: { code: string } }>;
      stats: { calls_total: number; failed: number };
    };
    expect(index.stats).toMatchObject({ calls_total: 1, failed: 1 });
    expect(index.calls[0]).toMatchObject({ outcome: 'error', response_path: null, error: { code: 'NOT_FOUND' } });
    expect(fs.existsSync(path.join(projectRoot, index.calls[0]!.request_path))).toBe(true);
  });

  it('fails the call when INSPIRE returns something that is not a record', async () => {
    vi.mocked(api.getPaper).mockResolvedValue(null as any);
    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    const error = errorOf(result);
    // A provider failure, not the caller's, yet it ends the whole call.
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { invalid_provider_answer: true } });
    expect(error.message).toMatch(/non-object response/);
    expect(filesBelow(path.join(projectRoot, 'ids'))).toEqual([]);
  });

  it('ends the whole call on an unusable answer even after another identifier failed only for itself', async () => {
    vi.mocked(api.getPaper).mockImplementation((async (recid: string) => {
      if (recid === '1') throw upstreamError('INSPIRE API error: 503', { status: 503 });
      return { recid: {} };
    }) as any);
    const error = errorOf(await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['1', '2'] }));
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { invalid_provider_answer: true, request: { recid: '2' } } });
    expect(error.message).toMatch(/malformed recid/);
    expect(api.getPaper).toHaveBeenCalledTimes(2);
    expect(filesBelow(path.join(projectRoot, 'ids'))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('reports a cache entry that cannot be read as such, and a cache directory that cannot be made with its path', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    expect((await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] })).isError).toBeFalsy();
    const cacheRoot = path.join(projectRoot, 'artifacts', 'hep-mcp', 'cache', 'external_api_v1', 'inspire', 'getPaper');
    const shardDir = path.join(cacheRoot, fs.readdirSync(cacheRoot)[0]!);
    const entryPath = path.join(shardDir, fs.readdirSync(shardDir)[0]!);
    fs.chmodSync(entryPath, 0o000);
    try {
      const unread = errorOf(await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids2', identifiers: ['123'] }));
      expect(unread).toMatchObject({ code: 'UNSAFE_FS', message: 'Failed to read external API cache entry (fail-fast)', data: { errno: 'EACCES' } });
    } finally {
      fs.chmodSync(entryPath, 0o644);
    }
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '456' } as any);
    // No shard directory may exist, so the new request must create one.
    for (const shard of fs.readdirSync(cacheRoot)) fs.rmSync(path.join(cacheRoot, shard), { recursive: true, force: true });
    fs.chmodSync(cacheRoot, 0o555);
    try {
      const unmade = errorOf(await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids3', identifiers: ['456'] }));
      expect(unmade).toMatchObject({ code: 'UNSAFE_FS', message: 'Failed to resolve external API cache path (fail-fast)', data: { errno: 'EACCES' } });
      expect(String(unmade.data?.cache_dir)).toMatch(new RegExp(`^${cacheRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[0-9a-f]{2}$`));
    } finally {
      fs.chmodSync(cacheRoot, 0o755);
    }
  });

  it.skipIf(process.getuid?.() === 0)('reports a cache that cannot be written as an environment failure, and publishes nothing', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    expect((await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] })).isError).toBeFalsy();
    const cacheRoot = path.join(projectRoot, 'artifacts', 'hep-mcp', 'cache', 'external_api_v1', 'inspire', 'getPaper');
    const shardDir = path.join(cacheRoot, fs.readdirSync(cacheRoot)[0]!);
    for (const entry of fs.readdirSync(shardDir)) fs.rmSync(path.join(shardDir, entry));
    fs.chmodSync(shardDir, 0o555);
    try {
      const error = errorOf(await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids2', identifiers: ['123'] }));
      expect(error.code).toBe('UNSAFE_FS');
      expect(error.message).toMatch(/External API cache write failed/);
      expect(error.data).toMatchObject({ errno: 'EACCES' });
    } finally {
      fs.chmodSync(shardDir, 0o755);
    }
    expect(filesBelow(path.join(projectRoot, 'ids2'))).toEqual([]);
  });

  it('reports a network failure of the lookup per identifier', async () => {
    vi.mocked(api.getPaper).mockRejectedValue(new TypeError('fetch failed'));
    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { summary: { errors: number }; mapping_path: string };
    expect(payload.summary.errors).toBe(1);
  });

  it('still reports an INSPIRE lookup failure per identifier', async () => {
    vi.mocked(api.getPaper).mockRejectedValue(upstreamError('INSPIRE API error: 503', { status: 503 }));
    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(result.isError).toBeFalsy();
    expect((JSON.parse(result.content[0]!.text) as { summary: { errors: number } }).summary.errors).toBe(1);
  });
});

describe('a search export aborts on a malformed search page', () => {
  it('refuses a non-page INSPIRE response as an unusable provider answer and commits no export', async () => {
    vi.resetAllMocks();
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-page-')));
    try {
      const projectRoot = makeProjectRoot(tmpDir);
      const alias = path.join(tmpDir, 'alias');
      fs.symlinkSync(projectRoot, alias, 'dir');
      vi.mocked(api.search).mockResolvedValueOnce(null as any);
      const result = await handleToolCall('hep_inspire_search_export', { project_root: alias, output_dir: 'out', query: 't:x' });
      const error = errorOf(result);
      expect(error.code).toBe('UPSTREAM_ERROR');
      expect(error.data).toMatchObject({ invalid_provider_answer: true });
      expect(error.message).toMatch(/malformed search page/);
      expect(fs.readdirSync(path.join(projectRoot, 'out')).filter(name => name.endsWith('.jsonl') || name.endsWith('.tmp'))).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('inspire_search export mode refuses parameters that do not apply', () => {
  let tmpDir: string;
  let alias: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-search-')));
    const projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    [{ page: 2 }, 'page'],
    [{ review_mode: 'exclude' }, 'review_mode'],
    [{ format: 'markdown' }, 'format'],
  ])('refuses %j with output_dir', async (extra, key) => {
    const result = await handleToolCall('inspire_search', { project_root: alias, output_dir: 'out', query: 't:x', ...extra });
    const error = errorOf(result);
    expect(error.code).toBe('INVALID_PARAMS');
    expect(JSON.stringify(result.content[0]!.text)).toContain(key);
    expect(api.search).not.toHaveBeenCalled();
  });

  it.each([
    [{ output_format: 'json' }, 'output_format'],
    [{ artifact_name: 'a.jsonl' }, 'artifact_name'],
    [{ meta_artifact_name: 'm.json' }, 'meta_artifact_name'],
  ])('refuses the export-only %j without output_dir', async (extra, key) => {
    const result = await handleToolCall('inspire_search', { query: 't:x', ...extra });
    expect(errorOf(result).code).toBe('INVALID_PARAMS');
    expect(result.content[0]!.text).toContain(key);
    expect(api.search).not.toHaveBeenCalled();
  });

  it('accepts an explicit JSON format with output_dir', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 0, papers: [], has_more: false } as any);
    const result = await handleToolCall('inspire_search', { project_root: alias, output_dir: 'out', query: 't:x', format: 'json' });
    expect(result.isError).toBeFalsy();
  });
});

describe('a run_id argument is refused rather than silently dropped', () => {
  it.each([
    ['inspire_search', { query: 't:x', run_id: 'run_abc' }],
    ['hep_inspire_search_export', { query: 't:x', run_id: 'run_abc' }],
    // A destructive tool reports the run_id refusal, not a confirmation request.
    ['hepdata_download', { hepdata_id: 1, run_id: 'run_abc' }],
  ])('%s with run_id', async (tool, args) => {
    vi.resetAllMocks();
    const result = await handleToolCall(tool, args);
    const error = errorOf(result);
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toMatch(/run_id is not accepted/);
    expect(api.search).not.toHaveBeenCalled();
  });
});

describe('round-5 argument, name and response checks', () => {
  let tmpDir: string;
  let alias: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-r5-')));
    const projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    ['inspire_search', { query: 't:x', ouput_dir: 'out' }],
    ['hep_inspire_resolve_identifiers', { output_dir: 'out', identifiers: ['1'], meta_name: 'm.json' }],
    ['hep_inspire_search_export', { output_dir: 'out', query: 't:x', outputformat: 'json' }],
    ['hep_import_from_zotero', { output_dir: 'out', item_keys: ['ABCD1234'], collection: 'x' }],
  ])('%s refuses an undeclared (misspelled) argument before any provider call', async (tool, args) => {
    const result = await handleToolCall(tool, { project_root: alias, ...args });
    expect(errorOf(result).code).toBe('INVALID_PARAMS');
    expect(api.search).not.toHaveBeenCalled();
    expect(api.getPaper).not.toHaveBeenCalled();
  });

  it.each([
    ['hep_inspire_search_export', { query: 't:x', artifact_name: 'same.json', meta_artifact_name: 'same.json' }],
    ['hep_inspire_resolve_identifiers', { identifiers: ['1'], artifact_name: 'same.json', meta_artifact_name: 'same.json' }],
  ])('%s refuses output names that collide', async (tool, args) => {
    const result = await handleToolCall(tool, { project_root: alias, output_dir: 'out', ...args });
    const error = errorOf(result);
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toMatch(/output file names collide/);
    expect(api.search).not.toHaveBeenCalled();
    expect(api.getPaper).not.toHaveBeenCalled();
  });

  it.each([
    ['hep_inspire_search_export', { query: 't:x', artifact_name: 'Result.json', meta_artifact_name: 'result.json' }],
    ['hep_inspire_resolve_identifiers', { identifiers: ['1'], artifact_name: 'r\u00e9sum\u00e9.json', meta_artifact_name: 're\u0301sume\u0301.json' }],
    ['hep_inspire_search_export', { query: 't:x', artifact_name: 'external_api' }],
    ['hep_inspire_resolve_identifiers', { identifiers: ['1'], meta_artifact_name: 'External_API' }],
  ])('%s refuses output names that name the same entry or the external_api directory: %j', async (tool, args) => {
    const result = await handleToolCall(tool, { project_root: alias, output_dir: 'out', ...args });
    expect(errorOf(result).message).toMatch(/output file names collide/);
    expect(api.search).not.toHaveBeenCalled();
    expect(api.getPaper).not.toHaveBeenCalled();
  });

  const VALID_PAPER = { recid: '1', title: 'T', authors: [] };
  const NEXT = 'https://inspirehep.net/api/literature?q=x&size=1&page=2';
  it.each([
    [{ total: 2, papers: [VALID_PAPER], next_url: NEXT }, /has_more is not a boolean/],
    [{ total: 2, papers: [VALID_PAPER], has_more: true }, /has_more without a next_url/],
    [{ total: 2, papers: [VALID_PAPER], has_more: false, next_url: NEXT }, /next_url without has_more/],
  ])('a search export refuses inconsistent pagination %j', async (page, detail) => {
    vi.mocked(api.search).mockResolvedValueOnce(page as any);
    const result = await handleToolCall('hep_inspire_search_export', { project_root: alias, output_dir: 'out', query: 't:x' });
    const error = errorOf(result);
    expect(error.message).toMatch(/malformed search page/);
    expect(error.message).toMatch(detail);
    expect(fs.readdirSync(path.join(tmpDir, 'project', 'out')).filter(name => name.endsWith('.jsonl'))).toEqual([]);
  });

  it.each([
    [{ total: 1, papers: [null], has_more: false }, /papers\[0\]/],
    [{ total: -1, papers: [], has_more: false }, /total/],
    [{ total: 1, papers: [], has_more: 'no' }, /has_more/],
  ])('a search export refuses the malformed page %j', async (page, detail) => {
    vi.mocked(api.search).mockResolvedValueOnce(page as any);
    const result = await handleToolCall('hep_inspire_search_export', { project_root: alias, output_dir: 'out', query: 't:x' });
    const error = errorOf(result);
    expect(error.message).toMatch(/malformed search page/);
    expect(error.message).toMatch(detail);
  });

  it.each([[{}], [[1, 2]], [''], ['12a'], [-3]])('identifier resolution refuses the malformed recid %j', async recid => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid } as any);
    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'out', identifiers: ['123'] });
    const error = errorOf(result);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { invalid_provider_answer: true } });
    expect(error.message).toMatch(/malformed recid/);
  });

  it('a search export refuses a page that points back to an earlier page, and publishes nothing', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 5, papers: [VALID_PAPER], has_more: true, next_url: NEXT } as any);
    vi.mocked(api.searchByUrl).mockResolvedValue({ total: 5, papers: [{ ...VALID_PAPER, recid: '2' }], has_more: true, next_url: NEXT } as any);
    const result = await handleToolCall('hep_inspire_search_export', { project_root: alias, output_dir: 'loop', query: 't:x' });
    const error = errorOf(result);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { invalid_provider_answer: true } });
    expect(error.message).toMatch(/points back to an earlier page/);
    expect(api.searchByUrl).toHaveBeenCalledTimes(1);
    expect(filesBelow(path.join(tmpDir, 'project', 'loop'))).toEqual([]);
  });

  it('a search export refuses more records than the reported total', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 1, papers: [VALID_PAPER, { ...VALID_PAPER, recid: '2' }], has_more: false } as any);
    const result = await handleToolCall('hep_inspire_search_export', { project_root: alias, output_dir: 'over', query: 't:x' });
    const error = errorOf(result);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { invalid_provider_answer: true } });
    expect(error.message).toMatch(/returned 2 records but reported a total of 1/);
  });

  it('inspire_search refuses a file export of more than 10000 records before any provider call', async () => {
    const error = errorOf(await handleToolCall('inspire_search', { project_root: alias, output_dir: 'big', query: 't:x', max_results: 20000 }));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toMatch(/at most max_results=10000/);
    expect(api.search).not.toHaveBeenCalled();
  });

  it('hep_inspire_search_export refuses max_results above 10000 instead of using the default', async () => {
    const error = errorOf(await handleToolCall('hep_inspire_search_export', { project_root: alias, output_dir: 'big', query: 't:x', max_results: 20000 }));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(api.search).not.toHaveBeenCalled();
  });

  it('identifier resolution refuses a blank identifier instead of dropping it', async () => {
    const error = errorOf(await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'out', identifiers: ['1', '  '] }));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toMatch(/must not be blank/);
    expect(api.getPaper).not.toHaveBeenCalled();
  });

  async function exportResult(args: Record<string, unknown>) {
    const result = await handleToolCall('hep_inspire_search_export', { project_root: alias, query: 't:x', ...args });
    expect(result.isError, result.content[0]!.text).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as {
      meta_path: string;
      summary: { total: number; exported: number; has_more: boolean; warnings: string[] };
    };
    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, 'project', payload.meta_path), 'utf-8')) as {
      next_url?: string; total: number; artifacts: { diagnostics_path: string };
    };
    const diagnostics = JSON.parse(fs.readFileSync(path.join(tmpDir, 'project', meta.artifacts.diagnostics_path), 'utf-8')) as {
      hits: Array<{ key: string }>; warnings: Array<{ code: string }>;
    };
    return { summary: payload.summary, meta, diagnostics };
  }
  const P = (recid: string) => ({ ...VALID_PAPER, recid });

  it('a search export cut inside a page gives no continuation URL that would skip the rest of the page', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 3, papers: [P('1'), P('2'), P('3')], has_more: true, next_url: NEXT } as any);
    const { summary, meta, diagnostics } = await exportResult({ output_dir: 'cut', max_results: 2 });
    expect(summary).toMatchObject({ total: 3, exported: 2, has_more: true });
    expect(diagnostics.hits.map(hit => hit.key)).toEqual(['inspire.search_export.max_results']);
    expect(meta.next_url).toBeUndefined();
    // One warning, for the one cause: max_results cut a page.
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/stopped at max_results=2 inside a page .*no continuation URL.*rerun with a larger max_results/);
  });

  it('a search export cut inside the last page still reports that more records exist', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 3, papers: [P('1'), P('2'), P('3')], has_more: false } as any);
    const { summary, meta, diagnostics } = await exportResult({ output_dir: 'cut-last', max_results: 2 });
    expect(summary).toMatchObject({ total: 3, exported: 2, has_more: true });
    expect(diagnostics.hits.map(hit => hit.key)).toEqual(['inspire.search_export.max_results']);
    expect(meta.next_url).toBeUndefined();
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/stopped at max_results=2 inside a page/);
  });

  it('a search export that stops on a page boundary gives the next page as its continuation', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 4, papers: [P('1'), P('2')], has_more: true, next_url: NEXT } as any);
    const { summary, meta, diagnostics } = await exportResult({ output_dir: 'edge', max_results: 2 });
    expect(summary).toMatchObject({ total: 4, exported: 2, has_more: true });
    expect(diagnostics.hits.map(hit => hit.key)).toEqual(['inspire.search_export.max_results']);
    expect(meta.next_url).toBe(NEXT);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/stopped at max_results=2 \(total=4, exported=2\); next_url continues it/);
  });

  it('a search export stopped by max_results where INSPIRE still offers a next page continues it, even if the total says no more', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 2, papers: [P('1'), P('2')], has_more: true, next_url: NEXT } as any);
    const { summary, meta, diagnostics } = await exportResult({ output_dir: 'edge-total', max_results: 2 });
    expect(summary).toMatchObject({ total: 2, exported: 2, has_more: true });
    expect(meta.next_url).toBe(NEXT);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/stopped at max_results=2 \(total=2, exported=2\); next_url continues it/);
    expect(diagnostics.hits.map(hit => hit.key)).toEqual(['inspire.search_export.max_results']);
  });

  it('a search export whose pages end before INSPIRE\'s total says so once, and does not advise a rerun', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 5, papers: [P('1'), P('2')], has_more: false } as any);
    const { summary, meta, diagnostics } = await exportResult({ output_dir: 'short' });
    expect(summary).toMatchObject({ total: 5, exported: 2, has_more: true });
    // No max_results limit was hit: the diagnostics record the pages ending early instead.
    expect(diagnostics.hits).toEqual([]);
    expect(diagnostics.warnings.map(w => w.code)).toEqual(['provider_pages_ended_early']);
    expect(meta.next_url).toBeUndefined();
    expect(summary.warnings).toEqual([
      'INSPIRE reported total=5, but its pages ended after 2 records (its last page said no more follow); the remaining records were not returned by this export, and a later export may see a different set.',
    ]);
  });

  it('a search export that reaches max_results exactly where everything INSPIRE has ends gives no warning', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 2, papers: [P('1'), P('2')], has_more: false } as any);
    const { summary, meta, diagnostics } = await exportResult({ output_dir: 'complete-exact', max_results: 2 });
    expect(summary).toMatchObject({ total: 2, exported: 2, has_more: false });
    expect(meta.next_url).toBeUndefined();
    expect(summary.warnings).toEqual([]);
    expect(diagnostics.hits).toEqual([]);
  });

  it('a search export names its cause first, ahead of INSPIRE\'s own page warnings', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 5, papers: [P('1'), P('2')], has_more: false, warning: 'an INSPIRE page notice' } as any);
    const { summary } = await exportResult({ output_dir: 'cause-first' });
    expect(summary.warnings[0]).toMatch(/its pages ended after 2 records/);
    expect(summary.warnings).toContain('an INSPIRE page notice');
  });

  it('a search export whose total grew while its pages ended early names the largest total', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 3, papers: [P('1')], has_more: true, next_url: NEXT } as any);
    vi.mocked(api.searchByUrl).mockResolvedValueOnce({ total: 5, papers: [P('2')], has_more: false } as any);
    const { summary } = await exportResult({ output_dir: 'grow-short' });
    expect(summary).toMatchObject({ total: 5, exported: 2, has_more: true });
    expect(summary.warnings).toEqual([
      'INSPIRE reported total=5, but its pages ended after 2 records (its last page said no more follow); the remaining records were not returned by this export, and a later export may see a different set.',
    ]);
  });

  it('a search export cut inside a page names max_results as the cause, even if the pages would end before the total', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 5, papers: [P('1'), P('2'), P('3')], has_more: false } as any);
    const { summary, diagnostics } = await exportResult({ output_dir: 'cut-short', max_results: 2 });
    expect(diagnostics.hits.map(hit => hit.key)).toEqual(['inspire.search_export.max_results']);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/stopped at max_results=2 inside a page/);
  });

  it('a search export that reaches max_results exactly where INSPIRE\'s pages end blames the pages, not max_results', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 5, papers: [P('1'), P('2')], has_more: false } as any);
    const { summary, diagnostics } = await exportResult({ output_dir: 'short-exact', max_results: 2 });
    expect(diagnostics.hits).toEqual([]);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/its pages ended after 2 records/);
  });

  it('a search export reports the largest total INSPIRE gave, and every page\'s warning', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 1, papers: [P('1')], has_more: true, next_url: NEXT } as any);
    vi.mocked(api.searchByUrl).mockResolvedValueOnce({ total: 2, papers: [P('2')], has_more: false, warning: 'later-page limit notice' } as any);
    const { summary, meta } = await exportResult({ output_dir: 'grow' });
    expect(summary).toMatchObject({ total: 2, exported: 2, has_more: false });
    expect(meta.total).toBe(2);
    expect(summary.warnings).toContain('later-page limit notice');
  });

  it('a search export refuses an empty page that claims more records follow', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 5, papers: [P('1')], has_more: true, next_url: NEXT } as any);
    vi.mocked(api.searchByUrl).mockResolvedValueOnce({ total: 5, papers: [], has_more: true, next_url: `${NEXT}&x=1` } as any);
    const result = await handleToolCall('hep_inspire_search_export', { project_root: alias, output_dir: 'empty', query: 't:x' });
    const error = errorOf(result);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { invalid_provider_answer: true } });
    expect(error.message).toMatch(/empty page claims that more records follow/);
  });

  it('a search export counts records before max_results cuts a page', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 1, papers: [P('1'), P('2')], has_more: false } as any);
    const result = await handleToolCall('hep_inspire_search_export', { project_root: alias, output_dir: 'hidden', query: 't:x', max_results: 1 });
    const error = errorOf(result);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { invalid_provider_answer: true } });
    expect(error.message).toMatch(/returned 2 records but reported a total of 1/);
  });

  it('the response record keeps INSPIRE\'s raw response, also when it carries no recid', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce({ recid: '123', title: 'Raw title', extra: { kept: true } } as any);
    vi.mocked(api.getPaper).mockResolvedValueOnce({ title: 'No recid here' } as any);
    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'raw', identifiers: ['123', '456'] });
    expect(result.isError).toBeFalsy();
    const dir = path.join(tmpDir, 'project', 'raw', 'external_api');
    const responses = fs.readdirSync(dir).filter(name => name.startsWith('external_api_response_'))
      .map(name => (JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as { response: unknown }).response);
    expect(responses).toEqual(expect.arrayContaining([
      { recid: '123', title: 'Raw title', extra: { kept: true } },
      { title: 'No recid here' },
    ]));
  });

  it('refuses a cache entry recorded for another request, even with this request\'s hash', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    expect((await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'c1', identifiers: ['123'] })).isError).toBeFalsy();
    const cacheRoot = path.join(tmpDir, 'project', 'artifacts', 'hep-mcp', 'cache', 'external_api_v1', 'inspire', 'getPaper');
    const shard = fs.readdirSync(cacheRoot)[0]!;
    const entryPath = path.join(cacheRoot, shard, fs.readdirSync(path.join(cacheRoot, shard))[0]!);
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(entryPath, JSON.stringify({ ...entry, request: { recid: '999' } }));
    const error = errorOf(await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'c2', identifiers: ['123'] }));
    expect(error.message).toMatch(/not an entry for this request/);
  });

  it('refuses a taken response-record name before asking INSPIRE', async () => {
    const names = describeExternalApiRequest({ namespace: 'inspire', operation: 'getPaper', request: { recid: '123' } });
    fs.mkdirSync(path.join(tmpDir, 'project', 'taken', 'external_api'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'project', 'taken', names.response_name), 'earlier');
    const error = errorOf(await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'taken', identifiers: ['123'] }));
    expect(error.message).toMatch(/already exists/);
    expect(api.getPaper).not.toHaveBeenCalled();
  });

  it('makes a request repeated concurrently within one call once, and records it once', async () => {
    const { cachedExternalApiJsonCall } = await import('../../src/core/cache/externalApiCache.js');
    await withHepDataRoot(alias, async () => {
      const batch = new OutputBatch(resolveOutputDir('shared'));
      let fetches = 0;
      const call = () => cachedExternalApiJsonCall({
        batch,
        namespace: 'inspire',
        operation: 'getByDoi',
        request: { doi: '10.1/x' },
        fetch: async () => { fetches += 1; await new Promise(resolve => setTimeout(resolve, 20)); return { recid: String(fetches) }; },
        validate: response => response as { recid: string },
      });
      const [first, second] = await Promise.all([call(), call()]);
      expect(fetches).toBe(1);
      expect(second.response).toEqual(first.response);
      await batch.publish();
      const records = fs.readdirSync(path.join(tmpDir, 'project', 'shared', 'external_api'));
      expect(records.filter(name => name.startsWith('external_api_response_'))).toHaveLength(1);
    });
  });

  it('identifier resolution accepts a numeric recid as its digit string', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: 456 } as any);
    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'out', identifiers: ['123'] });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { mapping_path: string };
    const line = JSON.parse(fs.readFileSync(path.join(tmpDir, 'project', payload.mapping_path), 'utf-8').trim()) as { recid: string };
    expect(line.recid).toBe('456');
  });
});
