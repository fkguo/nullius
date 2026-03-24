import type { RepEnvelope } from '../model/rep-envelope.js';
import { hashCanonicalValue } from '../protocol/content-hash.js';
import { validateAsset } from './asset-validation.js';
import { getSchemaValidator, toValidationIssues } from './schema-registry.js';
import { prefixIssues, validationFailure, validationSuccess, type ValidationResult } from './result.js';

const envelopeValidator = getSchemaValidator('rep_envelope_v1');
const eventValidator = getSchemaValidator('research_event_v1');

export function validateEnvelope(input: unknown): ValidationResult<RepEnvelope> {
  if (!envelopeValidator(input)) {
    return validationFailure(toValidationIssues(envelopeValidator.errors));
  }

  const envelope = input as RepEnvelope;
  const expectedHash = hashCanonicalValue(envelope.payload);
  const requiresContentHash =
    envelope.message_type === 'publish' || envelope.message_type === 'report';

  if (requiresContentHash && envelope.content_hash === undefined) {
    return validationFailure([
      {
        path: '/content_hash',
        message: 'Envelope content_hash is required for publish and report messages.',
      },
    ]);
  }

  if (envelope.content_hash !== undefined && envelope.content_hash !== expectedHash) {
    return validationFailure([
      {
        path: '/content_hash',
        message: 'Envelope content_hash does not match the canonical payload hash.',
      },
    ]);
  }

  if (envelope.message_type === 'publish') {
    const assetResult = validateAsset(envelope.payload.asset_type, envelope.payload.asset);
    if (!assetResult.ok) {
      return validationFailure(prefixIssues('/payload/asset', assetResult.issues));
    }

    if (envelope.payload.asset_type === 'outcome' && envelope.payload.rdi_gate_result?.passed !== true) {
      return validationFailure([
        {
          path: '/payload/rdi_gate_result',
          message: 'Outcome publication requires a passed rdi_gate_result.',
        },
      ]);
    }
  }

  if (envelope.message_type === 'report') {
    if (!eventValidator(envelope.payload.event)) {
      return validationFailure(prefixIssues('/payload/event', toValidationIssues(eventValidator.errors)));
    }
  }

  return validationSuccess(envelope);
}
