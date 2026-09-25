import { handleToolCall } from '@nullius/orchestrator';
import { verifyHarnessInvocationMarker } from '@nullius/shared';
import { executeCli } from './cli.js';
import { coreArguments, type Context } from './policy.js';
import { guardRuntimePaths } from './paths.js';
import { isStateTouchingProjectMcp } from './state-touch-classification.js';

/** Reused at both public dispatch and private delegated loopback boundaries. */
export async function execute(root: string, name: string, args: Record<string, unknown>, context?: Context) {
  if (name === 'project_cli') {
    guardRuntimePaths(root);
    verifyHarnessInvocationMarker(root, { toolIsStateTouching: isStateTouchingProjectMcp(root, name, args) });
    return executeCli(root, args);
  }
  const parsed = coreArguments(root, name, args);
  guardRuntimePaths(root, typeof parsed.manifest_path === 'string' ? parsed.manifest_path : undefined);
  verifyHarnessInvocationMarker(root, { toolIsStateTouching: isStateTouchingProjectMcp(root, name, parsed) });
  return handleToolCall(name, parsed, 'full', context);
}
