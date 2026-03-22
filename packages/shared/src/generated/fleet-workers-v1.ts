/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Provider-neutral per-project fleet worker registry. Records worker liveness and resource-slot truth only; queue ownership stays in fleet_queue_v1 and scheduler decisions remain transient.
 */
export interface FleetWorkersV1 {
  schema_version: 1;
  updated_at: string;
  workers: FleetWorker[];
}
/**
 * This interface was referenced by `FleetWorkersV1`'s JSON-Schema
 * via the `definition` "FleetWorker".
 */
export interface FleetWorker {
  worker_id: string;
  registered_at: string;
  last_heartbeat_at: string;
  max_concurrent_claims: number;
  heartbeat_timeout_seconds: number;
  note?: string;
}
