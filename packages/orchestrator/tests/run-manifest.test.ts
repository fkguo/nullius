import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RunManifestManager, type RunManifest } from '../src/run-manifest.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-manifest-test-'));
}

describe('RunManifestManager', () => {
  let tmpDir: string;
  let manager: RunManifestManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    manager = new RunManifestManager(path.join(tmpDir, 'runs'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadManifest returns null for nonexistent run', () => {
    expect(manager.loadManifest('run-missing')).toBeNull();
  });

  it('saveCheckpoint creates manifest with checkpoint', () => {
    manager.saveCheckpoint('run-1', 'step-0', 'result text');

    const manifest = manager.loadManifest('run-1');
    expect(manifest).not.toBeNull();
    expect(manifest!.run_id).toBe('run-1');
    expect(manifest!.checkpoints).toHaveLength(1);
    expect(manifest!.checkpoints[0]).toMatchObject({
      step_id: 'step-0',
      result_summary: 'result text',
    });
    expect(manifest!.last_completed_step).toBe('step-0');
  });

  it('saveCheckpoint accumulates multiple checkpoints', () => {
    manager.saveCheckpoint('run-1', 'step-0', 'r0');
    manager.saveCheckpoint('run-1', 'step-1', 'r1');
    manager.saveCheckpoint('run-1', 'step-2', 'r2');

    const manifest = manager.loadManifest('run-1');
    expect(manifest!.checkpoints).toHaveLength(3);
    expect(manifest!.last_completed_step).toBe('step-2');
  });

  it('saveCheckpoint does not duplicate existing step_id', () => {
    manager.saveCheckpoint('run-1', 'step-0', 'first');
    manager.saveCheckpoint('run-1', 'step-0', 'second'); // duplicate

    const manifest = manager.loadManifest('run-1');
    expect(manifest!.checkpoints).toHaveLength(1);
    expect(manifest!.checkpoints[0].result_summary).toBe('first');
  });

  it('saveCheckpoint writes atomically (tmp → rename)', () => {
    // Check that no .tmp file is left after save
    manager.saveCheckpoint('run-1', 'step-0');
    const runsDir = path.join(tmpDir, 'runs', 'run-1');
    const tmpFiles = fs.readdirSync(runsDir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  describe('shouldSkipStep', () => {
    it('returns false when resume_from is not set', () => {
      const manifest: RunManifest = {
        run_id: 'run-1',
        created_at: '2026-01-01T00:00:00Z',
        checkpoints: [{ step_id: 'step-0', completed_at: '2026-01-01T00:00:00Z' }],
      };
      expect(manager.shouldSkipStep(manifest, 'step-0')).toBe(false);
    });

    it('returns true for completed step when resume_from is set', () => {
      const manifest: RunManifest = {
        run_id: 'run-1',
        created_at: '2026-01-01T00:00:00Z',
        resume_from: 'step-1',
        checkpoints: [
          { step_id: 'step-0', completed_at: '2026-01-01T00:00:00Z' },
        ],
      };
      expect(manager.shouldSkipStep(manifest, 'step-0')).toBe(true);
    });

    it('returns false for uncompleted step when resume_from is set', () => {
      const manifest: RunManifest = {
        run_id: 'run-1',
        created_at: '2026-01-01T00:00:00Z',
        resume_from: 'step-1',
        checkpoints: [
          { step_id: 'step-0', completed_at: '2026-01-01T00:00:00Z' },
        ],
      };
      expect(manager.shouldSkipStep(manifest, 'step-1')).toBe(false);
    });
  });

  it('crash recovery: resume skips completed tool_use via manifest checkpoint', async () => {
    // Simulate crash recovery scenario using AgentRunner.
    // This test imports AgentRunner here to verify end-to-end durable execution.
    const { AgentRunner, _resetLaneQueue } = await import('../src/agent-runner.js');
    const { McpError } = await import('@autoresearch/shared');
    _resetLaneQueue();

    const callLog: string[] = [];

    // Mock MCP client that logs each call
    const mockMcpClient = {
      callTool: async (name: string) => {
        callLog.push(name);
        return { ok: true, isError: false, rawText: `result:${name}`, json: null, errorCode: null };
      },
    };
    void McpError; // suppress unused import

    // Messages as they would look after a crash mid-run:
    // - The assistant turn with unanswered tool_use is the last message.
    const messagesAfterCrash = [
      { role: 'user' as const, content: 'Run two tools' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 'tu_crashed', name: 'tool_A', input: {} }],
      },
    ];

    // Manifest: tool_A (tu_crashed) already completed in a prior run
    const manifest: RunManifest = {
      run_id: 'run-resume',
      created_at: '2026-01-01T00:00:00Z',
      resume_from: 'tu_crashed',
      last_completed_step: 'tu_crashed',
      checkpoints: [
        { step_id: 'tu_crashed', completed_at: '2026-01-01T00:00:00Z', result_summary: 'cached-result-A' },
      ],
    };

    // Second LLM response: final text (after tool_result is injected)
    const createFn = async () => ({
      content: [{ type: 'text' as const, text: 'Resumed successfully' }],
      stop_reason: 'end_turn',
    });

    const runner = new AgentRunner({
      model: 'claude-opus-4-6',
      runId: 'run-resume',
      mcpClient: mockMcpClient as never,
      approvalGate: {} as never,
      _messagesCreate: createFn,
    });

    const events: Array<{ type: string }> = [];
    for await (const ev of runner.run(messagesAfterCrash, [], { manifest })) {
      events.push(ev);
    }

    // tool_A must NOT have been called via MCP (it was in the checkpoint)
    expect(callLog).not.toContain('tool_A');

    // A tool_call event with the cached result should be emitted
    const toolCallEvt = events.find((e) => e.type === 'tool_call');
    expect(toolCallEvt).toMatchObject({ type: 'tool_call', name: 'tool_A', result: 'cached-result-A' });

    // Final text event from the resumed LLM turn
    const textEvt = events.find((e) => e.type === 'text');
    expect(textEvt).toMatchObject({ type: 'text', text: 'Resumed successfully' });
  });
});
