#!/usr/bin/env node

import { resolveWorkflowRecipe } from './resolver.js';
import type { ResolveWorkflowRequest, WorkflowProviderId } from './types.js';

function parseArgs(argv: string[]): { recipeId: string; phase?: string } {
  if (argv[0] !== 'resolve') {
    throw new Error('Usage: literature-workflows resolve --recipe <recipe_id> [--phase <phase>] < request.json');
  }
  let recipeId = '';
  let phase: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--recipe') {
      recipeId = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--phase') {
      phase = argv[index + 1] ?? '';
      index += 1;
    }
  }
  if (!recipeId) {
    throw new Error('Missing required --recipe <recipe_id>');
  }
  return { recipeId, phase };
}

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const { recipeId, phase } = parseArgs(process.argv.slice(2));
  const body = await readStdin();
  const request = body as Partial<ResolveWorkflowRequest>;
  const plan = resolveWorkflowRecipe({
    recipe_id: recipeId,
    phase,
    inputs: (request.inputs as Record<string, unknown> | undefined) ?? body,
    preferred_providers: Array.isArray(request.preferred_providers)
      ? request.preferred_providers as WorkflowProviderId[]
      : [],
    allowed_providers: Array.isArray(request.allowed_providers)
      ? request.allowed_providers as WorkflowProviderId[]
      : undefined,
    available_tools: Array.isArray(request.available_tools)
      ? request.available_tools as string[]
      : undefined,
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
