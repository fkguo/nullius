import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, CreateMessageRequestSchema, type SamplingMessage } from '@modelcontextprotocol/sdk/types.js';
import { runCli } from '@nullius/orchestrator';
import { describe, expect, it } from 'vitest';

const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const source = 'Definition\n𝛼 coupling = 2\nAn unresolved assumption\n';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type SearchHit = { path: string; sha256: string; line_number: number; column: number };
type SourceText = { sha256: string; lines: Array<{ line_number: number; column_start: number; text: string; complete: boolean }> };
type RuntimeOutput = { events: Array<{ type: string; name?: string; stopReason?: string }> };

function resultBody<T>(raw: unknown): T {
  const result = CallToolResultSchema.parse(raw);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const text = result.content.find(block => block.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Missing MCP result metadata.');
  return JSON.parse(text.text) as T;
}

function toolResult(messages: SamplingMessage[], callId: string) {
  const message = messages.at(-1);
  if (!message) throw new Error('Missing sampling transcript.');
  const blocks = Array.isArray(message.content) ? message.content : [message.content];
  const result = blocks.find(block => block.type === 'tool_result' && block.toolUseId === callId);
  if (!result || result.type !== 'tool_result') throw new Error(`Missing actual result for ${callId}.`);
  return result;
}

function toolOutput<T>(messages: SamplingMessage[], callId: string): T {
  const result = toolResult(messages, callId);
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  return JSON.parse(text) as T;
}

async function fixture(withToolSampling = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-source-stdio-')));
  const client = new Client({ name: 'nullius-source-stdio-fixture', version: '1.0.0' }, {
    capabilities: { sampling: withToolSampling ? { tools: {} } : {} },
  });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [serverPath], cwd: root,
    env: { ...env, NULLIUS_PROJECT_ROOT: root, NULLIUS_HARNESS_VERIFY: 'on', NULLIUS_CONTROL_DIR: '' }, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const close = async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    expect(await runCli(['--project-root', root, 'init', '--mode', 'engine', '--no-git'], {
      cwd: root, stdout: () => {}, stderr: () => {},
    })).toBe(0);
    fs.writeFileSync(path.join(root, 'notes.tex'), source);
    await client.connect(transport);
    // Exercise the actual public anchor path; never forge a marker for this fixture.
    const status = resultBody<{ exit_code: number }>(await client.callTool({ name: 'project_cli', arguments: { action: 'status' } }));
    expect(status.exit_code, stderr).toBe(0);
    return { root, client, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** One actual PDF page, including its cross-reference table; Poppler supplies the parser and renderer. */
function onePagePdf(text: string): Buffer {
  const escaped = text.replace(/[\\()]/g, character => `\\${character}`);
  const stream = `BT /F1 16 Tf 20 100 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let bytes = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(bytes));
    bytes += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(bytes);
  bytes += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${bytes}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`);
}

describe('source tools over real MCP stdio sampling', () => {
  it('reports basic sampling separately and refuses tool delegation before model or runtime dispatch', async () => {
    const { root, client, close } = await fixture(false);
    let modelCalls = 0;
    try {
      client.setRequestHandler(CreateMessageRequestSchema, async () => {
        modelCalls += 1;
        return { role: 'assistant', model: 'fixture', stopReason: 'endTurn', content: { type: 'text', text: 'This model must not be called.' } };
      });
      const capabilities = resultBody<{ sampling: string; sampling_tool_calls: string }>(
        await client.callTool({ name: 'project_capabilities', arguments: {} }),
      );
      expect(capabilities).toMatchObject({ sampling: 'available_while_connected', sampling_tool_calls: 'unavailable' });
      const refused = CallToolResultSchema.parse(await client.callTool({
        name: 'orch_run_execute_agent', arguments: {
          _confirm: true, run_id: 'unsupported-tool-sampling', model: 'fixture',
          messages: [{ role: 'user', content: 'Read notes.tex.' }],
          tools: [{ name: 'project_text_read', input_schema: {} }],
        },
      }));
      expect(refused.isError).toBe(true);
      const message = refused.content.find(block => block.type === 'text');
      if (!message || message.type !== 'text') throw new Error('Missing capability refusal.');
      expect(JSON.parse(message.text)).toMatchObject({ status: 'unavailable' });
      expect(message.text).toContain('sampling.tools');
      const followups = CallToolResultSchema.parse(await client.callTool({
        name: 'orch_run_progress_followups', arguments: {
          _confirm: true, run_id: 'unsupported-tool-sampling', run_dir: path.join(root, 'artifacts/runs/unsupported-tool-sampling'),
        },
      }));
      expect(followups.isError).toBe(true);
      expect(followups.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('sampling.tools') }),
      ]));
      expect(modelCalls).toBe(0);
      expect(fs.existsSync(path.join(root, 'artifacts/delegated-runs/direct/unsupported-tool-sampling/manifest.json'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(false);
    } finally { await close(); }
  });

  it.each(['direct', 'team'] as const)('executes canonical toolUse → search → source read → endTurn through the %s bridge', async mode => {
    const { root, client, close } = await fixture();
    let turns = 0;
    let hit: SearchHit | undefined;
    let observed: SourceText | undefined;
    try {
      client.setRequestHandler(CreateMessageRequestSchema, async request => {
        turns += 1;
        expect(JSON.stringify(request.params.tools)).not.toContain('caller_forged_schema');
        if (turns === 1) return {
          role: 'assistant', model: 'fixture', stopReason: 'toolUse',
          content: { type: 'tool_use', id: 'search-original', name: 'project_file_search', input: { query: 'coupling', paths: ['notes.tex'] } },
        };
        if (turns === 2) {
          expect(toolResult(request.params.messages, 'search-original')).not.toHaveProperty('isError');
          const output = toolOutput<{ matches: SearchHit[]; coverage: { complete: boolean } }>(request.params.messages, 'search-original');
          expect(output.coverage.complete).toBe(true);
          expect(output.matches).toHaveLength(1);
          hit = output.matches[0];
          expect(hit).toMatchObject({ path: 'notes.tex', line_number: 2, column: 3, sha256: hash(source) });
          return {
            role: 'assistant', model: 'fixture', stopReason: 'toolUse',
            content: { type: 'tool_use', id: 'read-original', name: 'project_text_read', input: {
              path: hit!.path, start_line: hit!.line_number, start_column: hit!.column, max_lines: 1, expected_sha256: hit!.sha256,
            } },
          };
        }
        if (turns !== 3) throw new Error('Unexpected extra sampling turn.');
        expect(toolResult(request.params.messages, 'read-original')).not.toHaveProperty('isError');
        observed = toolOutput<SourceText>(request.params.messages, 'read-original');
        expect(observed).toMatchObject({ sha256: hash(source), lines: [{ line_number: 2, column_start: 3, text: 'coupling = 2', complete: true }] });
        return { role: 'assistant', model: 'fixture', stopReason: 'endTurn', content: { type: 'text', text: 'The original source defines coupling = 2.' } };
      });
      const result = resultBody<RuntimeOutput>(await client.callTool({
        name: 'orch_run_execute_agent',
        arguments: {
          _confirm: true, run_id: 'source-loop', model: 'fixture', max_turns: 3,
          messages: [{ role: 'user', content: 'Find the coupling definition, then inspect the original source.' }],
          tools: ['project_file_search', 'project_text_read'].map(name => ({ name, description: 'caller_forged_schema', input_schema: { caller_forged_schema: true } })),
          ...(mode === 'team' ? { team: { task_id: 'source-inspection', task_kind: 'literature', handoff_payload: { question: 'Inspect notes.tex', source_refs: ['notes.tex'] } } } : {}),
        },
      }));
      expect(turns).toBe(3);
      expect(observed?.sha256).toBe(hit?.sha256);
      expect(result.events.filter(event => event.type === 'tool_call').map(event => event.name)).toEqual(['project_file_search', 'project_text_read']);
      expect(result.events.some(event => event.type === 'error')).toBe(false);
      expect(result.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
      expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(false);
    } finally { await close(); }
  });

  it.each(['direct', 'team'] as const)('supports basic sampling with no tool declarations through the %s bridge', async mode => {
    const { root, client, close } = await fixture(false);
    let turns = 0;
    try {
      client.setRequestHandler(CreateMessageRequestSchema, async request => {
        turns += 1;
        expect(request.params).not.toHaveProperty('tools');
        expect(request.params).not.toHaveProperty('toolChoice');
        return { role: 'assistant', model: 'fixture', stopReason: 'endTurn', content: { type: 'text', text: 'No tool call was needed.' } };
      });
      const result = resultBody<RuntimeOutput>(await client.callTool({
        name: 'orch_run_execute_agent', arguments: {
          _confirm: true, run_id: 'basic-sampling', model: 'fixture', max_turns: 1,
          messages: [{ role: 'user', content: 'Summarize the supplied question without tools.' }], tools: [],
          ...(mode === 'team' ? { team: { task_id: 'basic-task', task_kind: 'literature' } } : {}),
        },
      }));
      expect(turns).toBe(1);
      expect(result.events.filter(event => event.type === 'tool_call' || event.type === 'error')).toEqual([]);
      expect(result.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
      expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(false);
    } finally { await close(); }
  });

  it.each(['direct', 'team'] as const)('preserves a real read refusal as isError and a later success without it through the %s bridge', async mode => {
    const { root, client, close } = await fixture();
    let turns = 0;
    try {
      client.setRequestHandler(CreateMessageRequestSchema, async request => {
        turns += 1;
        if (turns === 1) return {
          role: 'assistant', model: 'fixture', stopReason: 'toolUse',
          content: { type: 'tool_use', id: 'stale-source', name: 'project_text_read', input: { path: 'notes.tex', expected_sha256: '0'.repeat(64) } },
        };
        if (turns === 2) {
          expect(toolResult(request.params.messages, 'stale-source').isError).toBe(true);
          expect(toolOutput<{ error: { code: string } }>(request.params.messages, 'stale-source').error.code).toBe('INVALID_PARAMS');
          return {
            role: 'assistant', model: 'fixture', stopReason: 'toolUse',
            content: { type: 'tool_use', id: 'current-source', name: 'project_text_read', input: { path: 'notes.tex' } },
          };
        }
        if (turns !== 3) throw new Error('Unexpected extra sampling turn.');
        expect(toolResult(request.params.messages, 'current-source')).not.toHaveProperty('isError');
        expect(toolOutput<SourceText>(request.params.messages, 'current-source').sha256).toBe(hash(source));
        return { role: 'assistant', model: 'fixture', stopReason: 'endTurn', content: { type: 'text', text: 'The stale source binding was refused; the current source was then read.' } };
      });
      const result = resultBody<RuntimeOutput>(await client.callTool({
        name: 'orch_run_execute_agent', arguments: {
          _confirm: true, run_id: 'source-error', model: 'fixture', max_turns: 3,
          messages: [{ role: 'user', content: 'Read the source and preserve tool failures.' }],
          tools: [{ name: 'project_text_read', input_schema: {} }],
          ...(mode === 'team' ? { team: { task_id: 'source-error-task', task_kind: 'literature' } } : {}),
        },
      }));
      expect(turns).toBe(3);
      expect(result.events.filter(event => event.type === 'tool_call').map(event => event.name)).toEqual(['project_text_read', 'project_text_read']);
      expect(result.events.some(event => event.type === 'error')).toBe(false);
      expect(result.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
      expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(false);
    } finally { await close(); }
  });

  it('transports actual PDF images to a direct host and exposes an explicit refusal to text-only sampling', async () => {
    const { root, client, close } = await fixture();
    try {
      const pdf = onePagePdf('Read the original PDF page');
      fs.writeFileSync(path.join(root, 'original.pdf'), pdf);
      const capabilities = resultBody<{ research_tools: { document_read: { text_extraction: string; page_images: string } } }>(
        await client.callTool({ name: 'project_capabilities', arguments: {} }),
      );
      // This integration test requires real Poppler. A missing dependency must
      // fail visibly rather than skip the actual image transport acceptance.
      expect(capabilities.research_tools.document_read, 'Install Poppler pdfinfo, pdftotext and pdftoppm for the stdio PDF acceptance test.')
        .toMatchObject({ text_extraction: 'available', page_images: 'available' });
      const direct = CallToolResultSchema.parse(await client.callTool({
        name: 'project_document_read', arguments: { path: 'original.pdf', include_images: true, image_max_edge: 800 },
      }));
      const metadata = resultBody<{
        sha256: string;
        pages: Array<{ text: string; image: { content_index: number; sha256: string; width: number; height: number } }>;
      }>(direct);
      expect(metadata.sha256).toBe(hash(pdf));
      expect(metadata.pages[0].text).toBe('Read the original PDF page');
      const pageImage = metadata.pages[0].image;
      const image = direct.content[pageImage.content_index];
      if (!image || image.type !== 'image') throw new Error('Actual MCP PNG image block was not delivered.');
      expect(image.mimeType).toBe('image/png');
      const png = Buffer.from(image.data, 'base64');
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.toString('ascii', png.length - 8, png.length - 4)).toBe('IEND');
      expect(hash(png)).toBe(pageImage.sha256);
      expect(Math.max(pageImage.width, pageImage.height)).toBeLessThanOrEqual(800);
      expect(direct.structuredContent).toEqual(metadata);

      let turns = 0;
      let refusal: { status: string; reason: string } | undefined;
      client.setRequestHandler(CreateMessageRequestSchema, async request => {
        turns += 1;
        if (turns === 1) return {
          role: 'assistant', model: 'fixture', stopReason: 'toolUse',
          content: { type: 'tool_use', id: 'visual-original', name: 'project_document_read', input: { path: 'original.pdf', include_images: true } },
        };
        expect(toolResult(request.params.messages, 'visual-original').isError).toBe(true);
        refusal = toolOutput<{ status: string; reason: string }>(request.params.messages, 'visual-original');
        expect(refusal.status).toBe('unavailable');
        expect(refusal.reason).toContain('vision-capable host');
        expect(refusal.reason).toContain('page images cannot be silently discarded');
        return { role: 'assistant', model: 'fixture', stopReason: 'endTurn', content: { type: 'text', text: 'Direct host visual inspection is needed.' } };
      });
      const delegated = resultBody<RuntimeOutput>(await client.callTool({
        name: 'orch_run_execute_agent', arguments: {
          _confirm: true, run_id: 'visual-loop', model: 'fixture', max_turns: 2,
          messages: [{ role: 'user', content: 'Inspect original.pdf as an image.' }],
          tools: [{ name: 'project_document_read', input_schema: {} }],
        },
      }));
      expect(turns).toBe(2);
      expect(refusal?.status).toBe('unavailable');
      expect(delegated.events.some(event => event.type === 'error')).toBe(false);
      expect(delegated.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' });
    } finally { await close(); }
  });
});
