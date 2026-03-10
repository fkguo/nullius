/**
 * Provider-agnostic tool risk helpers.
 *
 * Shared keeps the risk vocabulary and lookup seam, while each provider owns
 * its own concrete tool→risk authority.
 */

export type ToolRiskLevel = 'read' | 'write' | 'destructive';
export type ToolRiskTable = Readonly<Record<string, ToolRiskLevel>>;

export function getToolRiskLevel(
  toolName: string,
  toolRiskTable: ToolRiskTable,
  fallback: ToolRiskLevel = 'read',
): ToolRiskLevel {
  return toolRiskTable[toolName] ?? fallback;
}

export function hasToolRiskEntry(toolName: string, toolRiskTable: ToolRiskTable): boolean {
  return Object.prototype.hasOwnProperty.call(toolRiskTable, toolName);
}

const RISK_ORDER: Record<ToolRiskLevel, number> = {
  read: 0,
  write: 1,
  destructive: 2,
};

/**
 * Compute the composed risk level for a chain of tools.
 * Strategy: take the highest risk level (destructive > write > read).
 * Empty array returns 'read'.
 */
export function composedRiskLevel(levels: ToolRiskLevel[]): ToolRiskLevel {
  if (levels.length === 0) return 'read';
  let max: ToolRiskLevel = 'read';
  for (const level of levels) {
    if (RISK_ORDER[level] > RISK_ORDER[max]) {
      max = level;
    }
  }
  return max;
}

/**
 * Static permission policy for tool chains (H-11b).
 */
export const PERMISSION_POLICY = {
  destructive_requires_gate: true,
  write_chain_requires_gate: false,
  max_chain_length: 10,
} as const;
