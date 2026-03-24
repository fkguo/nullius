import { SQLITE_WAL_PRAGMAS } from '../db/sqlite-utils.js';

export const MEMORY_GRAPH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mg_nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  track TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decay_ts TEXT,
  weight REAL NOT NULL DEFAULT 1.0
);
CREATE TABLE IF NOT EXISTS mg_edges (
  id TEXT PRIMARY KEY,
  edge_type TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES mg_nodes(id),
  target_id TEXT NOT NULL REFERENCES mg_nodes(id),
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0
);
CREATE TABLE IF NOT EXISTS mg_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  run_id TEXT,
  trace_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS mg_edge_stats (
  signal_key TEXT NOT NULL,
  gene_id TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  last_ts TEXT NOT NULL,
  laplace_p REAL NOT NULL DEFAULT 0.5,
  decay_w REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (signal_key, gene_id)
);
CREATE TABLE IF NOT EXISTS mg_signal_freq (
  signal_key TEXT NOT NULL,
  signal_value TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (signal_key, signal_value, window_start)
);
CREATE TABLE IF NOT EXISTS mg_signal_sets (
  signal_key TEXT PRIMARY KEY,
  normalized_signals TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS mg_aggregation_watermark (
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_event_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mg_gene_priors (
  gene_id TEXT PRIMARY KEY,
  success INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  last_ts TEXT NOT NULL,
  prior REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_mg_events_type ON mg_events(event_type);
CREATE INDEX IF NOT EXISTS idx_mg_events_ts ON mg_events(created_at);
CREATE INDEX IF NOT EXISTS idx_mg_signal_freq_value_seen ON mg_signal_freq(signal_value, last_seen);
CREATE INDEX IF NOT EXISTS idx_mg_nodes_type ON mg_nodes(node_type);
`;

export function withReadPragmas(sql: string): string {
  return sql;
}

export function withWritePragmas(sql: string): string {
  return [SQLITE_WAL_PRAGMAS[0], sql].join(';\n') + ';';
}
