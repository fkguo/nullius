import { afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getRunArtifactPath } from '../../src/core/paths.js';
import { parseHepRunArtifactUri } from '../../src/core/runArtifactUri.js';

vi.mock('@autoresearch/zotero-mcp/tooling', () => ({
  TOOL_SPECS: [],
}));
vi.mock('../../src/core/zotero/tools.js', () => ({
  hepImportFromZotero: vi.fn(),
}));

let tmpDirs: string[] = [];

export function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agent-runtime-'));
  tmpDirs.push(dir);
  return dir;
}

export function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  const artifactUri = payload._result_too_large === true && typeof payload.artifact_uri === 'string'
    ? payload.artifact_uri
    : null;
  if (!artifactUri) return payload;

  const parsed = parseHepRunArtifactUri(artifactUri);
  if (!parsed) {
    throw new Error(`Invalid run artifact URI in oversized result envelope: ${artifactUri}`);
  }

  const stored = JSON.parse(
    fs.readFileSync(getRunArtifactPath(parsed.runId, parsed.artifactName), 'utf-8'),
  ) as { result?: Record<string, unknown> };
  return stored.result ?? stored;
}

export function ledgerLineCount(projectRoot: string): number {
  const ledgerPath = path.join(projectRoot, '.autoresearch', 'ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) return 0;
  return fs.readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean).length;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});
