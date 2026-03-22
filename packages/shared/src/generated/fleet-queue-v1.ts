/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * This interface was referenced by `FleetQueueV1`'s JSON-Schema
 * via the `definition` "FleetQueueItem".
 */
export type FleetQueueItem = {
  queue_item_id: string;
  run_id: string;
  status: "queued" | "claimed" | "completed" | "failed" | "cancelled";
  priority: number;
  enqueued_at: string;
  requested_by: string;
  attempt_count: number;
  note?: string;
  claim?: FleetQueueClaim;
};

/**
 * Provider-neutral per-project fleet queue substrate. Records queue truth only; scheduler, lease expiry, and global health remain later layers.
 */
export interface FleetQueueV1 {
  schema_version: 1;
  updated_at: string;
  items: FleetQueueItem[];
}
/**
 * This interface was referenced by `FleetQueueV1`'s JSON-Schema
 * via the `definition` "FleetQueueClaim".
 */
export interface FleetQueueClaim {
  claim_id: string;
  owner_id: string;
  claimed_at: string;
}
