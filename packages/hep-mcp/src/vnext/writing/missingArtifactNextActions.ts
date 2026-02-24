import {
  HEP_RUN_BUILD_WRITING_CRITICAL,
  HEP_RUN_WRITING_BUILD_EVIDENCE_PACKET_SECTION_V2,
  HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
  HEP_RUN_WRITING_CREATE_PAPERSET_CURATION_PACKET,
  HEP_RUN_WRITING_CREATE_SECTION_CANDIDATES_PACKET_V1,
  HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
  HEP_RUN_WRITING_SUBMIT_PAPERSET_CURATION,
} from '@autoresearch/shared';
export type RunNextAction = { tool: string; args: Record<string, unknown>; reason: string };

function parsePad3Index(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.trunc(n) !== n) return null;
  if (n < 1) return null;
  return n;
}

export function suggestNextActionsForMissingRunArtifact(params: {
  run_id: string;
  artifact_name: string;
}): RunNextAction[] | null {
  const runId = params.run_id;
  const name = params.artifact_name;

  if (name === 'writing_outline_v2.json') {
    return [
      {
        tool: HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
        args: {
          run_id: runId,
          language: 'auto',
          target_length: '<short|medium|long>',
          title: '<paper title>',
          topic: '<optional>',
          structure_hints: '<optional>',
          user_outline: '<optional>',
          n_candidates: 2,
        },
        reason: 'M13: Create N-best outline candidates packet (N>=2 required), then follow next_actions to submit candidates + judge + write writing_outline_v2.json.',
      },
    ];
  }

  if (name === 'writing_paperset_v1.json') {
    return [
      {
        tool: HEP_RUN_WRITING_CREATE_PAPERSET_CURATION_PACKET,
        args: {
          run_id: runId,
          language: 'auto',
          target_length: '<short|medium|long>',
          title: '<paper title>',
          topic: '<optional>',
          structure_hints: '<optional>',
          seed_identifiers: ['<recid|doi|arxiv>'],
        },
        reason: 'Create a PaperSetCuration prompt_packet for the client LLM.',
      },
      {
        tool: HEP_RUN_WRITING_SUBMIT_PAPERSET_CURATION,
        args: {
          run_id: runId,
          paperset_uri: '<staging_uri from hep_run_stage_content (content_type=paperset)>',
        },
        reason: 'Submit PaperSetCuration into run artifacts (writes writing_paperset_v1.json).',
      },
    ];
  }

  if (name === 'writing_token_budget_plan_v1.json') {
    return [
      {
        tool: HEP_RUN_WRITING_CREATE_TOKEN_BUDGET_PLAN_V1,
        args: { run_id: runId, model_context_tokens: 32_000 },
        reason: 'Create TokenBudgetPlanV1 (required for TokenGate-gated writing steps).',
      },
    ];
  }

  if (name === 'writing_claims_table.json') {
    return [
      {
        tool: HEP_RUN_BUILD_WRITING_CRITICAL,
        args: { run_id: runId, recids: ['<inspire_recid>'] },
        reason: 'Build writing-critical artifacts (including writing_claims_table.json) for this run.',
      },
    ];
  }

  const evidencePacketMatch = /^writing_evidence_packet_section_(\d{3})_v2\.json$/.exec(name);
  if (evidencePacketMatch) {
    const sectionIndex = parsePad3Index(evidencePacketMatch[1]!);
    if (sectionIndex !== null) {
      return [
        {
          tool: HEP_RUN_WRITING_BUILD_EVIDENCE_PACKET_SECTION_V2,
          args: { run_id: runId, section_index: sectionIndex },
          reason: 'Build the EvidencePacketV2 for this section (rerank packet + submit result).',
        },
      ];
    }
  }

  const sectionMatch = /^writing_section_(\d{3})\.json$/.exec(name);
  if (sectionMatch) {
    const sectionIndex = parsePad3Index(sectionMatch[1]!);
    if (sectionIndex !== null) {
      return [
        {
          tool: HEP_RUN_WRITING_CREATE_SECTION_CANDIDATES_PACKET_V1,
          args: { run_id: runId, section_index: sectionIndex },
          reason: 'M13: Create N-best section candidates packet (N>=2 required), then follow next_actions to submit candidates + judge + verifiers.',
        },
      ];
    }
  }

  return null;
}
