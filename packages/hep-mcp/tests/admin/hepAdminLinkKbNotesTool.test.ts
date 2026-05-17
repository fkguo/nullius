/**
 * MCP-tool-level tests for hep_admin_link_kb_notes. The tool is strictly
 * read-only, so the dual-key/_confirm gating tests that apply to migrate /
 * prune / import do NOT apply here. Verifies registration, handler-level
 * project_root validation, and the read-only contract.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getToolSpec } from '../../src/tools/registry/shared.js';
import { HEP_ADMIN_LINK_KB_NOTES } from '../../src/tool-names.js';

describe('hep_admin_link_kb_notes MCP tool', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'kblink-tool-'));
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  });

  function getHandler() {
    const spec = getToolSpec(HEP_ADMIN_LINK_KB_NOTES);
    if (!spec) throw new Error('tool not registered');
    return spec.handler;
  }

  it('is registered with riskLevel=read', () => {
    const spec = getToolSpec(HEP_ADMIN_LINK_KB_NOTES);
    expect(spec).toBeDefined();
    expect(spec!.riskLevel).toBe('read');
  });

  it('rejects calls with no project_root (regression for withProjectRootContract optional override)', async () => {
    const handler = getHandler();
    await expect(handler({}, {})).rejects.toThrow(/project_root/);
  });

  it('rejects calls with whitespace-only project_root', async () => {
    const handler = getHandler();
    await expect(handler({ project_root: '   ' }, {})).rejects.toThrow(/project_root/);
  });

  it('returns a structured read-only report for an empty project', async () => {
    const handler = getHandler();
    const result = (await handler({ project_root: tmpProject }, {})) as {
      schema_version: number;
      summary: { total_papers: number; total_kb_notes: number };
      kb_dir_source: string;
    };
    expect(result.schema_version).toBe(1);
    expect(result.summary.total_papers).toBe(0);
    expect(result.summary.total_kb_notes).toBe(0);
    expect(result.kb_dir_source).toBe('missing');
  });

  it('silently strips smuggled apply/_confirm fields (Zod strip mode; read-only contract)', async () => {
    // The schema deliberately omits `apply` and `_confirm`. Zod default strip
    // mode drops unknown fields, so a smuggled `apply: true` is a no-op. This
    // test locks in the read-only contract against future schema drift — if
    // someone ever adds an `apply` field to the schema without updating the
    // pure function, this assertion will start failing.
    const handler = getHandler();
    fs.mkdirSync(path.join(tmpProject, 'artifacts', 'hep-mcp', 'projects', 'p1', 'papers', 'paper1'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, 'artifacts', 'hep-mcp', 'projects', 'p1', 'papers', 'paper1', 'paper.json'),
      JSON.stringify({ version: 1, source: { kind: 'latex', identifier: 'arxiv:2401.09012', main_tex: 'main.tex' } }),
    );
    const before = fs.readFileSync(
      path.join(tmpProject, 'artifacts', 'hep-mcp', 'projects', 'p1', 'papers', 'paper1', 'paper.json'),
      'utf-8',
    );
    const result = (await handler(
      { project_root: tmpProject, apply: true, _confirm: true, overwrite: true } as Record<string, unknown>,
      {},
    )) as { schema_version: number; summary: { total_papers: number } };
    expect(result.schema_version).toBe(1);
    expect(result.summary.total_papers).toBe(1);
    // paper.json must be byte-identical after the call.
    const after = fs.readFileSync(
      path.join(tmpProject, 'artifacts', 'hep-mcp', 'projects', 'p1', 'papers', 'paper1', 'paper.json'),
      'utf-8',
    );
    expect(after).toBe(before);
  });

  it('honours explicit kb_dir override through the MCP boundary', async () => {
    const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'kblink-explicit-'));
    try {
      // Plant a single KB note in the explicit dir so the response can be
      // checked against the input path round-trip.
      fs.writeFileSync(path.join(explicit, 'note.md'), '# KB note\n\nRefKey: arxiv-2401.09012\n');
      const handler = getHandler();
      const result = (await handler(
        { project_root: tmpProject, kb_dir: explicit },
        {},
      )) as { kb_dir: string; kb_dir_source: string; summary: { total_kb_notes: number } };
      expect(result.kb_dir).toBe(explicit);
      expect(result.kb_dir_source).toBe('explicit');
      expect(result.summary.total_kb_notes).toBe(1);
    } finally {
      fs.rmSync(explicit, { recursive: true, force: true });
    }
  });
});
