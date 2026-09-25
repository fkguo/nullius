import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RunManifestManager, createToolAttemptIdentity } from '@nullius/orchestrator';
import { invalidParams, writeBytesAtomicDurable } from '@nullius/shared';
import { boundPath, safeId, assertProjectIdentity, type ProjectIdentity } from './paths.js';
import { acquireExecution, releaseExecution } from './execution-lock.js';
import type { Result } from './result.js';

export type DeliveryRequest = { root: string; root_identity: ProjectIdentity; delivery_id: string; name: string; args: Record<string, unknown>; timeout_seconds: number };
export function journal(root: string): RunManifestManager {
  return new RunManifestManager(boundPath(root, 'artifacts/delegated-runs/project-mcp'));
}
export function requestPath(root: string, id: string): string {
  return boundPath(root, `artifacts/delegated-runs/project-mcp/${safeId(id)}/delivery_request.json`);
}
export function attempt(request: DeliveryRequest) {
  return createToolAttemptIdentity({ stepId: 'call', toolName: request.name, input: { project_root: request.root, root_identity: request.root_identity, arguments: request.args, timeout_seconds: request.timeout_seconds } });
}
export function readDelivery(root: string, id: string, offset = 0, maxBytes = 65536) {
  const filename = requestPath(root, id);
  let request: DeliveryRequest;
  try { request = JSON.parse(fs.readFileSync(filename, 'utf8')) as DeliveryRequest; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const manifest = journal(root).loadManifest(id);
    if (!manifest) return { delivery_id: id, state: 'missing', message: 'No delivery was recorded for this ID.' };
    const pending = manifest.pending_tool_intents.find(item => item.step_id === 'call');
    return { delivery_id: id, state: pending?.state ?? 'outcome_unknown', message: 'Request preparation is absent. Only a not_started attempt may resume the same first dispatch; otherwise reconcile locally.' };
  }
  assertProjectIdentity(root, request.root_identity);
  if (request.root !== root || request.delivery_id !== id) throw invalidParams('Delivery request binding mismatch.');
  const classified = journal(root).classifyToolAttempt(id, attempt(request));
  if (classified.state !== 'committed') return {
    delivery_id: id, state: classified.state,
    message: 'No committed response yet. This may still be running or require local reconciliation; never resubmit with a new ID to retry unknown effects.',
    canonical_project_root: root,
  };
  const envelope: Result = { content: [{ type: 'text', text: classified.result.rawText }], ...(classified.result.isError ? { isError: true } : {}) };
  const bytes = Buffer.from(JSON.stringify(envelope));
  if (offset > bytes.length) throw invalidParams('Delivery offset is beyond the response.');
  const end = Math.min(offset + maxBytes, bytes.length);
  const response = bytes.length <= maxBytes && offset === 0 ? { result: envelope } : {
    result: null, encoding: 'base64-json', data: bytes.subarray(offset, end).toString('base64'),
    offset, next_offset: end < bytes.length ? end : null, total_bytes: bytes.length,
    response_sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const lock = boundPath(root, '.nullius/project_mcp_execution.lock');
  try {
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8')) as { owner: string };
    if (owner.owner === id) return {
      delivery_id: id, state: 'finalizing', ...response, result_sha256: classified.result_sha256,
      message: 'Response committed; wait for the worker to release this project before the next write. A persistent lock requires local reconciliation.',
    };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { delivery_id: id, state: 'committed', ...response, result_sha256: classified.result_sha256 };
}
export function submitDelivery(request: DeliveryRequest, beforeDispatch: () => void) {
  assertProjectIdentity(request.root, request.root_identity);
  const id = safeId(request.delivery_id);
  const manager = journal(request.root);
  const identity = attempt(request);
  // Exact replay is available even while another request owns the project lock.
  const existing = manager.classifyToolAttempt(id, identity);
  if (existing.state === 'committed' || existing.state === 'outcome_unknown') return readDelivery(request.root, id);
  beforeDispatch();
  acquireExecution(request.root, id);
  let dispatched = false;
  try {
    // Another connection could have committed between the first read and lock acquisition.
    const current = manager.classifyToolAttempt(id, identity);
    if (current.state === 'committed' || current.state === 'outcome_unknown') {
      releaseExecution(request.root, id);
      return readDelivery(request.root, id);
    }
    manager.observeToolIntents(id, [identity]);
    const filename = requestPath(request.root, id);
    writeBytesAtomicDurable(filename, JSON.stringify(request) + '\n', 0o600);
    manager.markToolIntentsDispatched(id, [identity]);
    dispatched = true;
    const supervisor = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.js', import.meta.url)), filename], {
      cwd: request.root, stdio: 'ignore', detached: true, env: process.env,
    });
    // Launch failure deliberately retains outcome_unknown and the execution lock.
    supervisor.on('error', () => {});
    supervisor.unref();
    return readDelivery(request.root, id);
  } catch (error) {
    if (!dispatched) releaseExecution(request.root, id);
    throw error;
  }
}
export function commitDelivery(request: DeliveryRequest, result: Result): void {
  assertProjectIdentity(request.root, request.root_identity);
  const rawText = result.content.map(item => item.text).join('\n');
  let json: unknown = null;
  try { json = JSON.parse(rawText); } catch { /* Preserve the original text. */ }
  journal(request.root).commitToolAttempt(request.delivery_id, attempt(request), {
    ok: !result.isError, isError: Boolean(result.isError), rawText, json, errorCode: null,
  });
}
export function readRequest(filename: string): DeliveryRequest {
  const request = JSON.parse(fs.readFileSync(filename, 'utf8')) as DeliveryRequest;
  if (path.resolve(filename) !== requestPath(request.root, request.delivery_id)) throw invalidParams('Unexpected delivery request path.');
  assertProjectIdentity(request.root, request.root_identity);
  return request;
}
