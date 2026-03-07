import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');

const workflowSchemaPath = path.join(repoRoot, 'meta/schemas/research_workflow_v1.schema.json');
const workflowTemplateDir = path.join(repoRoot, 'meta/schemas/workflow-templates');
const workflowTemplateFiles = ['original_research.json', 'reproduction.json', 'review.json'];

type WorkflowNode = {
  id: string;
  type: 'tool_call' | 'gate' | 'human_review' | 'parallel_group';
  children?: string[];
};

type WorkflowTemplate = {
  workflow_id: string;
  template: 'review' | 'original_research' | 'reproduction';
  entry_point: { variant: string; params?: Record<string, unknown> };
  nodes: WorkflowNode[];
  edges: Array<{ from: string; to: string; condition?: string }>;
  state_model?: {
    current_node?: string | null;
    completed_nodes?: string[];
    gate_outcomes?: Record<string, string>;
  };
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function ajvErrorSummary(issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) {
    return 'no ajv errors reported';
  }

  return issues
    .map((issue) => {
      const error = issue as { instancePath?: string; message?: string };
      return `${error.instancePath || '/'} ${error.message || 'schema validation failed'}`;
    })
    .join('\n');
}

function minimalWorkflow(variant: string): WorkflowTemplate {
  return {
    workflow_id: '00000000-0000-0000-0000-000000000099',
    template: 'review',
    entry_point: { variant, params: {} },
    nodes: [{ id: 'start', type: 'human_review' }],
    edges: [],
    state_model: {
      current_node: null,
      completed_nodes: [],
      gate_outcomes: {},
    },
  };
}

function assertGraphIntegrity(template: WorkflowTemplate): void {
  const nodeIds = template.nodes.map((node) => node.id);
  expect(new Set(nodeIds).size).toBe(nodeIds.length);

  const knownNodeIds = new Set(nodeIds);

  for (const edge of template.edges) {
    expect(knownNodeIds.has(edge.from), `${template.template}: missing edge.from ${edge.from}`).toBe(true);
    expect(knownNodeIds.has(edge.to), `${template.template}: missing edge.to ${edge.to}`).toBe(true);
  }

  for (const node of template.nodes) {
    if (node.type === 'parallel_group') {
      expect(Array.isArray(node.children), `${template.template}: parallel_group ${node.id} missing children`).toBe(true);
      for (const childId of node.children || []) {
        expect(knownNodeIds.has(childId), `${template.template}: parallel child ${childId} missing`).toBe(true);
      }
    }
  }

  if (template.state_model?.current_node != null) {
    expect(knownNodeIds.has(template.state_model.current_node)).toBe(true);
  }

  for (const nodeId of template.state_model?.completed_nodes || []) {
    expect(knownNodeIds.has(nodeId), `${template.template}: completed node ${nodeId} missing`).toBe(true);
  }

  for (const nodeId of Object.keys(template.state_model?.gate_outcomes || {})) {
    expect(knownNodeIds.has(nodeId), `${template.template}: gate outcome ${nodeId} missing`).toBe(true);
  }
}

describe('research workflow schema (NEW-WF-01)', () => {
  it('defines the documented four entry point variants and accepts each one', () => {
    const schema = readJson<Record<string, unknown>>(workflowSchemaPath);
    const entryPoint = (schema.$defs as Record<string, unknown>).EntryPoint as {
      properties: { variant: { enum: string[] } };
    };
    const variants = entryPoint.properties.variant.enum;

    expect(variants).toEqual([
      'from_literature',
      'from_idea',
      'from_computation',
      'from_existing_paper',
    ]);

    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(schema);

    for (const variant of variants) {
      const workflow = minimalWorkflow(variant);
      expect(validate(workflow), ajvErrorSummary(validate.errors)).toBe(true);
    }
  });

  it('ships the three documented templates and each validates against the workflow schema', () => {
    const schema = readJson<Record<string, unknown>>(workflowSchemaPath);
    const templateFiles = fs.readdirSync(workflowTemplateDir).filter((fileName) => fileName.endsWith('.json')).sort();

    expect(templateFiles).toEqual(workflowTemplateFiles);

    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(schema);

    for (const fileName of templateFiles) {
      const template = readJson<WorkflowTemplate>(path.join(workflowTemplateDir, fileName));
      expect(validate(template), `${fileName}\n${ajvErrorSummary(validate.errors)}`).toBe(true);
      assertGraphIntegrity(template);
    }
  });

  it('keeps the documented workflow-to-entry-point mapping stable', () => {
    const templates = workflowTemplateFiles.map((fileName) =>
      readJson<WorkflowTemplate>(path.join(workflowTemplateDir, fileName)),
    );

    const templateToEntryPoint = Object.fromEntries(
      templates.map((template) => [template.template, template.entry_point.variant]),
    );

    expect(templateToEntryPoint).toEqual({
      review: 'from_literature',
      original_research: 'from_idea',
      reproduction: 'from_existing_paper',
    });
  });
});
