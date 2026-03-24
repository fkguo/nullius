import * as fs from 'fs';
import * as path from 'path';
import { WorkflowRecipeSchema, type WorkflowRecipe } from './types.js';

function findRepoRoot(fromDir: string): string {
  let current = fromDir;
  while (true) {
    if (fs.existsSync(path.join(current, 'meta', 'recipes'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from ${fromDir}`);
    }
    current = parent;
  }
}

export function getRecipeDir(fromDir = path.dirname(new URL(import.meta.url).pathname)): string {
  const repoRoot = findRepoRoot(path.resolve(fromDir));
  return path.join(repoRoot, 'meta', 'recipes');
}

export function loadWorkflowRecipe(recipeId: string): WorkflowRecipe {
  const recipePath = path.join(getRecipeDir(), `${recipeId}.json`);
  if (!fs.existsSync(recipePath)) {
    throw new Error(`Workflow recipe not found: ${recipeId}`);
  }
  const raw = JSON.parse(fs.readFileSync(recipePath, 'utf-8')) as unknown;
  return WorkflowRecipeSchema.parse(raw);
}
