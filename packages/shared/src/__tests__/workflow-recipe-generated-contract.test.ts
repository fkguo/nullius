import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkflowTaskKindSchema } from '../types/task-projection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const generatedFile = path.resolve(__dirname, '../generated/workflow-recipe-v1.ts');

describe('workflow-recipe generated contract', () => {
  it('preserves a typed step union instead of collapsing to unknown-object variants', () => {
    const source = fs.readFileSync(generatedFile, 'utf-8');

    expect(source).toContain('id: string;');
    expect(source).toContain('task_kind:');
    expect(source).not.toContain('task_kind?:');
    for (const taskKind of WorkflowTaskKindSchema.options) {
      expect(source).toContain(`"${taskKind}"`);
    }
    expect(source).toContain('purpose: string;');
    expect(source).toContain('tool: string;');
    expect(source).toContain('action:');
    expect(source).not.toContain('analyze.paper_set_critical_review');
    expect(source).not.toContain('analysis.paper_set_critical_review');
    expect(source).not.toContain('| {\n          [k: string]: unknown;');
  });
});
