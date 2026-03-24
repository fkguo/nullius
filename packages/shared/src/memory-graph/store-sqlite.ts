import { decayWeight, laplaceProbability } from './decay.js';
import type { CandidateEdgeStat, MemoryGraphStore } from './store.js';
import type { EpigeneticMark } from '../generated/index.js';
import type { CapsuleWithMeta, MemoryGraphEdge, MemoryGraphEvent, MemoryGraphNode, NodeSummary, SignalFrequencyResult } from './types.js';
import { execSql, queryJson, resolveDbPath, sqlJsonLiteral, sqlStringLiteral } from './sqlite-cli.js';
import { MEMORY_GRAPH_SCHEMA_SQL, withReadPragmas, withWritePragmas } from './sqlite-schema.js';
import { addEdgeRecord, addNodeRecord, applyNodeDecayUpdatesRecord, archivalCandidatesRecord, findSimilarCapsulesRecord, listNodeDecayInputsRecord, updateGeneMarksRecord } from './store-sqlite-graph.js';

interface EventRow {
  id: number;
  event_type: MemoryGraphEvent['event_type'];
  run_id: string | null;
  trace_id: string | null;
  payload: string;
  created_at: string;
}

export function createSqliteMemoryGraphStore(dbPath: string): MemoryGraphStore {
  return new SqliteMemoryGraphStore(dbPath);
}

class SqliteMemoryGraphStore implements MemoryGraphStore {
  readonly dbPath: string;
  private initPromise: Promise<void> | null = null;

  constructor(dbPath: string) {
    this.dbPath = resolveDbPath(dbPath);
  }

  async ensureInitialized(): Promise<void> {
    this.initPromise ??= execSql(this.dbPath, withWritePragmas(MEMORY_GRAPH_SCHEMA_SQL)).then(() => undefined);
    await this.initPromise;
  }

  async insertEvent(event: { eventType: MemoryGraphEvent['event_type']; runId?: string | null; traceId?: string | null; payload: Record<string, unknown>; createdAt?: string }): Promise<void> {
    await this.ensureInitialized();
    const createdAt = event.createdAt ?? new Date().toISOString();
    const sql = withWritePragmas(`
      INSERT INTO mg_events(event_type, run_id, trace_id, payload, created_at)
      VALUES (${sqlStringLiteral(event.eventType)}, ${event.runId ? sqlStringLiteral(event.runId) : 'NULL'},
        ${event.traceId ? sqlStringLiteral(event.traceId) : 'NULL'}, ${sqlJsonLiteral(event.payload)}, ${sqlStringLiteral(createdAt)})
    `);
    await execSql(this.dbPath, sql);
  }

  async getOutcomeEventsAfter(lastEventId: number): Promise<MemoryGraphEvent[]> {
    await this.ensureInitialized();
    const rows = await queryJson<EventRow>(this.dbPath, withReadPragmas(`
      SELECT id, event_type, run_id, trace_id, payload, created_at
      FROM mg_events WHERE event_type = 'outcome' AND id > ${lastEventId} ORDER BY id ASC
    `), { readonly: true });
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }

  async getRecentEvents(limit: number): Promise<MemoryGraphEvent[]> {
    await this.ensureInitialized();
    const rows = await queryJson<EventRow>(this.dbPath, withReadPragmas(`
      SELECT id, event_type, run_id, trace_id, payload, created_at
      FROM mg_events ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `), { readonly: true });
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }

  async upsertSignalSet(signalKey: string, normalizedSignals: string[]): Promise<void> {
    await this.ensureInitialized();
    const sql = withWritePragmas(`
      INSERT INTO mg_signal_sets(signal_key, normalized_signals)
      VALUES (${sqlStringLiteral(signalKey)}, ${sqlJsonLiteral(normalizedSignals)})
      ON CONFLICT(signal_key) DO UPDATE SET normalized_signals = excluded.normalized_signals
    `);
    await execSql(this.dbPath, sql);
  }

  async incrementSignalFrequency(signalKey: string, signalValue: string, ts = new Date().toISOString()): Promise<void> {
    await this.ensureInitialized();
    const bucketStart = `${ts.slice(0, 10)}T00:00:00.000Z`;
    const sql = withWritePragmas(`
      INSERT INTO mg_signal_freq(signal_key, signal_value, window_start, count, last_seen)
      VALUES (${sqlStringLiteral(signalKey)}, ${sqlStringLiteral(signalValue)}, ${sqlStringLiteral(bucketStart)}, 1, ${sqlStringLiteral(ts)})
      ON CONFLICT(signal_key, signal_value, window_start)
      DO UPDATE SET count = count + 1, last_seen = excluded.last_seen
    `);
    await execSql(this.dbPath, sql);
  }

  async topSignals(windowDays: number, limit: number): Promise<SignalFrequencyResult[]> {
    await this.ensureInitialized();
    const rows = await queryJson<Array<{ signal_value: string; total_count: number }>[number]>(this.dbPath, withReadPragmas(`
      SELECT signal_value, SUM(count) AS total_count
      FROM mg_signal_freq WHERE last_seen >= datetime('now', '-${windowDays} days')
      GROUP BY signal_value ORDER BY total_count DESC, signal_value ASC LIMIT ${limit}
    `), { readonly: true });
    return rows.map(row => ({ signal: row.signal_value, count: Number(row.total_count) }));
  }

  async highFrequencySignals(threshold: number, windowDays: number): Promise<string[]> {
    await this.ensureInitialized();
    const rows = await queryJson<Array<{ signal_value: string }>[number]>(this.dbPath, withReadPragmas(`
      SELECT signal_value
      FROM mg_signal_freq WHERE last_seen >= datetime('now', '-${windowDays} days')
      GROUP BY signal_value HAVING SUM(count) >= ${threshold}
      ORDER BY signal_value ASC
    `), { readonly: true });
    return rows.map(row => row.signal_value);
  }

  async getCandidateEdgeStats(normalizedSignals: string[], recencyWindowDays: number, candidateLimit: number): Promise<CandidateEdgeStat[]> {
    await this.ensureInitialized();
    if (normalizedSignals.length === 0) return [];
    const signalList = normalizedSignals.map(sqlStringLiteral).join(', ');
    return queryJson<CandidateEdgeStat>(this.dbPath, withReadPragmas(`
      WITH candidate_keys AS (
        SELECT DISTINCT signal_key FROM mg_signal_freq
        WHERE signal_value IN (${signalList}) AND last_seen >= datetime('now', '-${recencyWindowDays} days')
        LIMIT ${candidateLimit}
      )
      SELECT s.signal_key, s.gene_id, s.success, s.fail, s.total, s.last_ts, s.laplace_p, s.decay_w, ss.normalized_signals
      FROM mg_edge_stats s JOIN mg_signal_sets ss USING(signal_key)
      WHERE s.signal_key IN (SELECT signal_key FROM candidate_keys)
    `), { readonly: true });
  }

  async upsertEdgeStat(input: { signalKey: string; geneId: string; success: boolean; eventTs: string; halfLifeDays: number }): Promise<void> {
    await this.ensureInitialized();
    const existing = await queryJson<Array<{ success: number; fail: number; total: number }>[number]>(
      this.dbPath,
      withReadPragmas(`
        SELECT success, fail, total FROM mg_edge_stats
        WHERE signal_key = ${sqlStringLiteral(input.signalKey)} AND gene_id = ${sqlStringLiteral(input.geneId)}
      `),
      { readonly: true },
    );
    const previous = existing[0] ?? { success: 0, fail: 0, total: 0 };
    const success = previous.success + (input.success ? 1 : 0);
    const fail = previous.fail + (input.success ? 0 : 1);
    const total = previous.total + 1;
    const laplace = laplaceProbability(success, total);
    const decay = decayWeight(input.eventTs, new Date(), input.halfLifeDays);
    const sql = withWritePragmas(`
      INSERT INTO mg_edge_stats(signal_key, gene_id, success, fail, total, last_ts, laplace_p, decay_w)
      VALUES (${sqlStringLiteral(input.signalKey)}, ${sqlStringLiteral(input.geneId)}, ${success}, ${fail},
        ${total}, ${sqlStringLiteral(input.eventTs)}, ${laplace}, ${decay})
      ON CONFLICT(signal_key, gene_id)
      DO UPDATE SET success = excluded.success, fail = excluded.fail, total = excluded.total,
        last_ts = excluded.last_ts, laplace_p = excluded.laplace_p, decay_w = excluded.decay_w
    `);
    await execSql(this.dbPath, sql);
  }

  async getGenePriorsBatch(geneIds: string[]): Promise<Map<string, number>> {
    await this.ensureInitialized();
    if (geneIds.length === 0) return new Map();
    const rows = await queryJson<Array<{ gene_id: string; prior: number }>[number]>(this.dbPath, withReadPragmas(`
      SELECT gene_id, prior FROM mg_gene_priors WHERE gene_id IN (${geneIds.map(sqlStringLiteral).join(', ')})
    `), { readonly: true });
    return new Map(rows.map(row => [row.gene_id, Number(row.prior)]));
  }

  async upsertGenePrior(update: { geneId: string; success: boolean; eventTs: string }): Promise<void> {
    await this.ensureInitialized();
    const existing = await queryJson<Array<{ success: number; fail: number; total: number }>[number]>(this.dbPath, withReadPragmas(`
      SELECT success, fail, total FROM mg_gene_priors WHERE gene_id = ${sqlStringLiteral(update.geneId)}
    `), { readonly: true });
    const previous = existing[0] ?? { success: 0, fail: 0, total: 0 };
    const success = previous.success + (update.success ? 1 : 0);
    const fail = previous.fail + (update.success ? 0 : 1);
    const total = previous.total + 1;
    const sql = withWritePragmas(`
      INSERT INTO mg_gene_priors(gene_id, success, fail, total, last_ts, prior)
      VALUES (${sqlStringLiteral(update.geneId)}, ${success}, ${fail}, ${total},
        ${sqlStringLiteral(update.eventTs)}, ${laplaceProbability(success, total)})
      ON CONFLICT(gene_id)
      DO UPDATE SET success = excluded.success, fail = excluded.fail, total = excluded.total,
        last_ts = excluded.last_ts, prior = excluded.prior
    `);
    await execSql(this.dbPath, sql);
  }

  async getAggregationWatermark(): Promise<{ last_event_id: number } | null> {
    await this.ensureInitialized();
    const rows = await queryJson<Array<{ last_event_id: number }>[number]>(this.dbPath, withReadPragmas(`
      SELECT last_event_id FROM mg_aggregation_watermark WHERE id = 1
    `), { readonly: true });
    return rows[0] ?? null;
  }

  async setAggregationWatermark(lastEventId: number): Promise<void> {
    await this.ensureInitialized();
    const sql = withWritePragmas(`
      INSERT INTO mg_aggregation_watermark(id, last_event_id) VALUES (1, ${lastEventId})
      ON CONFLICT(id) DO UPDATE SET last_event_id = excluded.last_event_id
    `);
    await execSql(this.dbPath, sql);
  }

  addNode(node: Omit<MemoryGraphNode, 'id' | 'created_at' | 'updated_at'>): Promise<string> { return addNodeRecord(this, node); }
  addEdge(edge: Omit<MemoryGraphEdge, 'id' | 'created_at'>): Promise<string> { return addEdgeRecord(this, edge); }
  updateGeneMarks(geneId: string, marks: EpigeneticMark[]): Promise<void> { return updateGeneMarksRecord(this, geneId, marks); }
  archivalCandidates(weightThreshold: number): Promise<NodeSummary[]> { return archivalCandidatesRecord(this, weightThreshold); }
  listNodeDecayInputs() { return listNodeDecayInputsRecord(this); }
  applyNodeDecayUpdates(updates: Array<{ id: string; weight: number; decayTs: string }>) { return applyNodeDecayUpdatesRecord(this, updates); }
  findSimilarCapsules(normalizedTrigger: string[], jaccardThreshold: number): Promise<CapsuleWithMeta[]> {
    return findSimilarCapsulesRecord(this, normalizedTrigger, jaccardThreshold);
  }
}
