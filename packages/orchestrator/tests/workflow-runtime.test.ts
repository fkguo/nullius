import { describe, expect, it } from 'vitest';
import { ORCH_RUN_APPROVE } from '@nullius/shared';

import {
  compileWorkflowRuntimeRequest,
  executeWorkflowRuntimeRequest,
  loadWorkflowToolServerConfigFromEnv,
  normalizeWorkflowRuntimeResult,
  type PersistedWorkflowPlanStep,
  type WorkflowRuntimeRequest,
} from '../src/workflow-runtime.js';

function makeStep(overrides?: Partial<PersistedWorkflowPlanStep>): PersistedWorkflowPlanStep {
  return {
    step_id: 'citation_network',
    description: 'Citation network',
    status: 'pending',
    execution: {
      action: 'analyze.citation_network',
      tool: 'inspire_network_analysis',
      provider: 'inspire',
      depends_on: ['seed_search'],
      params: { mode: 'citation', seed: '1234' },
      required_capabilities: ['analysis.citation_network'],
      degrade_mode: 'fail_closed',
      consumer_hints: {
        artifact: 'network_analysis',
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
    step_id: 'citation_network',
    description: 'Citation network',
    tool: 'inspire_network_analysis',
    provider: 'inspire',
    action: 'analyze.citation_network',
    params: { mode: 'citation', seed: '1234' },
    depends_on: ['seed_search'],
    required_capabilities: ['analysis.citation_network'],
    degrade_mode: 'fail_closed',
    artifact_key: 'network_analysis',
    project_required: true,
    run_required: true,
    ...overrides,
  };
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const isolatedEnv = {
    NULLIUS_RUN_MCP_CREDENTIALS_JSON: undefined,
    NULLIUS_RUN_MCP_REQUIRED_CREDENTIALS_JSON: undefined,
    ...env,
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(isolatedEnv)) {
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
      step_id: 'citation_network',
      description: 'Citation network',
      tool: 'inspire_network_analysis',
      provider: 'inspire',
      action: 'analyze.citation_network',
      params: { mode: 'citation', seed: '1234' },
      depends_on: ['seed_search'],
      required_capabilities: ['analysis.citation_network'],
      degrade_mode: 'fail_closed',
      artifact_key: 'network_analysis',
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

    expect(request.required_capabilities).toEqual(['analysis.citation_network']);
    expect('consumer_hints' in request).toBe(false);
  });

  it('fails closed when a consumed run_required precondition is not satisfied at compile time', () => {
    expect(() => compileWorkflowRuntimeRequest({
      projectRoot: '/tmp/project',
      workflowId: 'review_cycle',
      runId: null,
      step: makeStep(),
    })).toThrow('workflow step citation_network requires run_id');
  });
});

describe('workflow runtime normalize', () => {
  it('extracts a canonical artifact from a top-level uri', () => {
    const result = normalizeWorkflowRuntimeResult(makeRequest(), {
      ok: true,
      isError: false,
      rawText: '{"uri":"provider://records/RUN-1/artifact/network_analysis.json"}',
      json: { uri: 'provider://records/RUN-1/artifact/network_analysis.json' },
      errorCode: null,
    });

    expect(result).toMatchObject({
      status: 'completed',
      canonical_artifact_uri: 'provider://records/RUN-1/artifact/network_analysis.json',
      additional_artifact_uris: [],
    });
  });

  it('extracts a canonical artifact from summary.uri', () => {
    const result = normalizeWorkflowRuntimeResult(makeRequest(), {
      ok: true,
      isError: false,
      rawText: '{"summary":{"uri":"provider://records/RUN-1/artifact/report.json"}}',
      json: { summary: { uri: 'provider://records/RUN-1/artifact/report.json' } },
      errorCode: null,
    });

    expect(result).toMatchObject({
      status: 'completed',
      canonical_artifact_uri: 'provider://records/RUN-1/artifact/report.json',
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
      rawText: '{"artifacts":[{"uri":"provider://records/RUN-1/artifact/a.json"},{"uri":"provider://records/RUN-1/artifact/b.json"}]}',
      json: {
        artifacts: [
          { uri: 'provider://records/RUN-1/artifact/a.json' },
          { uri: 'provider://records/RUN-1/artifact/b.json' },
        ],
      },
      errorCode: null,
    });

    expect(result).toMatchObject({
      status: 'completed',
      canonical_artifact_uri: 'provider://records/RUN-1/artifact/a.json',
      additional_artifact_uris: ['provider://records/RUN-1/artifact/b.json'],
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'multiple_artifacts' }),
    ]));
  });
});

describe('workflow runtime diagnostics', () => {
  it('keeps MCP config and credentials in distinct explicit maps', async () => {
    await withEnv({
      NULLIUS_RUN_MCP_COMMAND: 'mock-mcp',
      NULLIUS_RUN_MCP_ARGS_JSON: '["--stdio"]',
      NULLIUS_RUN_MCP_ENV_JSON: '{"HEP_TOOL_MODE":"standard"}',
      NULLIUS_RUN_MCP_CREDENTIALS_JSON: '{"OPENALEX_API_KEY":"declared-secret"}',
      NULLIUS_RUN_MCP_REQUIRED_CREDENTIALS_JSON: '["OPENALEX_API_KEY"]',
    }, async () => {
      expect(loadWorkflowToolServerConfigFromEnv()).toEqual({
        command: 'mock-mcp',
        args: ['--stdio'],
        configEnv: { HEP_TOOL_MODE: 'standard' },
        credentials: { OPENALEX_API_KEY: 'declared-secret' },
        requiredCredentialNames: ['OPENALEX_API_KEY'],
      });
    });
  });

  it('rejects non-string MCP credential declarations without exposing values', async () => {
    await withEnv({
      NULLIUS_RUN_MCP_COMMAND: 'mock-mcp',
      NULLIUS_RUN_MCP_ARGS_JSON: undefined,
      NULLIUS_RUN_MCP_ENV_JSON: undefined,
      NULLIUS_RUN_MCP_CREDENTIALS_JSON: '{"OPENALEX_API_KEY":123}',
    }, async () => {
      expect(() => loadWorkflowToolServerConfigFromEnv()).toThrow(
        'NULLIUS_RUN_MCP_CREDENTIALS_JSON must decode to a JSON object with string values',
      );
    });
  });

  it('rejects malformed required-credential declarations', async () => {
    await withEnv({
      NULLIUS_RUN_MCP_COMMAND: 'mock-mcp',
      NULLIUS_RUN_MCP_ARGS_JSON: undefined,
      NULLIUS_RUN_MCP_ENV_JSON: undefined,
      NULLIUS_RUN_MCP_CREDENTIALS_JSON: undefined,
      NULLIUS_RUN_MCP_REQUIRED_CREDENTIALS_JSON: '{"OPENALEX_API_KEY":true}',
    }, async () => {
      expect(() => loadWorkflowToolServerConfigFromEnv()).toThrow(
        'NULLIUS_RUN_MCP_REQUIRED_CREDENTIALS_JSON must decode to a JSON string array',
      );
    });
  });

  it('never dispatches an approval resolver through the workflow adapter', async () => {
    let calls = 0;
    const result = await executeWorkflowRuntimeRequest(
      makeRequest({ tool: ORCH_RUN_APPROVE }),
      {
        workflowToolCaller: {
          callTool: async () => {
            calls += 1;
            return { ok: true, isError: false, rawText: 'forbidden', json: null, errorCode: null };
          },
        },
      },
    );

    expect(calls).toBe(0);
    expect(result.status).toBe('failed');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'tool_call_failed',
        message: expect.stringContaining('canonical host/operator approval surface'),
      }),
    ]);
  });

  it('lets a dispatch observer see copies of the request and response and dispatch exactly once', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const request = makeRequest();
    const result = await executeWorkflowRuntimeRequest(request, {
      workflowToolCaller: {
        callTool: async (name, args) => {
          calls.push({ name, args });
          return {
            ok: true,
            isError: false,
            rawText: '{"uri":"provider://records/RUN-1/artifact/network_analysis.json"}',
            json: { uri: 'provider://records/RUN-1/artifact/network_analysis.json' },
            errorCode: null,
          };
        },
      },
      aroundDispatch: async (dispatch, observed) => {
        expect(observed).toEqual(request);
        expect(observed).not.toBe(request);
        const response = await dispatch();
        expect(response.json).toEqual({ uri: 'provider://records/RUN-1/artifact/network_analysis.json' });
        await expect(dispatch()).rejects.toThrow(/already dispatched once/);
      },
    });

    expect(calls).toEqual([{ name: request.tool, args: request.params }]);
    expect(result).toMatchObject({
      status: 'completed',
      canonical_artifact_uri: 'provider://records/RUN-1/artifact/network_analysis.json',
    });
  });

  it('dispatches and normalizes exactly what the transport saw and returned, whatever the observer or caller mutates', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const request = makeRequest();
    const compiled = structuredClone(request);
    const result = await executeWorkflowRuntimeRequest(request, {
      workflowToolCaller: {
        callTool: async (name, args) => {
          calls.push({ name, args });
          return {
            ok: true,
            isError: false,
            rawText: '{"uri":"provider://records/RUN-1/artifact/network_analysis.json"}',
            json: { uri: 'provider://records/RUN-1/artifact/network_analysis.json' },
            errorCode: null,
          };
        },
      },
      aroundDispatch: async (dispatch, observed) => {
        observed.tool = ORCH_RUN_APPROVE;
        observed.params.recid = 'substituted';
        request.tool = ORCH_RUN_APPROVE;
        request.params.recid = 'substituted';
        const response = await dispatch();
        response.ok = false;
        response.isError = true;
        response.rawText = 'fabricated';
        (response.json as { uri: string }).uri = 'provider://records/RUN-1/artifact/fabricated.json';
      },
    });

    expect(calls).toEqual([{ name: compiled.tool, args: compiled.params }]);
    expect(result).toMatchObject({
      status: 'completed',
      canonical_artifact_uri: 'provider://records/RUN-1/artifact/network_analysis.json',
    });
  });

  it('refuses an observer that returns without dispatching and closes dispatch once the observer settles', async () => {
    let calls = 0;
    const workflowToolCaller = {
      callTool: async () => {
        calls += 1;
        return { ok: true, isError: false, rawText: '{}', json: {}, errorCode: null };
      },
    };
    let retained: (() => Promise<unknown>) | null = null;
    const result = await executeWorkflowRuntimeRequest(makeRequest(), {
      workflowToolCaller,
      aroundDispatch: async dispatch => {
        retained = dispatch;
      },
    });
    expect(result.status).toBe('failed');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'tool_call_failed', message: expect.stringContaining('returned without dispatching') }),
    ]);
    await expect(retained!()).rejects.toThrow(/can no longer be dispatched/);
    expect(calls).toBe(0);
  });

  it('keeps a transport failure behind an unawaited dispatch from surfacing as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await executeWorkflowRuntimeRequest(makeRequest(), {
        workflowToolCaller: {
          callTool: async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            throw new Error('transport closed');
          },
        },
        aroundDispatch: async dispatch => {
          void dispatch();
          throw new Error('observer halted after firing');
        },
      });
      expect(result.status).toBe('failed');
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ message: 'observer halted after firing' }),
      ]);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

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
      NULLIUS_RUN_MCP_COMMAND: 'mock-mcp',
      NULLIUS_RUN_MCP_ARGS_JSON: '{not-json',
      NULLIUS_RUN_MCP_ENV_JSON: undefined,
    }, async () => {
      const result = await executeWorkflowRuntimeRequest(makeRequest());
      expect(result.status).toBe('failed');
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'malformed_mcp_env',
          message: 'NULLIUS_RUN_MCP_ARGS_JSON must decode to a JSON string array',
        }),
      ]);
    });
  });

  it('classifies a missing MCP server configuration distinctly', async () => {
    await withEnv({
      NULLIUS_RUN_MCP_COMMAND: undefined,
      NULLIUS_RUN_MCP_ARGS_JSON: undefined,
      NULLIUS_RUN_MCP_ENV_JSON: undefined,
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
      NULLIUS_RUN_MCP_COMMAND: undefined,
      NULLIUS_RUN_MCP_ARGS_JSON: undefined,
      NULLIUS_RUN_MCP_ENV_JSON: undefined,
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
      NULLIUS_RUN_MCP_COMMAND: 'mock-mcp',
      NULLIUS_RUN_MCP_ARGS_JSON: '{not-json',
      NULLIUS_RUN_MCP_ENV_JSON: undefined,
    }, async () => {
      const result = await executeWorkflowRuntimeRequest(makeRequest({ degrade_mode: 'partial_result' }));
      expect(result.status).toBe('failed');
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'malformed_mcp_env',
          message: 'NULLIUS_RUN_MCP_ARGS_JSON must decode to a JSON string array',
        }),
      ]);
    });
  });

  it('keeps mcp_server_unavailable fail-closed even when degrade_mode=skip_with_reason', async () => {
    const result = await executeWorkflowRuntimeRequest(
      makeRequest({ degrade_mode: 'skip_with_reason' }),
      {
        workflowToolCaller: {
          callTool: async () => {
            throw new Error('MCP process timed out while calling inspire_network_analysis');
          },
        },
      },
    );

    expect(result.status).toBe('failed');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'mcp_server_unavailable',
        message: 'MCP process timed out while calling inspire_network_analysis',
      }),
    ]);
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
            rawText: '{"summary":{"uri":"provider://records/RUN-1/artifact/export.partial.json"}}',
            json: { summary: { uri: 'provider://records/RUN-1/artifact/export.partial.json' } },
            errorCode: 'TIMEOUT',
          }),
        },
      },
    );

    expect(result).toMatchObject({
      status: 'partial',
      canonical_artifact_uri: 'provider://records/RUN-1/artifact/export.partial.json',
      additional_artifact_uris: [],
    });
  });
});
