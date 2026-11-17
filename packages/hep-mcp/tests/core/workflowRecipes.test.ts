import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { WorkflowTaskKindSchema } from '@nullius/shared';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const recipeSchemaPath = path.join(repoRoot, 'meta/schemas/workflow_recipe_v1.schema.json');
const recipeDir = path.join(repoRoot, 'packages/literature-workflows/recipes');
const recipeFiles = fs.readdirSync(recipeDir).filter(name => name.endsWith('.json')).sort();
const recipeSchema = JSON.parse(fs.readFileSync(recipeSchemaPath, 'utf-8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(recipeSchema);

function readRecipe(name: string): { steps: Record<string, unknown>[]; [key: string]: unknown } {
  return JSON.parse(fs.readFileSync(path.join(recipeDir, name), 'utf-8'));
}

describe('workflow recipe schema and fixtures', () => {
  it('covers all three checked-in recipes', () => {
    expect(recipeFiles).toEqual([
      'literature_gap_analysis.json',
      'literature_landscape.json',
      'research_brainstorm.json',
    ]);
  });

  it('keeps task kinds aligned with the shared task projection contract', () => {
    expect(recipeSchema.properties.steps.items.properties.task_kind.enum).toEqual(
      WorkflowTaskKindSchema.options,
    );
  });

  it.each(recipeFiles)('%s validates against the Draft 2020-12 recipe schema', name => {
    expect(validate(readRecipe(name)), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('rejects a missing task kind even when the action branch matches', () => {
    const recipe = readRecipe('literature_landscape.json');
    delete recipe.steps[0].task_kind;

    expect(validate(recipe)).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'required', params: { missingProperty: 'task_kind' } }),
    ]));
  });

  it('rejects an unknown task kind', () => {
    const recipe = readRecipe('literature_landscape.json');
    recipe.steps[0].task_kind = 'automatic_scientific_judgment';

    expect(validate(recipe)).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'enum', instancePath: '/steps/0/task_kind' }),
    ]));
  });

  it('rejects the retired provider critical-review action and capability', () => {
    const recipe = readRecipe('literature_landscape.json');
    recipe.steps[0].action = 'analyze.paper_set_critical_review';
    recipe.steps[0].required_capabilities = ['analysis.paper_set_critical_review'];

    expect(validate(recipe)).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'enum', instancePath: '/steps/0/action' }),
      expect.objectContaining({ keyword: 'enum', instancePath: '/steps/0/required_capabilities/0' }),
    ]));
  });

  it('enforces sibling properties after a tool/action anyOf branch matches', () => {
    const recipe = readRecipe('research_brainstorm.json');
    recipe.steps[0].undeclared_field = true;

    expect(validate(recipe)).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        keyword: 'additionalProperties',
        instancePath: '/steps/0',
        params: { additionalProperty: 'undeclared_field' },
      }),
    ]));
  });

  it('rejects a step without either action or tool', () => {
    const recipe = readRecipe('literature_landscape.json');
    delete recipe.steps[0].action;
    delete recipe.steps[0].tool;

    expect(validate(recipe)).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: 'anyOf', instancePath: '/steps/0' }),
    ]));
  });
});
