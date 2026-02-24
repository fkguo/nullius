interface ToolUsageEntry {
  calls: number;
  last_called_at: string;
}

interface ToolUsageState {
  enabled: boolean;
  started_at: string;
  by_tool: Map<string, ToolUsageEntry>;
}

const state: ToolUsageState = {
  enabled: false,
  started_at: new Date().toISOString(),
  by_tool: new Map<string, ToolUsageEntry>(),
};

function parseTelemetryEnabledFromEnv(): boolean {
  const raw = process.env.HEP_ENABLE_TOOL_USAGE_TELEMETRY;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (v === '') return false;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function ensureTelemetryMode(): void {
  const nextEnabled = parseTelemetryEnabledFromEnv();
  if (nextEnabled === state.enabled) return;
  state.enabled = nextEnabled;
  state.by_tool.clear();
  state.started_at = new Date().toISOString();
}

export function recordToolUsage(toolName: string): void {
  ensureTelemetryMode();
  if (!state.enabled) return;
  const key = String(toolName).trim();
  if (!key) return;

  const now = new Date().toISOString();
  const prev = state.by_tool.get(key);
  if (!prev) {
    state.by_tool.set(key, { calls: 1, last_called_at: now });
    return;
  }

  state.by_tool.set(key, { calls: prev.calls + 1, last_called_at: now });
}

export function getToolUsageSnapshot(params?: { top_n?: number }): {
  enabled: boolean;
  started_at: string;
  total_calls: number;
  unique_tools: number;
  by_tool: Array<{ tool: string; calls: number; last_called_at: string }>;
} {
  ensureTelemetryMode();

  const rows = Array.from(state.by_tool.entries())
    .map(([tool, meta]) => ({ tool, calls: meta.calls, last_called_at: meta.last_called_at }))
    .sort((a, b) => (b.calls - a.calls) || a.tool.localeCompare(b.tool));

  const topNRaw = params?.top_n;
  const topN = Number.isFinite(topNRaw as number)
    ? Math.max(1, Math.min(Math.trunc(topNRaw as number), 200))
    : 50;

  const byTool = rows.slice(0, topN);
  const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0);

  return {
    enabled: state.enabled,
    started_at: state.started_at,
    total_calls: totalCalls,
    unique_tools: rows.length,
    by_tool: byTool,
  };
}

export function resetToolUsageTelemetryForTests(): void {
  state.by_tool.clear();
  state.started_at = new Date().toISOString();
}
