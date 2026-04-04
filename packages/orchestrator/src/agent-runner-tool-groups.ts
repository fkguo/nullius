import type { ToolUseContent } from './backends/chat-backend.js';
import type { ToolCaller } from './mcp-client.js';
import { isParallelBatchSafeToolExecutionPolicy, resolveToolExecutionPolicy } from './tool-execution-policy.js';

export function groupToolUsesForExecution(
  toolUses: ReadonlyArray<ToolUseContent>,
  toolCaller: ToolCaller,
): ToolUseContent[][] {
  const groups: ToolUseContent[][] = [];
  let batchSafeGroup: ToolUseContent[] = [];

  const flushBatchSafeGroup = () => {
    if (batchSafeGroup.length === 0) {
      return;
    }
    groups.push(batchSafeGroup);
    batchSafeGroup = [];
  };

  for (const toolUse of toolUses) {
    const policy = toolCaller.getExecutionPolicy?.(toolUse.name) ?? resolveToolExecutionPolicy(toolUse.name);
    if (isParallelBatchSafeToolExecutionPolicy(policy)) {
      batchSafeGroup.push(toolUse);
      continue;
    }
    flushBatchSafeGroup();
    groups.push([toolUse]);
  }

  flushBatchSafeGroup();
  return groups;
}
