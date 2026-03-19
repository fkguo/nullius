import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { assertResearchLoopPacket, createResearchLoopPacket, createResearchWorkspace } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const artifactRefSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../meta/schemas/artifact_ref_v1.schema.json'), 'utf-8'),
) as Record<string, unknown>;
const packetSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../meta/schemas/research_loop_packet_v1.schema.json'), 'utf-8'),
) as Record<string, unknown>;

function makeWorkspace() {
  return createResearchWorkspace({
    workspace_id: 'ws-packet-01',
    primary_question_id: 'question-1',
    nodes: [
      { node_id: 'question-1', kind: 'question', title: 'Question' },
      { node_id: 'idea-1', kind: 'idea', title: 'Idea' },
      { node_id: 'evidence-1', kind: 'evidence_set', title: 'Evidence' },
      { node_id: 'compute-1', kind: 'compute_attempt', title: 'Compute' },
      { node_id: 'finding-1', kind: 'finding', title: 'Finding' },
      { node_id: 'draft-1', kind: 'draft_section', title: 'Draft' },
      { node_id: 'review-1', kind: 'review_issue', title: 'Review' },
      { node_id: 'decision-1', kind: 'decision', title: 'Decision' },
    ],
    edges: [
      { edge_id: 'edge-1', kind: 'supports', from_node_id: 'evidence-1', to_node_id: 'idea-1' },
      { edge_id: 'edge-2', kind: 'produces', from_node_id: 'compute-1', to_node_id: 'finding-1' },
      { edge_id: 'edge-3', kind: 'revises', from_node_id: 'review-1', to_node_id: 'draft-1' },
    ],
  });
}

describe('research-loop packet contract', () => {
  it('builds a single-project packet that validates against the checked-in schema', () => {
    const packet = createResearchLoopPacket({ workspace: makeWorkspace() });
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    ajv.addSchema(artifactRefSchema);
    const validate = ajv.compile(packetSchema);

    expect(validate(packet), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(packet.scope).toBe('single_project');
    expect(packet.immutable_authority_refs).toContainEqual({ ref_kind: 'workspace_node', node_id: 'question-1' });
    expect(packet.advancement.allowed_followups).toContainEqual({ from_task_kind: 'compute', to_task_kind: 'finding' });
    expect(packet.rollback.allowed_backtracks).toContainEqual({ from_task_kind: 'compute', to_task_kind: 'literature' });
  });

  it('fails closed on illegal rollback or out-of-workspace references', () => {
    const workspace = makeWorkspace();

    expect(() =>
      createResearchLoopPacket({
        workspace,
        immutable_authority_refs: [
          { ref_kind: 'workspace_node', node_id: 'question-1' },
          { ref_kind: 'workspace_node', node_id: 'missing-node' },
        ],
      }),
    ).toThrow(/unknown workspace node/i);

    expect(() =>
      createResearchLoopPacket({
        workspace,
        immutable_authority_refs: [{ ref_kind: 'workspace_node', node_id: 'question-1' }],
        stop_conditions: [{ condition_kind: 'decision_node', node_id: 'missing-node' }],
      }),
    ).toThrow(/unknown workspace node/i);

    expect(() =>
      createResearchLoopPacket({
        workspace,
        rollback: { allowed_backtracks: [{ from_task_kind: 'compute', to_task_kind: 'finding' }] },
      }),
    ).toThrow(/rollback transition/i);

    expect(() =>
      createResearchLoopPacket({
        workspace,
        immutable_authority_refs: [{ ref_kind: 'workspace_node', node_id: 'decision-1' }],
      }),
    ).toThrow(/primary question node/i);

    expect(() =>
      assertResearchLoopPacket(
        { ...createResearchLoopPacket({ workspace }), scope: 'multi_project' } as never,
        workspace,
      ),
    ).toThrow(/single_project scoped/i);

    expect(() =>
      assertResearchLoopPacket(
        { ...createResearchLoopPacket({ workspace }), workspace_id: 'ws-other' },
        workspace,
      ),
    ).toThrow(/workspace_id mismatch/i);
  });
});
