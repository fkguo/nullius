import { openSync, closeSync, fsyncSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { IdeaEngineRpcService } from '../../dist/index.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const service = new IdeaEngineRpcService({
  rootDir: input.root_dir,
  now: () => '2026-07-21T08:00:00.000Z',
});
const store = service.node.store;

if (input.crash_point === 'after_prepare') {
  store.saveNodes = () => process.exit(91);
} else if (input.crash_point === 'after_node') {
  store.appendNodeLogEntry = () => process.exit(92);
} else if (input.crash_point === 'during_log') {
  store.appendNodeLogEntry = (campaignId, entry) => {
    const path = store.nodesLogPath(campaignId);
    mkdirSync(dirname(path), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(entry), 'utf8');
    const fd = openSync(path, 'a');
    try {
      writeFileSync(fd, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    process.exit(93);
  };
} else if (input.crash_point === 'after_log') {
  const originalSaveIdempotency = store.saveIdempotency.bind(store);
  store.saveIdempotency = (campaignId, payload) => {
    const record = payload[`node.revise_card:${input.params.idempotency_key}`];
    if (record?.state === 'committed') process.exit(94);
    originalSaveIdempotency(campaignId, payload);
  };
} else {
  throw new Error(`unknown crash point: ${String(input.crash_point)}`);
}

service.handle('node.revise_card', input.params);
process.exit(90);
