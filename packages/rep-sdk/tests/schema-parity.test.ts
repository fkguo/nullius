import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const schemaFiles = [
  'agent_card_v1.schema.json',
  'artifact_ref_v1.schema.json',
  'integrity_report_v1.schema.json',
  'rep_envelope_v1.schema.json',
  'research_event_v1.schema.json',
  'research_outcome_v1.schema.json',
  'research_signal_v1.schema.json',
  'research_strategy_v1.schema.json',
] as const;

describe('schema parity', () => {
  it('keeps the package-local schema snapshots aligned with meta/schemas', async () => {
    for (const schemaFile of schemaFiles) {
      const packageCopy = await readFile(new URL(`../schemas/${schemaFile}`, import.meta.url), 'utf8');
      const sourceOfTruth = await readFile(
        new URL(`../../../meta/schemas/${schemaFile}`, import.meta.url),
        'utf8',
      );
      expect(packageCopy).toBe(sourceOfTruth);
    }
  });
});
