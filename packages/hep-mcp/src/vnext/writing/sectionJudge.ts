import * as fs from 'fs';
import { invalidParams, type McpError } from '@autoresearch/shared';

import { getRun, type RunArtifactRef } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { parseHepRunArtifactUriOrThrow } from '../runArtifactUri.js';

import { makePromptPacketFromZod } from '../contracts/promptPacket.js';
import { runWritingTokenGateV1 } from './tokenGate.js';
import { readStagedContent } from './staging.js';
import { ensureWritingQualityPolicyV1, type WritingQualityPolicyV1 } from './qualityPolicy.js';
import {
  computeUriSha256OrThrow,
  writeClientLlmResponseArtifact,
  writePromptPacketArtifact,
  writeRunTextArtifactAtomic,
  writeWritingJournalMarkdown,
} from './reproducibility.js';
import { WritingCandidateSetV1Schema, WritingJudgeDecisionV1Schema } from './nbestJudgeSchemas.js';
import { submitRunWritingSection } from './submitSection.js';

type HardGateFailure = { gate: string; message: string; details?: Record<string, unknown> };

type JudgeResultArtifactV1 = {
  version: 1;
  generated_at: string;
  run_id: string;
  project_id: string;
  section_index: number;
  candidates_uri: string;
  judge_decision_uri: string;
  decision_type: 'select' | 'all_fail';
  selected_candidate_index: number | null;
  hard_gates: { pass: boolean; failures: HardGateFailure[] };
  notes?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function requiredCandidatesForQualityLevel(level: WritingQualityPolicyV1['quality_level']): number {
  return level === 'publication' ? 3 : 2;
}

function makeJudgePromptMarkdown(params: {
  run_id: string;
  section_index: number;
  quality_policy: WritingQualityPolicyV1;
  candidates: Array<{ candidate_index: number; section_output_uri: string; section_output: unknown }>;
}): { system_prompt: string; user_prompt: string } {
  const sys = [
    'You are a ruthless scientific writing judge.',
    'Your job is to select the best candidate section draft, using evidence-first discipline and strict contracts.',
    'Do not invent citations. Prefer candidates that properly attribute claims and remain within allowed citations.',
    'Output MUST be valid JSON matching the provided schema. No markdown fences.',
  ].join('\n');

  const q = params.quality_policy.llm_evaluator_gate;
  const user: string[] = [];
  user.push(`# Section Judge (N-best)`);
  user.push('');
  user.push(`run_id: ${params.run_id}`);
  user.push(`section_index: ${params.section_index}`);
  user.push('');
  user.push('## Hard Requirements');
  user.push('- You MUST evaluate every candidate.');
  user.push('- scores_by_candidate MUST include an entry for every candidate_index.');
  user.push('- Scores must be 0..1, higher is better.');
  user.push('- If you SELECT, selected_candidate_index MUST be the candidate with the highest overall score.');
  user.push('- reasoning must be detailed (>= 50 chars) and audit-friendly.');
  user.push('- key_differences must list at least 1 concrete difference (>= 10 chars each).');
  user.push('');
  user.push('## Quality Policy Thresholds (hard gate)');
  user.push(`- min_overall_score: ${q.min_overall_score}`);
  user.push(`- min_structure_score: ${q.min_structure_score}`);
  user.push(`- min_groundedness_score: ${q.min_groundedness_score}`);
  user.push(`- min_relevance_score: ${q.min_relevance_score}`);
  user.push('');
  user.push('If the best candidate still fails thresholds, set decision.type="all_fail" and provide concrete fix_recommendations.');
  user.push('');
  user.push('## Candidates');

  for (const cand of params.candidates) {
    user.push('');
    user.push(`### candidate_index: ${cand.candidate_index}`);
    user.push(`- section_output_uri: ${cand.section_output_uri}`);
    user.push('');
    user.push('section_output JSON:');
    user.push('```json');
    user.push(JSON.stringify(cand.section_output, null, 2));
    user.push('```');
  }

  user.push('');
  user.push('## Output');
  user.push('- Return ONLY valid JSON matching the schema.');
  user.push('- Fill version=1, generated_at (ISO 8601), run_id, candidate_type="section_draft", candidates_uri.');

  return { system_prompt: sys, user_prompt: user.join('\n').trim() };
}

function resolveCandidateSetArtifactOrThrow(params: { run_id: string; candidates_uri: string }) {
  const parsed = parseHepRunArtifactUriOrThrow(params.candidates_uri);
  if (parsed.runId !== params.run_id) {
    throw invalidParams('Cross-run candidates_uri is not allowed (fail-fast)', {
      run_id: params.run_id,
      candidates_uri: params.candidates_uri,
      candidates_run_id: parsed.runId,
    });
  }
  const artifactPath = getRunArtifactPath(params.run_id, parsed.artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw invalidParams('Candidates artifact not found (fail-fast)', {
      run_id: params.run_id,
      candidates_uri: params.candidates_uri,
      artifact_name: parsed.artifactName,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as unknown;
  } catch (err) {
    const ref = writeRunJsonArtifact(params.run_id, `writing_parse_error_artifact_${parsed.artifactName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: params.run_id,
      artifact_name: parsed.artifactName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw invalidParams('Malformed JSON in candidates artifact (fail-fast)', {
      run_id: params.run_id,
      candidates_uri: params.candidates_uri,
      artifact_name: parsed.artifactName,
      parse_error_uri: ref.uri,
      parse_error_artifact: ref.name,
    });
  }
  const parsedSet = WritingCandidateSetV1Schema.safeParse(raw);
  if (!parsedSet.success) {
    const ref = writeRunJsonArtifact(params.run_id, `writing_parse_error_artifact_${parsed.artifactName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: params.run_id,
      artifact_name: parsed.artifactName,
      issues: parsedSet.error.issues,
    });
    throw invalidParams('Candidates artifact does not match schema (fail-fast)', {
      run_id: params.run_id,
      candidates_uri: params.candidates_uri,
      artifact_name: parsed.artifactName,
      parse_error_uri: ref.uri,
      parse_error_artifact: ref.name,
    });
  }
  return { artifactName: parsed.artifactName, candidateSet: parsedSet.data };
}

function buildHardGateFailures(params: {
  decision: ReturnType<typeof WritingJudgeDecisionV1Schema.parse>;
  candidateSet: ReturnType<typeof WritingCandidateSetV1Schema.parse>;
  qualityPolicy: WritingQualityPolicyV1;
}): HardGateFailure[] {
  const failures: HardGateFailure[] = [];

  const candidateIndices = params.candidateSet.candidates.map(c => c.candidate_index);
  const uniqueCandidates = new Set(candidateIndices);
  if (uniqueCandidates.size !== candidateIndices.length) {
    failures.push({
      gate: 'candidate_set_unique_indices',
      message: 'Candidate set has duplicate candidate_index values',
      details: { candidate_indices: candidateIndices },
    });
  }

  const scoreRows = params.decision.scores_by_candidate;
  const scoreIndices = scoreRows.map(s => s.candidate_index);
  const uniqueScoreIndices = new Set(scoreIndices);

  if (uniqueScoreIndices.size !== scoreIndices.length) {
    failures.push({
      gate: 'judge_scores_unique_indices',
      message: 'scores_by_candidate has duplicate candidate_index values',
      details: { candidate_indices: scoreIndices },
    });
  }

  for (const idx of uniqueCandidates) {
    if (!uniqueScoreIndices.has(idx)) {
      failures.push({
        gate: 'judge_scores_cover_all_candidates',
        message: 'scores_by_candidate must cover every candidate_index',
        details: { missing_candidate_index: idx },
      });
    }
  }

  if (params.decision.decision.type === 'select') {
    const selected = params.decision.decision.selected_candidate_index;
    if (!uniqueCandidates.has(selected)) {
      failures.push({
        gate: 'selected_candidate_exists',
        message: 'selected_candidate_index is not present in candidate set',
        details: { selected_candidate_index: selected, candidate_indices: candidateIndices },
      });
      return failures;
    }

    const byIndex = new Map(scoreRows.map(row => [row.candidate_index, row]));
    const selectedScore = byIndex.get(selected);
    if (!selectedScore) {
      failures.push({
        gate: 'selected_candidate_has_score',
        message: 'scores_by_candidate missing score row for selected_candidate_index',
        details: { selected_candidate_index: selected },
      });
      return failures;
    }

    const maxOverall = Math.max(...scoreRows.map(r => r.overall));
    if (selectedScore.overall < maxOverall) {
      failures.push({
        gate: 'selection_consistency_overall_argmax',
        message: 'selected_candidate_index must match the candidate with the highest overall score',
        details: { selected_candidate_index: selected, selected_overall: selectedScore.overall, max_overall: maxOverall },
      });
    }

    const q = params.qualityPolicy.llm_evaluator_gate;
    if (selectedScore.overall < q.min_overall_score) {
      failures.push({
        gate: 'threshold_overall',
        message: 'Selected candidate overall score below quality policy threshold',
        details: { selected_candidate_index: selected, overall: selectedScore.overall, min_overall_score: q.min_overall_score },
      });
    }
    if (selectedScore.structure < q.min_structure_score) {
      failures.push({
        gate: 'threshold_structure',
        message: 'Selected candidate structure score below quality policy threshold',
        details: { selected_candidate_index: selected, structure: selectedScore.structure, min_structure_score: q.min_structure_score },
      });
    }
    if (selectedScore.groundedness < q.min_groundedness_score) {
      failures.push({
        gate: 'threshold_groundedness',
        message: 'Selected candidate groundedness score below quality policy threshold',
        details: {
          selected_candidate_index: selected,
          groundedness: selectedScore.groundedness,
          min_groundedness_score: q.min_groundedness_score,
        },
      });
    }
    if (selectedScore.relevance < q.min_relevance_score) {
      failures.push({
        gate: 'threshold_relevance',
        message: 'Selected candidate relevance score below quality policy threshold',
        details: { selected_candidate_index: selected, relevance: selectedScore.relevance, min_relevance_score: q.min_relevance_score },
      });
    }
  }

  return failures;
}

function mapSubmitSectionErrorToNextActions(err: unknown, params: { run_id: string; section_index: number; judge_decision_uri: string }): McpError | null {
  if (!err || typeof err !== 'object') return null;
  const anyErr = err as any;
  const code = anyErr?.code ?? anyErr?.error?.code ?? anyErr?.data?.code;
  const message = typeof anyErr?.message === 'string' ? anyErr.message : '';
  const data = typeof anyErr?.data === 'object' && anyErr.data ? (anyErr.data as Record<string, unknown>) : null;
  if (code !== 'INVALID_PARAMS') return null;

  const nextActions = [
    {
      tool: 'hep_run_writing_submit_section_judge_decision_v1',
      args: {
        run_id: params.run_id,
        section_index: params.section_index,
        judge_decision_uri: params.judge_decision_uri,
        quality_eval: '<paste SectionQualityEvalV1 JSON here if required>',
      },
      reason: 'Retry judge decision submission after providing any missing verifier inputs (e.g., quality_eval).',
    },
    {
      tool: 'hep_run_writing_create_section_candidates_packet_v1',
      args: { run_id: params.run_id, section_index: params.section_index },
      reason: 'Regenerate N-best section candidates and re-run judge selection (do not bypass N-best).',
    },
  ];

  return invalidParams(message || 'Section verification failed after judge selection (fail-fast)', {
    ...(data ? data : {}),
    run_id: params.run_id,
    section_index: params.section_index,
    judge_decision_uri: params.judge_decision_uri,
    next_actions: nextActions,
  }) as unknown as McpError;
}

export async function createRunWritingSectionJudgePacketV1(params: {
  run_id: string;
  section_index: number;
  candidates_uri: string;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
  next_actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
}> {
  const runId = params.run_id;
  const run = getRun(runId);
  const sectionIndex = params.section_index;
  if (!Number.isFinite(sectionIndex) || sectionIndex < 1 || Math.trunc(sectionIndex) !== sectionIndex) {
    throw invalidParams('section_index must be a positive integer', { section_index: params.section_index });
  }

  const { policy: qualityPolicy, artifact: qualityPolicyRef } = ensureWritingQualityPolicyV1({ run_id: runId });
  const requiredN = requiredCandidatesForQualityLevel(qualityPolicy.quality_level);

  const { candidateSet } = resolveCandidateSetArtifactOrThrow({ run_id: runId, candidates_uri: params.candidates_uri });
  if (candidateSet.candidate_type !== 'section_draft') {
    throw invalidParams('candidates_uri candidate_type mismatch (expected section_draft)', {
      run_id: runId,
      section_index: sectionIndex,
      candidates_uri: params.candidates_uri,
      candidate_type: candidateSet.candidate_type,
    });
  }
  if (candidateSet.candidate_scope?.section_index !== sectionIndex) {
    throw invalidParams('candidates_uri does not match section_index (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      candidates_uri: params.candidates_uri,
      candidate_scope: candidateSet.candidate_scope,
    });
  }
  if (candidateSet.n_candidates < requiredN) {
    throw invalidParams('Candidates artifact does not meet minimum required by quality_level (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      quality_level: qualityPolicy.quality_level,
      candidates_uri: params.candidates_uri,
      n_candidates: candidateSet.n_candidates,
      required_min: requiredN,
    });
  }

  const candidates = await Promise.all(
    candidateSet.candidates
      .slice()
      .sort((a, b) => a.candidate_index - b.candidate_index)
      .map(async c => ({
        candidate_index: c.candidate_index,
        section_output_uri: c.output_uri,
        section_output: await readStagedContent(runId, c.output_uri, 'section_output'),
      }))
  );

  const prompt = makeJudgePromptMarkdown({
    run_id: runId,
    section_index: sectionIndex,
    quality_policy: qualityPolicy,
    candidates,
  });

  const promptPacket = makePromptPacketFromZod({
    schema_name: 'writing_judge_decision_v1',
    schema_version: 1,
    expected_output_format: 'json',
    system_prompt: prompt.system_prompt,
    user_prompt: prompt.user_prompt,
    output_zod_schema: WritingJudgeDecisionV1Schema,
    context_uris: [params.candidates_uri, qualityPolicyRef.uri, ...candidateSet.candidates.map(c => c.output_uri)],
  });

  const tokenGate = await runWritingTokenGateV1({
    run_id: runId,
    step: 'custom',
    prompt_packet: promptPacket,
    output_pass_artifact_name: `token_gate_pass_section_judge_section_${pad3(sectionIndex)}_v1.json`,
    output_overflow_artifact_name: `writing_token_overflow_section_judge_section_${pad3(sectionIndex)}_v1.json`,
    section_index: sectionIndex,
  });

  const promptTextName = `writing_judge_prompt_section_${pad3(sectionIndex)}_v1.md`;
  const promptTextRef = writeRunTextArtifactAtomic({
    run_id: runId,
    artifact_name: promptTextName,
    content: `${prompt.system_prompt}\n\n${prompt.user_prompt}\n`,
    mimeType: 'text/markdown',
  });

  const llmRequestRef = writePromptPacketArtifact({
    run_id: runId,
    artifact_name: `llm_request_writing_sections_judge_section_${pad3(sectionIndex)}_round_01.json`,
    step: 'writing_sections',
    round: 1,
    prompt_packet: promptPacket,
    mode_used: 'client',
    tool: 'hep_run_writing_create_section_judge_packet_v1',
    schema: 'writing_judge_decision_v1@1',
    extra: {
      section_index: sectionIndex,
      candidates_uri: params.candidates_uri,
      quality_level: qualityPolicy.quality_level,
    },
  });

  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_sections',
    round: 1,
    status: 'success',
    title: `Section judge prompt_packet generated (section=${pad3(sectionIndex)})`,
    inputs: { candidates_uri: params.candidates_uri, quality_policy_uri: qualityPolicyRef.uri },
    outputs: { prompt_packet_uri: llmRequestRef.uri, prompt_text_uri: promptTextRef.uri },
    decisions: [`quality_level=${qualityPolicy.quality_level}`, `n_candidates=${candidateSet.n_candidates}`],
    next_actions: [
      {
        tool: 'hep_run_stage_content',
        args: {
          run_id: runId,
          content_type: 'judge_decision',
          content: '<JSON.stringify(WritingJudgeDecisionV1) then stage>',
          artifact_suffix: `section_${pad3(sectionIndex)}_judge_decision_v1`,
        },
        reason: 'Stage the judge decision JSON (Evidence-first).',
      },
      {
        tool: 'hep_run_writing_submit_section_judge_decision_v1',
        args: {
          run_id: runId,
          section_index: sectionIndex,
          judge_decision_uri: '<staging_uri from hep_run_stage_content (content_type=judge_decision)>',
          client_model: null,
          temperature: null,
          seed: 'unknown',
        },
        reason: 'Submit judge decision for hard gates + verifiers (fail-fast; no bypass).',
      },
    ],
    artifact_name: `writing_journal_writing_sections_judge_section_${pad3(sectionIndex)}_round_01.md`,
  });

  const nextActions = [
    {
      tool: 'hep_run_stage_content',
      args: {
        run_id: runId,
        content_type: 'judge_decision',
        content: '<JSON.stringify(WritingJudgeDecisionV1) then stage>',
        artifact_suffix: `section_${pad3(sectionIndex)}_judge_decision_v1`,
      },
      reason: 'Stage the judge decision JSON (Evidence-first).',
    },
    {
      tool: 'hep_run_writing_submit_section_judge_decision_v1',
      args: {
        run_id: runId,
        section_index: sectionIndex,
        judge_decision_uri: '<staging_uri from hep_run_stage_content (content_type=judge_decision)>',
        client_model: null,
        temperature: null,
        seed: 'unknown',
      },
      reason: 'Submit judge decision for hard gates + verifiers (fail-fast; no bypass).',
    },
  ];

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts: [qualityPolicyRef, promptTextRef, llmRequestRef, journalRef, ...tokenGate.artifacts],
    summary: {
      section_index: sectionIndex,
      candidates_uri: params.candidates_uri,
      quality_level: qualityPolicy.quality_level,
      n_candidates: candidateSet.n_candidates,
      prompt_packet_uri: llmRequestRef.uri,
      prompt_packet_sha256: computeUriSha256OrThrow({ run_id: runId, uri: llmRequestRef.uri }),
      prompt_text_uri: promptTextRef.uri,
      journal_uri: journalRef.uri,
      token_gate: tokenGate.summary,
    },
    next_actions: nextActions,
  };
}

export async function submitRunWritingSectionJudgeDecisionV1(params: {
  run_id: string;
  section_index: number;
  judge_decision_uri: string;
  client_model?: string | null;
  temperature?: number | null;
  seed?: number | string | null;
  quality_eval?: unknown;
}): Promise<{
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
  next_actions?: Array<{ tool: string; args: Record<string, unknown>; reason: string }>;
}> {
  const runId = params.run_id;
  const run = getRun(runId);
  const sectionIndex = params.section_index;
  if (!Number.isFinite(sectionIndex) || sectionIndex < 1 || Math.trunc(sectionIndex) !== sectionIndex) {
    throw invalidParams('section_index must be a positive integer', { section_index: params.section_index });
  }

  const { policy: qualityPolicy, artifact: qualityPolicyRef } = ensureWritingQualityPolicyV1({ run_id: runId });
  const requiredN = requiredCandidatesForQualityLevel(qualityPolicy.quality_level);

  const rawDecision = await readStagedContent(runId, params.judge_decision_uri, 'judge_decision');
  const parsedDecision = WritingJudgeDecisionV1Schema.safeParse(rawDecision);
  if (!parsedDecision.success) {
    const ref = writeRunJsonArtifact(runId, `writing_parse_error_judge_section_${pad3(sectionIndex)}_v1.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      section_index: sectionIndex,
      judge_decision_uri: params.judge_decision_uri,
      issues: parsedDecision.error.issues,
      received: rawDecision,
    });
    throw invalidParams('JudgeDecision schema mismatch (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      judge_decision_uri: params.judge_decision_uri,
      parse_error_uri: ref.uri,
      parse_error_artifact: ref.name,
      next_actions: [
        {
          tool: 'hep_run_writing_create_section_judge_packet_v1',
          args: { run_id: runId, section_index: sectionIndex, candidates_uri: '<candidates_uri>' },
          reason: 'Recreate judge prompt_packet and generate a valid WritingJudgeDecisionV1 JSON.',
        },
      ],
    });
  }

  const decision = parsedDecision.data;

  const { candidateSet } = resolveCandidateSetArtifactOrThrow({ run_id: runId, candidates_uri: decision.candidates_uri });
  if (candidateSet.candidate_type !== 'section_draft') {
    throw invalidParams('JudgeDecision candidate_type mismatch (expected section_draft)', {
      run_id: runId,
      section_index: sectionIndex,
      candidate_type: decision.candidate_type,
    });
  }
  if (candidateSet.candidate_scope?.section_index !== sectionIndex) {
    throw invalidParams('JudgeDecision candidates_uri does not match section_index (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      candidates_uri: decision.candidates_uri,
      candidate_scope: candidateSet.candidate_scope,
    });
  }
  if (candidateSet.n_candidates < requiredN) {
    throw invalidParams('Candidates do not meet minimum required by quality_level (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      quality_level: qualityPolicy.quality_level,
      candidates_uri: decision.candidates_uri,
      n_candidates: candidateSet.n_candidates,
      required_min: requiredN,
    });
  }

  const promptPacketUri = (() => {
    const llmRequestName = `llm_request_writing_sections_judge_section_${pad3(sectionIndex)}_round_01.json`;
    const p = getRunArtifactPath(runId, llmRequestName);
    return fs.existsSync(p) ? `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(llmRequestName)}` : null;
  })();

  const judgeResponseRef = writeClientLlmResponseArtifact({
    run_id: runId,
    artifact_name: `writing_client_llm_response_section_judge_section_${pad3(sectionIndex)}_v1.json`,
    step: 'writing_sections',
    prompt_packet_uri: promptPacketUri ?? undefined,
    client_raw_output_uri: params.judge_decision_uri,
    parsed: decision,
    client_model: params.client_model ?? null,
    temperature: params.temperature ?? null,
    seed: params.seed ?? 'unknown',
  });

  const hardGateFailures = buildHardGateFailures({ decision, candidateSet, qualityPolicy });
  const decisionType = decision.decision.type;
  const selectedIndex = decisionType === 'select' ? decision.decision.selected_candidate_index : null;

  const judgeResultPayload: JudgeResultArtifactV1 = {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    project_id: run.project_id,
    section_index: sectionIndex,
    candidates_uri: decision.candidates_uri,
    judge_decision_uri: params.judge_decision_uri,
    decision_type: decisionType,
    selected_candidate_index: selectedIndex,
    hard_gates: { pass: hardGateFailures.length === 0 && decisionType === 'select', failures: hardGateFailures },
  };

  const judgeResultRef = writeRunJsonArtifact(runId, `writing_judge_section_${pad3(sectionIndex)}_v1.json`, judgeResultPayload);

  if (decisionType === 'all_fail') {
    throw invalidParams('JudgeDecision indicates all candidates hard-fail (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      candidates_uri: decision.candidates_uri,
      judge_decision_uri: params.judge_decision_uri,
      judge_result_uri: judgeResultRef.uri,
      judge_result_artifact: judgeResultRef.name,
      fix_recommendations: decision.fix_recommendations,
      next_actions: [
        {
          tool: 'hep_run_writing_create_section_candidates_packet_v1',
          args: { run_id: runId, section_index: sectionIndex, n_candidates: Math.max(requiredN, candidateSet.n_candidates + 1) },
          reason: 'Regenerate a larger N-best candidate set applying fix_recommendations, then re-judge.',
        },
      ],
    });
  }

  if (hardGateFailures.length > 0) {
    throw invalidParams('JudgeDecision failed hard gates (fail-fast)', {
      run_id: runId,
      section_index: sectionIndex,
      candidates_uri: decision.candidates_uri,
      judge_decision_uri: params.judge_decision_uri,
      judge_result_uri: judgeResultRef.uri,
      judge_result_artifact: judgeResultRef.name,
      hard_gate_failures: hardGateFailures,
      next_actions: [
        {
          tool: 'hep_run_writing_create_section_judge_packet_v1',
          args: { run_id: runId, section_index: sectionIndex, candidates_uri: decision.candidates_uri },
          reason: 'Re-run judge with strict selection consistency + threshold alignment, then re-submit judge_decision_uri.',
        },
      ],
    });
  }

  const selectedCandidate = candidateSet.candidates.find(c => c.candidate_index === selectedIndex);
  if (!selectedCandidate) {
    throw invalidParams('Internal: selected candidate missing after hard gates', {
      run_id: runId,
      section_index: sectionIndex,
      selected_candidate_index: selectedIndex,
    });
  }

  try {
    const submitRes = await submitRunWritingSection({
      run_id: runId,
      section_index: sectionIndex,
      section_output_uri: selectedCandidate.output_uri,
      quality_eval: params.quality_eval as any,
      client_model: selectedCandidate.client_model,
      temperature: selectedCandidate.temperature,
      seed: selectedCandidate.seed,
    });

    return {
      run_id: submitRes.run_id,
      project_id: submitRes.project_id,
      manifest_uri: submitRes.manifest_uri,
      artifacts: [qualityPolicyRef, judgeResponseRef, judgeResultRef, ...submitRes.artifacts],
      summary: {
        section_index: sectionIndex,
        selected_candidate_index: selectedIndex,
        selected_candidate_uri: selectedCandidate.output_uri,
        candidates_uri: decision.candidates_uri,
        judge_decision_uri: params.judge_decision_uri,
        judge_result_uri: judgeResultRef.uri,
        submit_summary: submitRes.summary,
      },
    };
  } catch (err) {
    const mapped = mapSubmitSectionErrorToNextActions(err, { run_id: runId, section_index: sectionIndex, judge_decision_uri: params.judge_decision_uri });
    if (mapped) throw mapped;
    throw err;
  }
}
