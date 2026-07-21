import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { getMethodContract, OPENRPC_PATH } from '../src/contracts/openrpc.js';
import { IdeaEngineNodeService } from '../src/service/node-service.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const schemaDir = resolve(packageRoot, 'contracts/idea-runtime-contracts/schemas');

describe('node.revise_card contract anti-drift', () => {
  it('keeps standalone request schema, OpenRPC binding, runtime route, result schema, and docs aligned', () => {
    const request = JSON.parse(readFileSync(resolve(schemaDir, 'idea_card_revision_request_v1.schema.json'), 'utf8')) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    const method = getMethodContract('node.revise_card')!;
    const openRpcParamNames = (method.params ?? []).map((param) => param.name);
    expect(openRpcParamNames).toEqual(request.required);
    expect(Object.keys(request.properties)).toEqual(request.required);
    for (const param of method.params ?? []) {
      const openRpcSchema = structuredClone(param.schema) as Record<string, unknown>;
      const requestSchema = structuredClone(request.properties[param.name]) as Record<string, unknown>;
      delete openRpcSchema.description;
      delete requestSchema.description;
      expect(openRpcSchema, `schema drift for ${param.name}`).toEqual(requestSchema);
      expect(param.required, `required drift for ${param.name}`).toBe(true);
    }
    expect(method.result?.schema).toEqual({
      $ref: './idea_card_revision_result_v1.schema.json',
    });
    expect((method.errors ?? []).map((error) => error.code)).toEqual([-32002, -32003, -32004, -32014, -32015, -32018, -32019, -32603]);

    const openrpc = JSON.parse(readFileSync(OPENRPC_PATH, 'utf8')) as {
      'x-error-data-contract': { known_reasons: Record<string, string[]> };
    };
    expect(openrpc['x-error-data-contract'].known_reasons['-32019']).toEqual(['stale_revision']);
    expect(openrpc['x-error-data-contract'].known_reasons['-32018']).toContain('idea_card_revision_lifecycle_invalid');

    const rootDir = mkdtempSync(resolve(tmpdir(), 'idea-revise-contract-'));
    try {
      const service = new IdeaEngineNodeService({ rootDir });
      expect(service.canHandle('node.revise_card')).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
    expect(readFileSync(resolve(packageRoot, 'README.md'), 'utf8')).toContain('`node.revise_card`');
    expect(readFileSync(resolve(packageRoot, '../idea-mcp/README.md'), 'utf8')).toContain('`node.revise_card`');
  });
});
