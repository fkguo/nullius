import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commitDelivery, readRequest } from './delivery.js';
import { releaseExecution } from './execution-lock.js';
import type { Result } from './result.js';

const filename = process.argv[2]!;
const request = readRequest(filename);
const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), filename], {
  cwd: request.root, stdio: 'ignore', detached: true, env: process.env,
});
let timedOut = false;
const timer = setTimeout(() => {
  if (child.exitCode !== null) return;
  timedOut = true;
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* A concurrently exited process has no result yet. */ }
  }
}, request.timeout_seconds * 1000);
const code = await new Promise<number | null>(resolve => {
  child.once('error', () => resolve(null));
  child.once('close', value => resolve(value));
});
clearTimeout(timer);
if (!timedOut && code === 0) {
  const result = JSON.parse(fs.readFileSync(`${filename}.response`, 'utf8')) as Result;
  commitDelivery(request, result);
  releaseExecution(request.root, request.delivery_id);
}
// Timeout, crash or missing response leaves the canonical attempt outcome_unknown.
// Keep the project lock: a local operator must inspect effects before another write.
