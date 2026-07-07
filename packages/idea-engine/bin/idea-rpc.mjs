#!/usr/bin/env node
// Thin command-line bridge into the idea-engine JSON-RPC service.
// Reads one JSON object from stdin:
// { "method": string, "params": object, "store_root": string, "project_root"?: string }.
// Writes the JSON-RPC response object to stdout. No business logic lives here;
// this is the call path used by skill-layer tooling (e.g. the decision-layer
// allocation script) to reach node.set_posterior / node.set_lifecycle /
// rank.compute and the other public methods.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';
import { IdeaEngineRpcService, handleJsonRpcRequest } from '../dist/index.js';

function fail(message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'invalid_request', data: { reason: 'invalid_request', details: { message } } },
  })}\n`);
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const raw = (await readStdin()).trim();
if (!raw) {
  fail('expected a JSON request object on stdin');
}

let request;
try {
  request = JSON.parse(raw);
} catch {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'parse_error', data: { reason: 'parse_error' } },
  })}\n`);
  process.exit(1);
}

if (!request || typeof request !== 'object' || Array.isArray(request)) {
  fail('request must be a JSON object');
}
if (typeof request.method !== 'string' || request.method.length === 0) {
  fail('request.method must be a non-empty string');
}
if (typeof request.store_root !== 'string' || request.store_root.length === 0) {
  fail('request.store_root must be a non-empty string path');
}

const service = new IdeaEngineRpcService({
  projectRoot: typeof request.project_root === 'string' && request.project_root.length > 0
    ? resolve(request.project_root)
    : undefined,
  rootDir: resolve(request.store_root),
});
const response = handleJsonRpcRequest(service, {
  jsonrpc: '2.0',
  id: randomUUID(),
  method: request.method,
  params: request.params ?? {},
});
process.stdout.write(`${JSON.stringify(response)}\n`);
process.exit(response.error ? 1 : 0);
