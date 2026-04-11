import { describe, expect, it } from 'vitest';

import {
  compileWorkflowRuntimeRequest,
  executeWorkflowRuntimeRequest,
  normalizeWorkflowRuntimeResult,
  type PersistedWorkflowPlanStep,
  type WorkflowRuntimeRequest,
} from '../src/workflow-runtime.js';

function makeStep(overrides?: Partial<PersistedWorkflowPlanStep>): PersistedWorkflowPlanStep {
  return {
    step_id: 'critical_review',
    description: 'Critical review',
    status: 'pending',
    execution: {
      action: 'analyze.paper_set_critical_review',
      tool: 'inspire_critical_analysis',
      provider: 'inspire',
      depends_on: ['seed_search'],
      params: { recid: '1234' },
      required_capabilities: ['analysis.paper_set_critical_review'],
      degrade_mode: 'fail_closed',
      consumer_hints: {
        artifact: 'critical_analysis',
        project_required: true,
        run_required: true,
      },
    },
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<WorkflowRuntimeRequest>): WorkflowRuntimeRequest {
  return {
    project_root: '/tmp/project',
    workflow_id: 'review_cycle',
    run_id: 'RUN-1',
    step_id: 'critical_review',
    description: 'Critical review',
    tool: 'inspire_critical_analysis',
    provider: 'inspire',
    action: 'analyze.paper_set_critical_review',
    params: { recid: '1234' },
    depends_on: ['seed_search'],
    required_capabilities: ['analysis.paper_set_critical_review'],
    degrade_mode: 'fail_closed',
    artifact_key: 'critical_analysis',
    project_required: true,
    run_required: true,
    ...overrides,
  };
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('workflow runtime compile', () => {
  it('compiles a persisted workflow step into an explicit runtime request', () => {
    const request = compileWorkflowRuntimeRequest({
      projectRoot: '/tmp/project',
      workflowId: 'review_cycle',
      runId: 'RUN-1',
      step: makeStep(),
    });

    expect(request).toEqual({
      project_root: '/tmp/project',
      workflow_id: 'review_cycle',
      run_id: 'RUN-1',
      step_id: 'critical_review',
      description: 'Critical review',
      tool: 'inspire_critical_analysis',
      provider: 'inspire',
      action: 'analyze.paper_set_critical_review',
      params: { recid: '1234' },
      depends_on: ['seed_search'],
      required_capabilities: ['analysis.paper_set_critical_review'],
      degrade_mode: 'fail_closed',
      artifact_key: 'critical_analysis',
      project_required: true,
      run_required: true,
    });
  });

  it('keeps required_capabilities and does not leak consumer_hints into runtime request', () => {
    const request = compileWorkflowRuntimeRequest({
      projectRoot: '/tmp/project',
      workflowId: 'review_cycle',
      runId: 'RUN-1',
      step: makeStep(),
    }) as Record<string, unknown>;

    expect(request.required_capabilities).toEqual(['analysis.paper_set_critical_review']);
    expect('consumer_hints' in request).toBe(false);
  });

  it('fails closed when a consumed run_required precondition is not satisfied at compile time', () => {
    expect(() => compileWorkflowRuntimeRequest({
      projectRoot: '/tmp/project',
      workflowId: 'review_cycle',
      runId: null,
      step: makeStep(),
    })).toThrow('workflow step critical_review requires run_id');
  });
});

describe('workflow runtime normalize', () => {
  it('extracts a canonical artifact from a top-level uri', () => {
    const result = normalizeWorkflowRuntimeResult(makeRequest(), {
      ok: true,
      isError: false,
      rawText: '{"uri":"hep://runs/RUN-1/artifact/critical_analysis.json"}',
      json: { uri: 'hep://runs/RUN-1/artifact/critical_analysis.json' },
      errorCode: null,
    });

    expect(result).toMatchObject({
      status: 'completed',
      canonical_artifact_uri: 'hep://runs/RUN-1/artifact/critical_analysis.json',
      additional_artifact_uris: [],
    });
  });

  it('extracts a canonical artifact from summary.uri', () => {
    const result = normalizeWorkflowRuntimeResult(makeRequest(), {
      ok: true,
      isError: false,
      rawText: '{"summary":{"uri":"hep://runs/RUN-1/artifact/report.json"}}',
      json: { summary: { uri: 'hep://runs/RUN-1/artifact/report.json' } },
      errorCode: null,
    });

    expect(result).toMatchObject({
      status: 'completed',
      canonical_artifact_uri: 'hep://runs/RUN-1/artifact/report.json',
    });
  });

  it('keeps no canonical artifact when the runtime payload does not expose one', () => {
    const result = normalizeWorkflowRuntimeResult(makeRequest(), {
      ok: true,
      isError: false,
      rawText: '{"ok":true}',
      json: { ok: true },
      errorCode: null,
    });

    expect(result).toMatchObject({
      status: 'completed',
      canonical_artifact_uri: null,
      additional_artifact_uris: [],
    });
  });

  it('chooses one canonical artifact when multiple artifact refs are returned', () => {
    const result = normalizeWorkflowRuntimeResult(makeRequest(), {
      ok: true,
      isError: false,
      rawText: '{"artifacts":[{"uri":"hep://runs/RUN-1/artifact/a.json"},{"uri":"hep://runs/RUN-1/artifact/b.json"}]}',
      json: {
        artifacts: [
          { uri: 'hep://runs/RUN-1/artifact/a.json' },
          { uri: 'hep://runs/RUN-1/artifact/b.json' },
        ],
      },
      errorCode: null,
    });

    expect(result).toMatchObject({
      status: 'completed',
      canonical_artifact_uri: 'hep://runs/RUN-1/artifact/a.json',
      additional_artifact_uris: ['hep://runs/RUN-1/artifact/b.json'],
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'multiple_artifacts' }),
    ]));
  });
});

describe('workflow runtime diagnostics', () => {
  it('classifies unsupported tool execution as skipped when degrade_mode=skip_with_reason', async () => {
    const result = await executeWorkflowRuntimeRequest(
      makeRequest({ degrade_mode: 'skip_with_reason' }),
      {
        workflowToolCaller: {
          callTool: async () => {
            throw new Error('tool call denied: hep_export_project is not available');
          },
        },
      },
    );

    expect(result.status).toBe('skipped');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsupported_tool' }),
      expect.objectContaining({ code: 'skip_with_reason' }),
    ]));
  });

  it('classifies malformed MCP env as structured diagnostics', async () => {
    await withEnv({
      AUTORESEARCH_RUN_MCP_COMMAND: 'mock-mcp',
      AUTORESEARCH_RUN_MCP_ARGS_JSON: '{not-json',
      AUTORESEARCH_RUN_MCP_ENV_JSON: undefined,
    }, async () => {
      const result = await executeWorkflowRuntimeRequest(makeRequest());
      expect(result.status).toBe('failed');
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'malformed_mcp_env',
          message: 'AUTORESEARCH_RUN_MCP_ARGS_JSON must decode to a JSON string array',
        }),
      ]);
    });
  });

  it('classifies a missing MCP server configuration distinctly', async () => {
    await withEnv({
      AUTORESEARCH_RUN_MCP_COMMAND: undefined,
      AUTORESEARCH_RUN_MCP_ARGS_JSON: undefined,
      AUTORESEARCH_RUN_MCP_ENV_JSON: undefined,
    }, async () => {
      const result = await executeWorkflowRuntimeRequest(makeRequest());
      expect(result.status).toBe('failed');
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'no_mcp_tool_server' }),
      ]);
    });
  });

  it('keeps missing MCP server configuration fail-closed even when degrade_mode=skip_with_reason', async () => {
    await withEnv({
      AUTORESEARCH_RUN_MCP_COMMAND: undefined,
      AUTORESEARCH_RUN_MCP_ARGS_JSON: undefined,
      AUTORESEARCH_RUN_MCP_ENV_JSON: undefined,
    }, async () => {
      const result = await executeWorkflowRuntimeRequest(makeRequest({ degrade_mode: 'skip_with_reason' }));
      expect(result.status).toBe('failed');
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'no_mcp_tool_server' }),
      ]);
    });
  });

  it('keeps malformed MCP env fail-closed even when degrade_mode=partial_result', async () => {
    await withEnv({
      AUTORESEARCH_RUN_MCP_COMMAND: 'mock-mcp',
      AUTORESEARCH_RUN_MCP_ARGS_JSON: '{not-json',
      AUTORESEARCH_RUN_MCP_ENV_JSON: undefined,
    }, async () => {
      const result = await executeWorkflowRuntimeRequest(makeRequest({ degrade_mode: 'partial_result' }));
      expect(result.status).toBe('failed');
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'malformed_mcp_env',
          message: 'AUTORESEARCH_RUN_MCP_ARGS_JSON must decode to a JSON string array',
        }),
      ]);
    });
  });

  it('surfaces partial_result as structured diagnostics', async () => {
    const result = await executeWorkflowRuntimeRequest(
      makeRequest({ degrade_mode: 'partial_result' }),
      {
        workflowToolCaller: {
          callTool: async () => ({
            ok: false,
            isError: true,
            rawText: 'upstream timeout after partial export',
            json: null,
            errorCode: 'TIMEOUT',
          }),
        },
      },
    );

    expect(result.status).toBe('partial');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'tool_call_failed' }),
      expect.objectContaining({ code: 'partial_result' }),
    ]));
  });

  it('keeps canonical artifact refs when partial_result still carries usable output', async () => {
    const result = await executeWorkflowRuntimeRequest(
      makeRequest({ degrade_mode: 'partial_result' }),
      {
        workflowToolCaller: {
          callTool: async () => ({
            ok: false,
            isError: true,
            rawText: '{"summary":{"uri":"hep://runs/RUN-1/artifact/export.partial.json"}}',
            json: { summary: { uri: 'hep://runs/RUN-1/artifact/export.partial.json' } },
            errorCode: 'TIMEOUT',
          }),
        },
      },
    );

    expect(result).toMatchObject({
      status: 'partial',
      canonical_artifact_uri: 'hep://runs/RUN-1/artifact/export.partial.json',
      additional_artifact_uris: [],
    });
  });
});
