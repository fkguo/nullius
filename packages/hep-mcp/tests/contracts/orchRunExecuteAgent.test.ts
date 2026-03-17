import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('@autoresearch/zotero-mcp/tooling', () => ({
  TOOL_SPECS: [],
}));
vi.mock('../../src/core/zotero/tools.js', () => ({
  hepImportFromZotero: vi.fn(),
}));

import { handleToolCall } from '../../src/tools/index.js';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agent-runtime-'));
  tmpDirs.push(dir);
  return dir;
}

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function ledgerLineCount(projectRoot: string): number {
  const ledgerPath = path.join(projectRoot, '.autoresearch', 'ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) return 0;
  return fs.readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean).length;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('orch_run_execute_agent', () => {
  it('requires _confirm before executing the destructive shared runtime surface', async () => {
    const projectRoot = makeTmpDir();
    const res = await handleToolCall(
      'orch_run_execute_agent',
      {
        project_root: projectRoot,
        run_id: 'run-live',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
      },
      'full',
    );

    expect(res.isError).toBe(true);
    const payload = extractPayload(res);
    const error = payload.error as {
      code?: string;
      data?: { tool?: string; next_actions?: Array<{ args?: { _confirm?: boolean } }> };
    };
    expect(error.code).toBe('CONFIRMATION_REQUIRED');
    expect(error.data?.tool).toBe('orch_run_execute_agent');
    expect(error.data?.next_actions?.[0]?.args?._confirm).toBe(true);
  });

  it('persists a manifest and skips completed tool_use blocks on re-entry through the shared tool surface', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-live', workflow_id: 'runtime' },
      'full',
    );
    const ledgerAfterCreate = ledgerLineCount(projectRoot);
    const runtimeArgs = {
      _confirm: true,
      project_root: projectRoot,
      run_id: 'run-live',
      model: 'claude-test',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tu_pause',
          name: 'orch_run_pause',
          input: { project_root: projectRoot, note: 'pause from runtime test' },
        }],
      }],
      tools: [{
        name: 'orch_run_pause',
        description: 'Pause the current orchestrator run.',
        input_schema: {
          type: 'object',
          properties: {
            project_root: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['project_root'],
        },
      }],
    };

    const first = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      runtimeArgs,
      'full',
      {
        createMessage: async () => {
          throw new Error('interrupt after checkpoint');
        },
      },
    ));
    expect(first.last_completed_step).toBe('tu_pause');
    expect(first.skipped_step_ids).toEqual([]);
    expect((first.events as Array<{ type: string }>).some(event => event.type === 'error')).toBe(true);
    const manifestPath = path.join(projectRoot, 'artifacts', 'runs', 'run-live', 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(ledgerLineCount(projectRoot)).toBe(ledgerAfterCreate + 1);

    const second = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      runtimeArgs,
      'full',
      {
        createMessage: async () => ({
          model: 'claude-test',
          role: 'assistant',
          content: { type: 'text', text: 'resume completed' },
          stopReason: 'endTurn',
        }),
      },
    ));
    expect(second.resume_from).toBe('tu_pause');
    expect(second.resumed).toBe(true);
    expect(second.skipped_step_ids).toEqual(['tu_pause']);
    expect(second.last_completed_step).toBe('tu_pause');
    expect((second.events as Array<{ type: string }>).some(event => event.type === 'error')).toBe(false);
    expect((second.events as Array<{ type: string; stopReason?: string }>).some(event => event.type === 'done')).toBe(true);
    expect(ledgerLineCount(projectRoot)).toBe(ledgerAfterCreate + 1);
  });
});
