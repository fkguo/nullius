import { handleToolCall } from '@nullius/orchestrator';
import { executeCli } from './cli.js';
import { coreArguments, type Context } from './policy.js';
import { guardRuntimePaths } from './paths.js';

/** Reused at both public dispatch and private delegated loopback boundaries. */
export async function execute(root: string, name: string, args: Record<string, unknown>, context?: Context) {
  if (name === 'project_cli') {
    guardRuntimePaths(root);
    return executeCli(root, args);
  }
  const parsed = coreArguments(root, name, args);
  guardRuntimePaths(root, typeof parsed.manifest_path === 'string' ? parsed.manifest_path : undefined);
  return handleToolCall(name, parsed, 'full', context);
}
