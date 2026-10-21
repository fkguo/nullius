import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const root = new URL('../../../', import.meta.url);
const read = (relative: string) => fs.readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');

describe('workflow evidence acceptance public truth', () => {
  it.each(['README.md', 'docs/README_zh.md', 'docs/QUICKSTART.md', 'docs/ARCHITECTURE.md',
    'docs/PROJECT_STATUS.md', 'docs/URI_REGISTRY.md', 'packages/orchestrator/README.md',
    'packages/literature-workflows/README.md'])('exposes the separate acceptance surface in %s', relative => {
    expect(read(relative)).toContain('workflow_acceptance');
  });
  it('documents the exact note and current-run binding contract', () => {
    const contract = read('packages/literature-workflows/README.md');
    for (const field of ['Paper ID:', 'workflow_binding', 'plan_sha256', 'outputs_sha256', 'source_sha256', 'JSONL', 'not establish']) {
      expect(contract).toContain(field);
    }
  });
  it('keeps executable test paths in the testing guide', () => {
    const guide = read('docs/TESTING_GUIDE.md');
    for (const relative of ['packages/orchestrator/tests/workflow-acceptance.test.ts',
      'packages/orchestrator/tests/cli-run-workflow-acceptance.test.ts',
      'skills/research-team/tests/test_workflow_literature_acceptance.py']) {
      expect(guide).toContain(relative.startsWith('packages/orchestrator/') ? relative.replace('packages/orchestrator/', '') : relative);
      expect(fs.existsSync(new URL(relative, root))).toBe(true);
    }
  });
});
