import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStorePath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return uri;
  const campaignIndex = uri.indexOf('/campaigns/');
  if (campaignIndex >= 0) return `file://$STORE${uri.slice(campaignIndex)}`;
  const globalIndex = uri.indexOf('/global/');
  if (globalIndex >= 0) return `file://$STORE${uri.slice(globalIndex)}`;
  return uri;
}

function normalizeValue(value) {
  if (typeof value === 'string') return normalizeStorePath(value);
  if (Array.isArray(value)) return value.map(item => normalizeValue(item));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]),
    );
  }
  return value;
}

function materializeSnapshot(rootDir, snapshot) {
  for (const [relativePath, payload] of Object.entries(snapshot)) {
    const fullPath = resolve(rootDir, relativePath);
    mkdirSync(resolve(fullPath, '..'), { recursive: true });
    if (relativePath.endsWith('.jsonl')) {
      const lines = payload.map(item => JSON.stringify(item)).join('\n');
      writeFileSync(fullPath, lines ? `${lines}\n` : '', 'utf8');
      continue;
    }
    writeFileSync(fullPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}

function collectSnapshot(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }
  files.sort();

  const snapshot = {};
  for (const fullPath of files) {
    const relativePath = fullPath.slice(rootDir.length + 1);
    if (relativePath.endsWith('.jsonl')) {
      snapshot[relativePath] = readFileSync(fullPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      continue;
    }
    snapshot[relativePath] = JSON.parse(readFileSync(fullPath, 'utf8'));
  }
  return snapshot;
}

function stableTempRoot(label, name) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const root = resolve(tmpdir(), `idea-engine-fixture-${label}-${safeName || 'case'}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

async function loadRuntime(fixturesDir) {
  const rpcServicePath = resolve(fixturesDir, '../../dist/service/rpc-service.js');
  const jsonRpcPath = resolve(fixturesDir, '../../dist/rpc/jsonrpc.js');
  if (!existsSync(rpcServicePath) || !existsSync(jsonRpcPath)) {
    throw new Error(
      'Missing idea-engine dist runtime. Run `pnpm --filter @autoresearch/idea-engine build` first.',
    );
  }
  const [{ IdeaEngineRpcService }, { handleJsonRpcRequest }] = await Promise.all([
    import(pathToFileURL(rpcServicePath).href),
    import(pathToFileURL(jsonRpcPath).href),
  ]);
  return { IdeaEngineRpcService, handleJsonRpcRequest };
}

function normalizeFixture(fixture) {
  const normalizedCases = fixture.cases.map(testCase => ({
    ...testCase,
    expected_store: normalizeValue(testCase.expected_store),
    steps: testCase.steps.map(step => ({
      request: normalizeValue(step.request),
      response: normalizeValue(step.response),
    })),
  }));
  return {
    ...fixture,
    cases: normalizedCases,
    parse_cases: normalizeValue(fixture.parse_cases),
  };
}

function fixturesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function regenerateFixture({
  fixturePath,
  label,
  IdeaEngineRpcService,
  handleJsonRpcRequest,
}) {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const regeneratedCases = [];

  for (const testCase of fixture.cases) {
    const rootDir = stableTempRoot(label, testCase.name);
    materializeSnapshot(rootDir, testCase.initial_store);
    const uuidSequence = [...testCase.uuid_sequence];
    const service = new IdeaEngineRpcService({
      rootDir,
      now: () => testCase.now,
      createId: () => {
        const next = uuidSequence.shift();
        if (!next) throw new Error(`uuid sequence exhausted (${label}:${testCase.name})`);
        return next;
      },
    });
    const regeneratedSteps = testCase.steps.map(step => ({
      request: deepClone(step.request),
      response: handleJsonRpcRequest(service, deepClone(step.request)),
    }));
    regeneratedCases.push({
      ...testCase,
      steps: regeneratedSteps,
      expected_store: collectSnapshot(rootDir),
    });
    rmSync(rootDir, { recursive: true, force: true });
  }

  return {
    ...fixture,
    cases: regeneratedCases,
    parse_cases: fixture.parse_cases ?? [],
  };
}

async function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const fixturesDir = fileURLToPath(new URL('.', import.meta.url));
  const { IdeaEngineRpcService, handleJsonRpcRequest } = await loadRuntime(fixturesDir);

  const targets = [
    {
      label: 'write',
      path: resolve(fixturesDir, 'write-rpc-golden.json'),
    },
    {
      label: 'search-step',
      path: resolve(fixturesDir, 'search-step-rpc-golden.json'),
    },
  ];

  let hadMismatch = false;
  for (const target of targets) {
    const existing = JSON.parse(readFileSync(target.path, 'utf8'));
    const regenerated = await regenerateFixture({
      fixturePath: target.path,
      label: target.label,
      IdeaEngineRpcService,
      handleJsonRpcRequest,
    });
    const normalizedExisting = normalizeFixture(existing);
    const normalizedRegenerated = normalizeFixture(regenerated);

    if (mode === 'write') {
      writeFileSync(target.path, `${JSON.stringify(normalizedRegenerated, null, 2)}\n`, 'utf8');
      process.stdout.write(`[updated] ${target.label} fixture\n`);
      continue;
    }

    if (!fixturesEqual(normalizedExisting, normalizedRegenerated)) {
      hadMismatch = true;
      process.stderr.write(`[mismatch] ${target.label} fixture is out of date\n`);
    } else {
      process.stdout.write(`[ok] ${target.label} fixture matches runtime regeneration\n`);
    }
  }

  if (hadMismatch) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
