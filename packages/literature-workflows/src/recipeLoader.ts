import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { WorkflowRecipeSchema, type WorkflowRecipe } from './types.js';

export function getRecipeDir(): string {
  return path.resolve(fileURLToPath(new URL('../recipes/', import.meta.url)));
}

export function loadWorkflowRecipe(recipeId: string): WorkflowRecipe {
  const recipePath = path.join(getRecipeDir(), `${recipeId}.json`);
  if (!fs.existsSync(recipePath)) {
    throw new Error(`Workflow recipe not found: ${recipeId}`);
  }
  const raw = JSON.parse(fs.readFileSync(recipePath, 'utf-8')) as unknown;
  return WorkflowRecipeSchema.parse(raw);
}
