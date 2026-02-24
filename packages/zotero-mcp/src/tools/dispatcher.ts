import { ZodError } from 'zod';
import { invalidParams, McpError } from '@autoresearch/shared';
import type { ToolExposureMode } from './registry.js';
import { getToolSpec, isToolExposed } from './registry.js';

export interface ToolCallContext {}

function parseToolArgs<T>(toolName: string, schema: { parse: (input: unknown) => T }, args: unknown): T {
  try {
    return schema.parse(args);
  } catch (err) {
    if (err instanceof ZodError) {
      throw invalidParams(`Invalid parameters for ${toolName}`, {
        issues: err.issues,
      });
    }
    throw err;
  }
}

function formatToolError(err: unknown): { content: { type: string; text: string }[]; isError: true } {
  const payload = (() => {
    if (err instanceof McpError) {
      return {
        error: {
          code: err.code,
          message: err.message,
          data: err.data,
        },
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      error: {
        code: 'INTERNAL_ERROR',
        message,
      },
    };
  })();

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  mode: ToolExposureMode = 'standard',
  _ctx?: ToolCallContext
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    const spec = getToolSpec(name);
    if (!spec) {
      throw invalidParams(`Unknown tool: ${name}`);
    }
    if (!isToolExposed(spec, mode)) {
      throw invalidParams(`Tool not exposed in ${mode} mode: ${name}`);
    }

    const parsedArgs = parseToolArgs(name, spec.zodSchema, args);
    const result = await spec.handler(parsedArgs as any, {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return formatToolError(err);
  }
}

