import { ZodError } from 'zod';
import { invalidParams, McpError, redact, verifyHarnessInvocationMarker } from '@autoresearch/shared';
import type { ToolExposureMode } from './registry.js';
import { getToolSpec, isToolExposed } from './registry.js';
import { isStateTouchingOpenalexMcp } from './state-touch-classification.js';

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
  // B-1 defense-in-depth: all tool-result error messages run through redact()
  // so leaked secrets (api_key, Bearer tokens, etc.) are masked at the
  // serialization boundary even if upstream layers forget to strip them.
  // Provider-atom layer (rateLimiter.ts:stripSecretsFromUrl) is the primary
  // strip; this is the safety net.
  const payload = (() => {
    if (err instanceof McpError) {
      return {
        error: {
          code: err.code,
          message: redact(err.message),
          data: err.data,
        },
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      error: {
        code: 'INTERNAL_ERROR',
        message: redact(message),
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
  _ctx?: ToolCallContext,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    // P3-C (redesigned 2026-05-23): event-driven anchor verification.
    // openalex-mcp standalone classifier: all tools are NO_STATE_TOUCH per
    // audit; this call short-circuits via skip layer C.
    verifyHarnessInvocationMarker(process.cwd(), {
      toolIsStateTouching: isStateTouchingOpenalexMcp(name),
    });
    const spec = getToolSpec(name);
    if (!spec) {
      throw invalidParams(`Unknown tool: ${name}`);
    }
    if (!isToolExposed(spec, mode)) {
      throw invalidParams(`Tool not exposed in ${mode} mode: ${name}`);
    }

    const parsedArgs = parseToolArgs(name, spec.zodSchema, args);
    const result = await spec.handler(parsedArgs as never);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return formatToolError(err);
  }
}
