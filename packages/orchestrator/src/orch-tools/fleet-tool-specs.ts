import { z } from 'zod';
import {
  ORCH_FLEET_ADJUDICATE_STALE_CLAIM,
  ORCH_FLEET_CLAIM,
  ORCH_FLEET_ENQUEUE,
  ORCH_FLEET_REASSIGN_CLAIM,
  ORCH_FLEET_RELEASE,
  ORCH_FLEET_STATUS,
  ORCH_FLEET_WORKER_HEARTBEAT,
  ORCH_FLEET_WORKER_POLL,
  ORCH_FLEET_WORKER_SET_CLAIM_ACCEPTANCE,
  ORCH_FLEET_WORKER_UNREGISTER,
} from '@autoresearch/shared';
import {
  handleOrchFleetAdjudicateStaleClaim,
  handleOrchFleetClaim,
  handleOrchFleetEnqueue,
  handleOrchFleetRelease,
} from './fleet-queue-tools.js';
import { handleOrchFleetReassignClaim } from './fleet-claim-reassignment.js';
import { handleOrchFleetWorkerSetClaimAcceptance } from './fleet-worker-claim-acceptance.js';
import { handleOrchFleetWorkerUnregister } from './fleet-worker-unregister.js';
import { handleOrchFleetStatus } from './fleet-status.js';
import {
  handleOrchFleetWorkerHeartbeat,
  handleOrchFleetWorkerPoll,
} from './fleet-worker-tools.js';
import {
  OrchFleetAdjudicateStaleClaimSchema,
  OrchFleetClaimSchema,
  OrchFleetEnqueueSchema,
  OrchFleetReassignClaimSchema,
  OrchFleetReleaseSchema,
  OrchFleetStatusSchema,
  OrchFleetWorkerHeartbeatSchema,
  OrchFleetWorkerPollSchema,
  OrchFleetWorkerSetClaimAcceptanceSchema,
  OrchFleetWorkerUnregisterSchema,
} from './schemas.js';

export const FLEET_TOOL_SPECS = [
  {
    name: ORCH_FLEET_ADJUDICATE_STALE_CLAIM,
    tier: 'core',
    exposure: 'full',
    description: 'Manually adjudicate a currently claimed fleet queue item that appears stale, then settle it back onto the existing queue substrate without creating automatic takeover semantics (local-only).',
    zodSchema: OrchFleetAdjudicateStaleClaimSchema,
    handler: async (params: unknown) => handleOrchFleetAdjudicateStaleClaim(params as z.output<typeof OrchFleetAdjudicateStaleClaimSchema>),
  },
  {
    name: ORCH_FLEET_REASSIGN_CLAIM,
    tier: 'core',
    exposure: 'full',
    description: 'Explicitly reassign a currently claimed fleet queue item from one registered owner worker to a different registered target worker inside the same project queue, without changing worker registry authority or introducing scheduler-like takeover semantics (local-only).',
    zodSchema: OrchFleetReassignClaimSchema,
    handler: async (params: unknown) => handleOrchFleetReassignClaim(params as z.output<typeof OrchFleetReassignClaimSchema>),
  },
  {
    name: ORCH_FLEET_WORKER_POLL,
    tier: 'core',
    exposure: 'full',
    description: 'Refresh worker liveness and claim the next queued run for that worker when capacity is available (local-only). This is the only Batch 3 scheduler surface.',
    zodSchema: OrchFleetWorkerPollSchema,
    handler: async (params: unknown) => handleOrchFleetWorkerPoll(params as z.output<typeof OrchFleetWorkerPollSchema>),
  },
  {
    name: ORCH_FLEET_WORKER_HEARTBEAT,
    tier: 'core',
    exposure: 'full',
    description: 'Refresh or register fleet worker liveness/resource-slot metadata without claiming queue ownership (local-only).',
    zodSchema: OrchFleetWorkerHeartbeatSchema,
    handler: async (params: unknown) => handleOrchFleetWorkerHeartbeat(params as z.output<typeof OrchFleetWorkerHeartbeatSchema>),
  },
  {
    name: ORCH_FLEET_WORKER_SET_CLAIM_ACCEPTANCE,
    tier: 'core',
    exposure: 'full',
    description: 'Update whether an existing fleet worker may claim new queue items, without changing queue ownership or creating a second scheduler surface (local-only).',
    zodSchema: OrchFleetWorkerSetClaimAcceptanceSchema,
    handler: async (params: unknown) => handleOrchFleetWorkerSetClaimAcceptance(params as z.output<typeof OrchFleetWorkerSetClaimAcceptanceSchema>),
  },
  {
    name: ORCH_FLEET_WORKER_UNREGISTER,
    tier: 'core',
    exposure: 'full',
    description: 'Remove a drained worker from fleet_workers.json only after explicit claim acceptance shutdown and zero active claims, without mutating fleet_queue.json or creating a second scheduler surface (local-only).',
    zodSchema: OrchFleetWorkerUnregisterSchema,
    handler: async (params: unknown) => handleOrchFleetWorkerUnregister(params as z.output<typeof OrchFleetWorkerUnregisterSchema>),
  },
  {
    name: ORCH_FLEET_ENQUEUE,
    tier: 'core',
    exposure: 'full',
    description: 'Enqueue a known run into the per-project fleet queue substrate (local-only). Fails closed if the run is unknown or already has an active queue item.',
    zodSchema: OrchFleetEnqueueSchema,
    handler: async (params: unknown) => handleOrchFleetEnqueue(params as z.output<typeof OrchFleetEnqueueSchema>),
  },
  {
    name: ORCH_FLEET_CLAIM,
    tier: 'core',
    exposure: 'full',
    description: 'Claim the next queued run, or a specific queued run, from the per-project fleet queue substrate (local-only). Does not start a scheduler; Batch 3 scheduling lives only in orch_fleet_worker_poll.',
    zodSchema: OrchFleetClaimSchema,
    handler: async (params: unknown) => handleOrchFleetClaim(params as z.output<typeof OrchFleetClaimSchema>),
  },
  {
    name: ORCH_FLEET_RELEASE,
    tier: 'core',
    exposure: 'full',
    description: 'Release a claimed queue item back to queued, or settle it to a terminal fleet-queue status, inside the per-project fleet queue substrate (local-only).',
    zodSchema: OrchFleetReleaseSchema,
    handler: async (params: unknown) => handleOrchFleetRelease(params as z.output<typeof OrchFleetReleaseSchema>),
  },
  {
    name: ORCH_FLEET_STATUS,
    tier: 'core',
    exposure: 'full',
    description: 'Aggregate read-only fleet visibility across explicit project roots using existing run-level state, ledger, approval packet, queue, and worker surfaces (local-only).',
    zodSchema: OrchFleetStatusSchema,
    handler: async (params: unknown) => handleOrchFleetStatus(params as z.output<typeof OrchFleetStatusSchema>),
  },
] as const;
