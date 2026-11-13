import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '@nullius/orchestrator';
import { writeHarnessInvocationMarker } from '@nullius/shared';
import { ProjectAdapter } from '../src/adapter.js';
import type { Context } from '../src/policy.js';
import type { Result } from '../src/result.js';

const roots: string[] = [];
function body(result: Result): Record<string, any> {
  const block = result.content.find(item => item.type === 'text');
  if (!block || block.type !== 'text') throw new Error('Missing result text');
  return JSON.parse(block.text);
}
async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-source-tools-')));
  roots.push(root);
  expect(await runCli(['--project-root', root, 'init', '--mode', 'engine', '--no-git'], {
    cwd: root, stdout: () => {}, stderr: () => {},
  })).toBe(0);
  fs.writeFileSync(path.join(root, 'notes.tex'), 'Definition\ncoupling = 2\nAn unresolved assumption\n');
  const adapter = new ProjectAdapter(root);
  const status = await adapter.call('project_cli', { action: 'status' });
  expect(status.isError, JSON.stringify(status)).not.toBe(true);
  return { root, adapter };
}
beforeEach(() => { vi.stubEnv('NULLIUS_HARNESS_VERIFY', 'on'); vi.stubEnv('NULLIUS_CONTROL_DIR', ''); });
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('portable source tools and delegated execution', () => {
  it('advertises actual source tools and capabilities without requiring model sampling', async () => {
    const { adapter } = await fixture();
    const capabilities = body(await adapter.call('project_capabilities', {}));
    expect(capabilities.sampling).toBe('unavailable');
    expect(capabilities.sampling_tool_calls).toBe('unavailable');
    expect(capabilities.tools).toEqual(adapter.listTools().map(tool => tool.name));
    expect(capabilities.research_tools).toMatchObject({
      file_search: { method: 'literal_text', semantic_search: false },
      text_read: { hash_bound_continuation: true },
      document_read: { ocr: 'unavailable' },
    });
    const result = await adapter.call('project_file_search', { query: 'coupling', paths: ['notes.tex'] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const match = body(result).matches[0];
    const read = await adapter.call('project_text_read', {
      path: match.path, start_line: match.line_number, max_lines: 1, expected_sha256: match.sha256,
    });
    expect(body(read).lines[0].text).toBe('coupling = 2');
  });

  it('distinguishes basic sampling from the tool-calling capability before execution', async () => {
    const { root, adapter } = await fixture();
    const createMessage = vi.fn<NonNullable<Context['createMessage']>>();
    const host = { createMessage, samplingTools: false };
    expect(body(await adapter.call('project_capabilities', {}, host))).toMatchObject({
      sampling: 'available_while_connected', sampling_tool_calls: 'unavailable',
    });
    const result = await adapter.call('orch_run_execute_agent', {
      _confirm: true, run_id: 'unsupported-source-tools', model: 'fixture',
      messages: [{ role: 'user', content: 'Read source.' }],
      tools: [{ name: 'project_text_read', input_schema: {} }],
    }, host);
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ status: 'unavailable' });
    expect(body(result).reason).toContain('sampling.tools');
    const followups = await adapter.call('orch_run_progress_followups', {
      _confirm: true, run_id: 'unsupported-source-tools', run_dir: path.join(root, 'artifacts/runs/unsupported-source-tools'),
    }, host);
    expect(followups.isError).toBe(true);
    expect(body(followups)).toMatchObject({ status: 'unavailable' });
    expect(body(followups).reason).toContain('sampling.tools');
    expect(createMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(false);
  });

  it('lets a delegated model search then read actual source through canonical tool definitions', async () => {
    const { root, adapter } = await fixture();
    let turns = 0;
    let hit: Record<string, any> | undefined;
    const seen: string[] = [];
    const createMessage: NonNullable<Context['createMessage']> = async params => {
      turns += 1;
      const transcript = JSON.stringify(params.messages);
      seen.push(transcript);
      expect(JSON.stringify(params.tools)).not.toContain('caller_forged_schema');
      if (turns === 1) return { model: 'fixture', stopReason: 'tool_use', content: {
        type: 'tool_use', id: 'find-source', name: 'project_file_search', input: { query: 'coupling', paths: ['notes.tex'] },
      } };
      const last = params.messages.at(-1)!;
      const blocks = Array.isArray(last.content) ? last.content : [last.content];
      const toolResult = blocks.find(block => block.type === 'tool_result');
      if (!toolResult || toolResult.type !== 'tool_result') throw new Error('Expected real tool output');
      const output = JSON.parse(toolResult.content.map(item => item.text).join('\n'));
      if (turns === 2) {
        hit = output.matches[0];
        return { model: 'fixture', stopReason: 'tool_use', content: {
          type: 'tool_use', id: 'read-source', name: 'project_text_read',
          input: { path: hit!.path, start_line: hit!.line_number, max_lines: 1, expected_sha256: hit!.sha256 },
        } };
      }
      expect(output.lines[0].text).toBe('coupling = 2');
      expect(output.sha256).toBe(hit!.sha256);
      return { model: 'fixture', stopReason: 'end_turn', content: { type: 'text', text: 'Source inspected.' } };
    };
    const result = await adapter.call('orch_run_execute_agent', {
      _confirm: true, run_id: 'source-agent', model: 'fixture', max_turns: 3,
      messages: [{ role: 'user', content: 'Locate the coupling definition in notes.tex and read it.' }],
      tools: ['project_file_search', 'project_text_read'].map(name => ({
        name, description: 'caller_forged_schema', input_schema: { type: 'object', caller_forged_schema: true },
      })),
    }, { createMessage });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(turns).toBe(3);
    expect(seen[2]).toContain('coupling = 2');
    expect(body(result).events.filter((event: any) => event.type === 'tool_call').map((event: any) => event.name))
      .toEqual(['project_file_search', 'project_text_read']);
    expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(false);
  });

  it('checks the current harness anchor for source reads, including inside a delegate', async () => {
    const { root, adapter } = await fixture();
    let turns = 0;
    const createMessage: NonNullable<Context['createMessage']> = async params => {
      turns += 1;
      if (turns === 1) {
        writeHarnessInvocationMarker(root, { now: new Date('2000-01-01T00:00:00Z') });
        return { model: 'fixture', stopReason: 'tool_use', content: {
          type: 'tool_use', id: 'stale-read', name: 'project_text_read', input: { path: 'notes.tex' },
        } };
      }
      expect(JSON.stringify(params.messages)).toContain('HARNESS_INVOCATION_REQUIRED');
      expect(JSON.stringify(params.messages)).not.toContain('coupling = 2');
      return { model: 'fixture', stopReason: 'end_turn', content: { type: 'text', text: 'Read is blocked.' } };
    };
    const result = await adapter.call('orch_run_execute_agent', {
      _confirm: true, run_id: 'stale-source', model: 'fixture', max_turns: 2,
      messages: [{ role: 'user', content: 'Read notes.tex.' }],
      tools: [{ name: 'project_text_read', input_schema: {} }],
    }, { createMessage });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(turns).toBe(2);
    for (const [name, args] of [
      ['project_file_search', { query: 'coupling', paths: ['notes.tex'] }],
      ['project_text_read', { path: 'notes.tex' }],
      ['project_document_read', { path: 'notes.tex' }],
    ] as const) {
      const blocked = await adapter.call(name, args);
      expect(blocked.isError).toBe(true);
      expect(body(blocked).error.code).toBe('HARNESS_INVOCATION_REQUIRED');
    }
  });

  it('does not silently drop PDF images in a text-only delegated bridge', async () => {
    const { adapter } = await fixture();
    let turns = 0;
    const createMessage: NonNullable<Context['createMessage']> = async params => {
      if (++turns === 1) return { model: 'fixture', stopReason: 'tool_use', content: {
        type: 'tool_use', id: 'visual-read', name: 'project_document_read', input: { path: 'figure.pdf', include_images: true },
      } };
      expect(JSON.stringify(params.messages)).toContain('vision-capable host');
      expect(JSON.stringify(params.messages)).toContain('unavailable');
      return { model: 'fixture', stopReason: 'end_turn', content: { type: 'text', text: 'Host visual inspection needed.' } };
    };
    const result = await adapter.call('orch_run_execute_agent', {
      _confirm: true, run_id: 'visual-source', model: 'fixture', max_turns: 2,
      messages: [{ role: 'user', content: 'Inspect the PDF image.' }],
      tools: [{ name: 'project_document_read', input_schema: {} }],
    }, { createMessage });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(turns).toBe(2);
  });

  it('keeps writes, recursive delegation and arbitrary host tools out of a delegated tool list', async () => {
    const { adapter } = await fixture();
    for (const name of ['project_file_write', 'project_cli', 'orch_run_execute_agent', 'arbitrary_shell']) {
      const result = await adapter.call('orch_run_execute_agent', {
        _confirm: true, run_id: 'bad-tool', model: 'fixture',
        messages: [{ role: 'user', content: 'Untrusted tool definition.' }],
        tools: [{ name, input_schema: {} }],
      });
      expect(result.isError, name).toBe(true);
    }
  });
});
