import type { LedgerWriter } from './ledger-writer.js';
import type { ChatBackendFactory } from './backends/backend-factory.js';
import type { SamplingRoutingConfig } from './routing/sampling-types.js';
import { executeSamplingRequest, type HostSamplingRequest } from './sampling-handler.js';

export interface SamplingRuntime {
  routingConfig: SamplingRoutingConfig;
  backendFactory?: ChatBackendFactory;
}

export async function handleMcpServerRequest(params: {
  message: Record<string, unknown>;
  sampling: SamplingRuntime | null;
  ledger?: LedgerWriter;
  writeResponse: (response: Record<string, unknown>) => void;
}): Promise<void> {
  const id = params.message.id as number | string;
  const method = String(params.message.method ?? '');
  if (method !== 'sampling/createMessage') {
    params.writeResponse({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unsupported server request: ${method}` },
    });
    return;
  }
  if (!params.sampling) {
    params.writeResponse({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Client sampling support is not configured' },
    });
    return;
  }

  try {
    const executed = await executeSamplingRequest({
      request: params.message.params as HostSamplingRequest,
      routingConfig: params.sampling.routingConfig,
      backendFactory: params.sampling.backendFactory,
      ledger: params.ledger,
    });
    params.writeResponse({ jsonrpc: '2.0', id, result: executed.result });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    params.writeResponse({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: 'sampling/createMessage failed',
        data: { reason },
      },
    });
  }
}
