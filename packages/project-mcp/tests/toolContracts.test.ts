import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectAdapter } from '../src/adapter.js';
import { coreSpecs } from '../src/policy.js';
import { toolsList } from '../src/registry.js';

const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-project-contract-')));
  roots.push(root);
  return { root, adapter: new ProjectAdapter(root) };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('MCP annotations and titles', () => {
  it('every listed tool carries a non-empty title and all four boolean hints', () => {
    const issues: string[] = [];
    const tools = toolsList();
    expect(tools).toHaveLength(5 + coreSpecs.length);
    for (const tool of tools) {
      if (typeof tool.title !== 'string' || tool.title.trim() === '') issues.push(`${tool.name}: missing title`);
      const annotations = tool.annotations as unknown as Record<string, unknown>;
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        if (typeof annotations?.[hint] !== 'boolean') issues.push(`${tool.name}: ${hint} is not a boolean`);
      }
    }
    expect(issues).toEqual([]);
  });

  it('orchestrator tools follow execution_policy.mutation_class', () => {
    const byName = new Map(toolsList().map(t => [t.name, t]));
    for (const spec of coreSpecs) {
      const readOnly = spec.execution_policy.mutation_class === 'read_only';
      expect(byName.get(spec.name)!.annotations.readOnlyHint, spec.name).toBe(readOnly);
      expect(byName.get(spec.name)!.annotations.destructiveHint, spec.name).toBe(!readOnly);
    }
  });
});

describe('structuredContent', () => {
  it('mirrors the JSON text block of a result and is absent on errors', async () => {
    // A delivery replay (project_delivery_read) carries the envelope object;
    // the stored inner result keeps its original text-only form.
    const { adapter } = fixture();
    const result = await adapter.call('project_capabilities', {});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0]!.text));

    // An orchestrator tool answered in the foreground: its text block is passed through.
    const policy = await adapter.call('orch_policy_query', {});
    expect(policy.isError, JSON.stringify(policy)).not.toBe(true);
    expect(policy.structuredContent).toEqual(JSON.parse(policy.content[0]!.text));

    const failed = await adapter.call('project_file_read', { path: '../outside' });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toBeUndefined();
  });
});
