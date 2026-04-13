import { resolveWorkflowRecipe } from './resolver.js';

type ParsedArgs = {
  command: 'resolve';
  recipe: string;
  phase?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== 'resolve') {
    throw new Error('usage: tsx src/cli.ts resolve --recipe <recipe_id> [--phase <phase>]');
  }

  let recipe: string | undefined;
  let phase: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (current === '--recipe') {
      recipe = rest[index + 1];
      index += 1;
      continue;
    }
    if (current === '--phase') {
      phase = rest[index + 1];
      index += 1;
      continue;
    }
  }

  if (!recipe) {
    throw new Error('usage: tsx src/cli.ts resolve --recipe <recipe_id> [--phase <phase>]');
  }
  return { command: 'resolve', recipe, phase };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const rawInput = await readStdin();
  const input = rawInput.trim().length > 0 ? JSON.parse(rawInput) as unknown : {};
  const payload = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};

  if (parsedArgs.command === 'resolve') {
    const resolved = resolveWorkflowRecipe({
      recipe_id: parsedArgs.recipe,
      phase: parsedArgs.phase,
      inputs: payload.inputs && typeof payload.inputs === 'object' && !Array.isArray(payload.inputs)
        ? payload.inputs as Record<string, unknown>
        : {},
      preferred_providers: Array.isArray(payload.preferred_providers)
        ? payload.preferred_providers as Array<'inspire' | 'openalex' | 'arxiv' | 'zotero' | 'crossref' | 'datacite' | 'github' | 'doi'>
        : [],
      allowed_providers: Array.isArray(payload.allowed_providers)
        ? payload.allowed_providers as Array<'inspire' | 'openalex' | 'arxiv' | 'zotero' | 'crossref' | 'datacite' | 'github' | 'doi'>
        : undefined,
      available_tools: Array.isArray(payload.available_tools)
        ? payload.available_tools.map(value => String(value))
        : undefined,
    });
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
