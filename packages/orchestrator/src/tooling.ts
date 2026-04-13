import { invalidParams } from '@autoresearch/shared';
import { ORCH_TOOL_SPECS } from './orch-tools/index.js';

export type ToolExposureMode = 'standard' | 'full';
export type ToolSpec = typeof ORCH_TOOL_SPECS[number];

export function getToolSpecs(mode: ToolExposureMode = 'standard'): ToolSpec[] {
  return ORCH_TOOL_SPECS.filter(spec => mode === 'full' || spec.exposure === 'standard');
}

export function getToolSpec(name: string): ToolSpec | undefined {
  return ORCH_TOOL_SPECS.find(spec => spec.name === name);
}

function formatError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const errorRecord = error instanceof Error ? error as unknown as Record<string, unknown> : null;
  const payload = errorRecord && 'code' in errorRecord
    ? {
      error: {
        code: String(errorRecord.code ?? 'INVALID_PARAMS'),
        message: error instanceof Error ? error.message : String(error),
        data: errorRecord.data ?? undefined,
      },
    }
    : {
      error: {
        code: 'INVALID_PARAMS',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  mode: ToolExposureMode = 'standard',
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const spec = getToolSpec(name);
  if (!spec) {
    return formatError(invalidParams(`Unknown tool: ${name}`));
  }
  if (mode !== 'full' && spec.exposure !== 'standard') {
    return formatError(invalidParams(`Tool not exposed in ${mode} mode: ${name}`));
  }
  const parsed = spec.zodSchema.safeParse(args);
  if (!parsed.success) {
    return formatError(invalidParams(`Invalid params for ${name}`, {
      issues: parsed.error.issues,
    }));
  }
  try {
    const result = await spec.handler(parsed.data);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return formatError(error);
  }
}
