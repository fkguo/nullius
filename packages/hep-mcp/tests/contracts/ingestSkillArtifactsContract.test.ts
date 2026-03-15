import { describe, expect, it } from 'vitest';
import { zodToMcpInputSchema } from '../../src/tools/mcpSchema.js';
import { HepRunIngestSkillArtifactsToolSchema } from '../../src/tools/registry/projectSchemas.js';
import * as T from '../../src/tool-names.js';
import { HEP_TOOL_RISK_LEVELS } from '../../src/tool-risk.js';

describe('hep_run_ingest_skill_artifacts contract', () => {
  it('remains a write-level contained ingestion surface', () => {
    expect(HEP_TOOL_RISK_LEVELS[T.HEP_RUN_INGEST_SKILL_ARTIFACTS]).toBe('write');

    const schema = zodToMcpInputSchema(HepRunIngestSkillArtifactsToolSchema) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.required).toEqual(expect.arrayContaining(['run_id', 'skill_artifacts_dir']));
    expect(schema.properties?._confirm).toBeUndefined();
  });
});
