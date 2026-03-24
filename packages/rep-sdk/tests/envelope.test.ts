import { describe, expect, it } from 'vitest';
import { createEnvelope, hashCanonicalValue, parseEnvelope, serializeEnvelope } from '../src/index.js';
import { validateAsset, validateEnvelope } from '../src/validation/index.js';
import { createIntegrityReport, createOutcome, createOutcomePublishedEvent, createStrategy } from './fixtures.js';

describe('REP envelopes', () => {
  it('builds, serializes, and validates the six message types', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy);
    const event = createOutcomePublishedEvent(outcome);
    const revision = createOutcome(strategy, {
      lineage_id: outcome.lineage_id,
      version: 2,
      supersedes: outcome.outcome_id,
    });

    const envelopes = [
      createEnvelope({
        messageType: 'hello',
        senderId: 'agent-alpha',
        payload: { capabilities: ['strategy_publish'], domain: 'hep-th' },
      }),
      createEnvelope({
        messageType: 'publish',
        senderId: 'agent-alpha',
        payload: { asset_type: 'strategy', asset: strategy },
      }),
      createEnvelope({
        messageType: 'fetch',
        senderId: 'agent-alpha',
        payload: { asset_type: 'outcome', filters: { domain: 'hep-th' }, limit: 5 },
      }),
      createEnvelope({
        messageType: 'report',
        senderId: 'agent-alpha',
        payload: { event },
      }),
      createEnvelope({
        messageType: 'review',
        senderId: 'agent-beta',
        payload: { target_asset_id: outcome.outcome_id, decision: 'approve' },
      }),
      createEnvelope({
        messageType: 'revoke',
        senderId: 'agent-gamma',
        payload: {
          target_asset_id: outcome.outcome_id,
          reason: 'superseded by a new research result asset',
          superseded_by: revision.outcome_id,
        },
      }),
    ];

    for (const envelope of envelopes) {
      expect(envelope.content_hash).toBe(hashCanonicalValue(envelope.payload));
      expect(validateEnvelope(envelope).ok).toBe(true);
      expect(validateEnvelope(parseEnvelope(serializeEnvelope(envelope))).ok).toBe(true);
    }
  });

  it('validates content-addressed strategy, outcome, and integrity report assets', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy);
    const report = createIntegrityReport(outcome);
    const revision = createOutcome(strategy, {
      lineage_id: outcome.lineage_id,
      version: 2,
      supersedes: outcome.outcome_id,
    });

    expect(validateAsset('strategy', strategy).ok).toBe(true);
    expect(validateAsset('outcome', outcome).ok).toBe(true);
    expect(validateAsset('integrity_report', report).ok).toBe(true);
    expect(validateAsset('outcome', revision).ok).toBe(true);
    expect(revision.lineage_id).toBe(outcome.lineage_id);
    expect(revision.version).toBe(2);
  });

  it('requires a passed RDI gate result when publishing outcomes', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy);

    const validPublish = createEnvelope({
      messageType: 'publish',
      senderId: 'agent-alpha',
      payload: {
        asset_type: 'outcome',
        asset: outcome,
        rdi_gate_result: {
          passed: true,
          checks: [{ name: 'integrity_and_reproducibility', passed: true }],
        },
      },
    });

    const missingGate = createEnvelope({
      messageType: 'publish',
      senderId: 'agent-alpha',
      payload: {
        asset_type: 'outcome',
        asset: outcome,
      },
    });

    expect(validateEnvelope(validPublish).ok).toBe(true);
    expect(validateEnvelope(missingGate).ok).toBe(false);
  });

  it('rejects tampered content-addressed assets', () => {
    const strategy = createStrategy();
    const tamperedStrategy = {
      ...strategy,
      name: 'Tampered bootstrap contour strategy',
    };

    const result = validateAsset('strategy', tamperedStrategy);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: '/strategy_id',
      }),
    );
  });

  it('requires content_hash on publish and report envelopes', () => {
    const strategy = createStrategy();
    const outcome = createOutcome(strategy);
    const event = createOutcomePublishedEvent(outcome);

    const publishEnvelope = createEnvelope({
      messageType: 'publish',
      senderId: 'agent-alpha',
      payload: { asset_type: 'strategy', asset: strategy },
    });
    const reportEnvelope = createEnvelope({
      messageType: 'report',
      senderId: 'agent-alpha',
      payload: { event },
    });

    delete publishEnvelope.content_hash;
    delete reportEnvelope.content_hash;

    expect(validateEnvelope(publishEnvelope).ok).toBe(false);
    expect(validateEnvelope(reportEnvelope).ok).toBe(false);
  });
});
