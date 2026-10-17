#!/usr/bin/env node

/**
 * Review-verification contract anti-drift CI check.
 *
 * Two review-contract clauses keep reviews from certifying claims they
 * never actually tested:
 *
 *   1. RE-READING IS NOT RECOMPUTATION. A review that only re-reads
 *      evidence supplied by the claimant is an argument audit, not a
 *      verification — its "confirm" can sit inside the claimant's blind
 *      spot, because the supplied evidence may probe the wrong axis
 *      altogether. Load-bearing structural claims require at least one
 *      independent evidence pair that constructs and executes sound checks,
 *      receiving only the problem statement and raw
 *      inputs (never the claimant's answer, evidence selection, or
 *      initial judgment), and the record states which axis the
 *      recomputation actually probed.
 *
 *   2. DISCRIMINATING POWER BEFORE EXECUTION. Before a proposed
 *      discriminator/test is executed or its result interpreted, the
 *      proposer computes its discriminating power against the degenerate
 *      background / confounders; a test whose expected signal is not
 *      cleanly separable is non-diagnostic — neither outcome may be
 *      cited as evidence — and reviews check that cited tests carried
 *      the power estimate.
 *
 * This lock fails the build when either clause is removed or renamed
 * from the skill surfaces that state it (research-team non-negotiables,
 * review-swarm reviewer roles). It also pins that Claude lanes carry no
 * operator memory (safe-mode default, recorded and observed per invocation).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEAM_SKILL_FILE = 'skills/research-team/SKILL.md';
const SWARM_SKILL_FILE = 'skills/review-swarm/SKILL.md';
const RUNNER_FILE = 'skills/research-team/scripts/bin/run_team_cycle.sh';
const TAG_TOOL_FILE = 'skills/research-team/scripts/bin/next_team_tag.py';
const RESUME_TESTS_FILE = 'skills/research-team/tests/test_health_aware_resume.py';
const TAG_GUARD_TESTS_FILE = 'skills/research-team/tests/test_next_team_tag_verdict_guard.py';

const errors = [];

function read(relPath) {
  const abs = path.join(repoRoot, relPath);
  if (!existsSync(abs)) {
    errors.push(`file missing: ${relPath}`);
    return null;
  }
  return readFileSync(abs, 'utf-8');
}

function requireAll(relPath, text, needles) {
  if (text === null) return;
  for (const [label, needle] of needles) {
    if (!text.includes(needle)) {
      errors.push(`${relPath}: missing ${label}: expected to find ${JSON.stringify(needle)}`);
    }
  }
}

// 1. research-team: both clauses in the non-negotiable contracts list.
requireAll(TEAM_SKILL_FILE, read(TEAM_SKILL_FILE), [
  ['recomputation bullet', '- **Re-reading is not recomputation (mandatory for load-bearing structural claims).**'],
  ['argument-audit distinction', 'argument audit, not a verification'],
  ['claimant blind-spot motivation', "claimant's blind spot"],
  ['actual independent construction/execution', 'independently constructed and executed checks'],
  ['blinded-input requirement', 'with only the problem statement and raw inputs'],
  ['no answer-bearing input', "never the claimant's answer, evidence selection, or initial judgment"],
  ['probed-axis record', 'which axis the recomputation actually probed'],
  ['routing to the swarm reviewer role', '`review-swarm` independent-recomputation reviewer'],
  ['pre-execution timing', 'applies **before** a proposed discriminator/test is executed'],
  ['pre-execution power requirement', 'computes its **discriminating power**'],
  ['degeneracy examples', 'window narrower than the feature'],
  ['neither-outcome-citable consequence', 'neither its positive nor its negative outcome may be cited'],
  ['review-side power check', 'carried this power estimate'],
  ['unavailability-is-not-a-round bullet', 'Reviewer unavailability is a dispatch failure, not a review round'],
  ['unavailability consumes no bounded round', 'never consumes a bounded round'],
  ['unavailability advances no round suffix', 'never advances the round suffix'],
  ['same-tag resume instruction', "re-enter the **same** cycle tag with the runner's `--resume` path"],
  ['garbage-report move-aside instruction', 'move that file aside (never delete it) before resuming'],
  ['health-aware resume named hardening', 'health-aware resume'],
  ['repeated-unavailability escalation', 'environment blocker to surface to the project owner'],
  ['violation-quarantine bullet', 'quarantines evidence; it never destroys computation'],
  ['quarantined values barred from steering', 'barred from steering the redo'],
  ['post-hoc cross-check clause', 'post-hoc cross-check'],
]);

// 3. Machine legs of the unavailability discipline: health-aware resume in
// the runner, and the round-advance guard in the tag tool. Prose that
// promises machine behavior erodes silently unless the machine legs are
// pinned alongside it.
requireAll(RUNNER_FILE, read(RUNNER_FILE), [
  ['verdict health predicate', 'member_report_healthy() {'],
  ['unhealthy move-aside helper', 'move_aside_unhealthy_report() {'],
  ['unreadable-report guard (indeterminate, not unhealthy)', 'guard_unreadable_report() {'],
  ['crash-resume permission repair', 'Crash-resume repair'],
  ['same-second backup uniquification (dangling-symlink aware)', 'while [[ -e "${backup}" || -L "${backup}" ]]'],
  ['packet-only preflight before background launch', 'Preflight both seats'],
  ['full-access member-a health-gated resume', 'if [[ "${RESUME}" -eq 1 && -s "${member_a_out}" && -s "${member_a_evidence}" ]] && member_report_healthy "${member_a_out}"; then'],
  ['full-access member-b health-gated resume', 'if [[ "${RESUME}" -eq 1 && -s "${member_b_out}" && -s "${member_b_evidence}" ]] && member_report_healthy "${member_b_out}"; then'],
  ['packet-only member-a health-gated resume', 'if [[ "${RESUME}" -eq 1 && -s "${member_a_out}" ]] && member_report_healthy "${member_a_out}"; then'],
  ['packet-only member-b health-gated resume', 'if [[ "${RESUME}" -eq 1 && -s "${member_b_out}" ]] && member_report_healthy "${member_b_out}"; then'],
  ['sidecar nonemptiness reuse (no verdict contract)', 'if [[ "${RESUME}" -eq 1 && -s "${sc_out}" ]]; then'],
]);
requireAll(TAG_TOOL_FILE, read(TAG_TOOL_FILE), [
  ['verdict heading criterion', 'VERDICT_HEADING_RE'],
  ['round-advance guard suggestion', 'prefer resuming the SAME tag'],
  ['strict refuse flag', '--refuse-unverdicted'],
  ['unreadable-is-indeterminate status', '"indeterminate" if unreadable else "no_verdict"'],
]);
requireAll(RESUME_TESTS_FILE, read(RESUME_TESTS_FILE), [
  ['four health-gated conditions pinned', 'test_all_four_member_resume_conditions_are_health_gated'],
  ['move-aside behavioral control', 'test_move_aside_preserves_content_and_removes_original'],
  ['never-delete structural control', 'test_move_aside_never_deletes'],
  ['same-second backup coexistence control', 'test_move_aside_same_second_backups_coexist'],
  ['unreadable-guard behavioral control', 'test_guard_refuses_unreadable_report'],
  ['dangling-symlink refusal control', 'test_guard_refuses_dangling_report_symlink'],
  ['quiet-predicate control', 'test_health_check_is_quiet_on_unreadable'],
  ['guard wiring control', 'test_unreadable_guard_wired_before_every_move_aside'],
  ['packet-only preflight ordering control', 'test_packet_only_guards_run_before_any_background_launch'],
  ['symlink-aware entry-condition control', 'test_symlink_aware_entry_conditions_are_pinned'],
  ['crash-resume permission-repair control', 'test_full_access_resume_restores_permissions_first'],
  ['sidecar exemption control', 'test_sidecar_reuse_stays_on_nonemptiness'],
]);
requireAll(TAG_GUARD_TESTS_FILE, read(TAG_GUARD_TESTS_FILE), [
  ['verdict-less warn control', 'test_verdict_less_latest_round_warns_and_suggests_same_tag_resume'],
  ['strict-refuse control', 'test_refuse_unverdicted_exits_3_and_emits_no_tag'],
  ['partial-round exemption control', 'test_one_verdict_bearing_member_suffices'],
  ['unreadable-indeterminate control', 'test_unreadable_report_is_indeterminate_not_verdict_less'],
]);

// 2. review-swarm: the general recomputation reviewer role.
requireAll(SWARM_SKILL_FILE, read(SWARM_SKILL_FILE), [
  ['reviewer-role heading', '### Independent-recomputation reviewer'],
  ['argument-audit distinction', '**argument audit**, not a'],
  ['generalizes the reference-reproduction special case', 'anchors the check'],
  ['actual independent construction/execution', 'independently construct or derive and execute the check'],
  ['same-method allowance', 'Same or similar sound methods may count'],
  ['separate independence dimensions', 'method diversity, model-family diversity, execution independence and input independence are separate dimensions'],
  ['explicit risk remains', 'explicit project shared-failure risk may require a different mechanism'],
  ['blinded-input requirement', 'receiving **only the problem statement'],
  ['no answer-bearing input', "never the claimant's answer, evidence selection, or initial judgment"],
  ['probed-axis record in meta.json', 'which axis the independent recomputation actually probed'],
  ['axis-mismatch demotion to static-only', 'does not intersect the claim'],
  ['original capacity policy binding', 'The configured token window is frozen before the original reviewer subprocess starts'],
  ['no historical policy promotion', 'Changing historical window metadata cannot admit that receipt'],
]);

// Complete-output capture is shared by independently installed runner/swarm skills.
const claudeText = read('skills/claude-cli-runner/scripts/complete_assistant_text.py');
const swarmText = read('skills/review-swarm/scripts/bin/complete_assistant_text.py');
if (claudeText !== swarmText) errors.push('complete assistant text collectors differ');
requireAll('skills/claude-cli-runner/SKILL.md', read('skills/claude-cli-runner/SKILL.md'), [
  ['ordered complete output', '`OUT` contains the complete assistant'],
  ['unidentified real increments', 'identical text deltas are retained as separate observed increments'],
]);
requireAll('skills/derivation-verify/references/contract.md', read('skills/derivation-verify/references/contract.md'), [
  ['complete terminal capacity binding', 'capacity accounting uses only that terminal'],
  ['complete original comparator context', 'enters the comparator as `derivation_context`'],
  ['transport quoting limited to input/execution', 'only input and execution may also quote the observed `transport` record'],
  ['lane text carried once as derivation and once in transport', 'once as the structured `derivation` field and once as `transport.raw_output`'],
  ['no other packet field adds a copy of lane text', 'no other packet field adds a copy'],
  ['captured record carried by reference only on a proven equality', 'only when packet assembly proves the bytes equal a shipped field'],
  ['live stream carried as content blocks with proven text slices', 'proven equal to at assembly, and every other block and field'],
  ['captured content quoted only as the packet shows it', 'Input and execution spans quote captured content only as the packet shows it'],
  ['one comparator request per lane holding its complete material', "each lane's assessment is made in its own comparator request that holds that lane's complete material"],
  ['joint request holds no lane material and its assessments are discarded', 'holds no lane material, so any assessment it volunteers is discarded'],
  ['all lanes in one request when they fit, as before', "a single comparator request holds every lane's complete material and supplies clustering, recomputation, every lane's assessment and any method risk together, as before"],
  ['split lane counts only with span-backed answer support', 'a lane assessment in this form counts only with `answer_support`'],
  ['per-lane form limitation stated', "no request reads two lanes' bodies except the pair requests of an explicit method risk"],
  ['read coverage, not length, decides', 'Read coverage, not length, decides whether lane material counts'],
  ['above the byte budget inline, counted on observed usage', 'the request counts only when the comparator\'s own runtime-observed capture shows token usage within the configured window and no compaction'],
  ['files only beyond the token window', 'Only material whose bytes exceed four times the token window'],
  ['single request kept above the byte budget on observed usage', 'or the lanes together are above the byte budget but every judge observes token usage'],
  ['one contiguous exact span', 'Every source span is one contiguous exact copy of text as read'],
  ['a byte counts as read only when returned with its frozen text', 'a byte counts as read only when a Read result returned the line holding it, numbered as that line, with exactly the frozen text'],
  ['incomplete reads are unavailable, never truncated', 'otherwise it is unavailable as content not completely read, never truncated'],
  ['executors that cannot show reads leave long material unavailable', 'leave such material unavailable as content not completely read'],
  ['provider refusal recorded apart', 'a lane stopped by the provider\'s safeguards is recorded in `provider_refusals`'],
]);
// Lane requests ask for the written derivation; "original steps ... no truncation" wording was
// stopped by a provider safeguard against reasoning extraction (no derivation came back at all).
for (const lanePrompt of ['skills/derivation-verify/scripts/run_multi_backend.py', 'skills/derivation-verify/workflows/derivation_verify.js']) {
  const body = read(lanePrompt);
  if (!body.includes('every mathematical step stated explicitly')) errors.push(`${lanePrompt}: lane request no longer asks for every mathematical step`);
  for (const phrase of ['COMPLETE original steps', 'COMPLETE original derivation, all steps', 'no sentence limit or truncation']) {
    if (body.includes(phrase)) errors.push(`${lanePrompt}: lane request uses reasoning-extraction wording "${phrase}"`);
  }
}
requireAll('skills/derivation-verify/tests/test_provider_refusal.py', read('skills/derivation-verify/tests/test_provider_refusal.py'), [
  ['host-runner refusal witness', 'def test_safeguard_text_from_a_host_runner_is_a_recorded_refusal_not_a_family'],
  ['exit-zero stream refusal witness', 'def test_stream_refusal_is_recorded_even_when_the_cli_exits_zero'],
]);
requireAll('skills/claude-cli-runner/tests/test_complete_assistant_text.py', read('skills/claude-cli-runner/tests/test_complete_assistant_text.py'), [
  ['one-block snapshot alignment witness', 'def test_one_block_snapshots_after_thinking_assemble_the_text_block'],
  ['inconsistent stream still refuses', 'def test_snapshot_kind_disagreeing_with_latest_started_block_still_refuses'],
  ['stopped response never completes', 'def test_provider_stopped_response_with_continuation_is_not_complete_output'],
]);
// The copy count per packet record is pinned by offline witnesses in both executors; prose alone erodes.
requireAll('skills/derivation-verify/tests/test_full_derivation_transport.py', read('skills/derivation-verify/tests/test_full_derivation_transport.py'), [
  ['per-record copy count witness', 'def test_comparator_packet_repeats_lane_text_only_inside_transport'],
  ['live-capture content-block carriage witness', 'def test_live_capture_stream_is_carried_as_content_blocks_and_each_lane_request_fits'],
  ['unproven captured content stays inline witness', 'def test_captured_content_not_proven_equal_to_a_shipped_field_stays_inline'],
  ['lane above the window without observable reads witness', 'def test_lane_above_the_window_without_observable_reads_is_refused_not_truncated'],
  ['stream view omits only bookkeeping witness', 'def test_stream_view_omits_only_bookkeeping_and_references_only_the_lanes_own_output'],
  ['captured text referenced only to a quotable field witness', 'def test_captured_text_is_referenced_only_to_a_field_spans_can_quote'],
  ['captured-content span sources witness', 'def test_input_execution_spans_quote_captured_content_only_as_the_packet_shows_it'],
  ['live-capture per-lane request margin assertion', "assert all(mb.validate_request_bytes(mb._ASSESS_SYSTEM, p, mb.request_budgets()) <= 0.4 * mb.request_budgets()['context_bytes'] for p in prompt.requests)"],
  ['two lanes in one request under the default window assertion', "assert len(seen) == 1 and len(seen[0].encode('utf-8')) <= mb.request_budgets()['context_bytes']"],
]);
// Read coverage replaces length as the criterion; each rule is pinned by an offline witness that a mutation fails.
requireAll('skills/derivation-verify/tests/test_comparator_read_coverage.py', read('skills/derivation-verify/tests/test_comparator_read_coverage.py'), [
  ['per-lane requests carry one complete lane witness', 'def test_per_lane_requests_each_carry_one_complete_lane'],
  ['chunked read with full coverage witness', 'def test_lane_larger_than_the_window_is_read_in_chunks_and_passes_only_with_full_coverage'],
  ['incomplete or unfaithful reads refused witness', 'def test_incomplete_or_unfaithful_reads_are_refused'],
  ['dropped read mutation', "'drop-one-read': 'some bytes of the frozen material were never returned to the comparator'"],
  ['altered returned content mutation', "'altered-line': 'a returned line differs from the frozen bytes'"],
  ['unobservable reads leave long lanes unavailable witness', 'def test_a_runner_or_comparator_that_cannot_show_reads_leaves_long_lanes_unavailable'],
  ['aggregation not easier witness', 'def test_per_lane_assessment_cannot_make_aggregation_easier'],
  ['answer support witness', 'def test_split_lane_counts_only_when_its_body_supports_its_stated_answer'],
  ['returned line number binding mutation', "'shifted-numbers': 'a returned line differs from the frozen bytes'"],
  ['spans checked against what was read witness', 'def test_spans_are_checked_against_exactly_what_the_comparator_read'],
  ['lane and pair requests phrased as reviewing a written document witness', 'def test_lane_and_pair_requests_read_as_reviewing_a_written_document'],
  ['above-budget inline counted on observed usage witness', 'def test_material_above_the_byte_budget_travels_inline_and_counts_on_observed_usage'],
  ['above-budget inline refused without a clean observed fit witness', 'def test_material_above_the_byte_budget_is_refused_without_a_clean_observed_fit'],
  ['files only beyond the token window witness', 'def test_only_material_beyond_the_token_window_is_read_from_files'],
  ['ellipsis-joined span refused witness', 'def test_a_span_joining_passages_with_an_ellipsis_is_not_a_quote'],
  ['single request above the byte budget witness', 'def test_single_request_above_the_byte_budget_holds_every_lane_on_observed_usage'],
  ['single request fallback witness', 'def test_single_request_over_the_window_falls_back_to_lanes_assessed_one_per_request'],
  ['no fallback when one judge counted witness', 'def test_single_request_does_not_fall_back_when_one_judge_counted'],
  ['refused before dispatch without observable usage witness', 'def test_material_above_the_byte_budget_is_refused_before_dispatch_when_usage_cannot_be_observed'],
]);
requireAll('skills/derivation-verify/tests/test_native_workflow_transport.mjs', read('skills/derivation-verify/tests/test_native_workflow_transport.mjs'), [
  ['native packet copy count witness', 'async function checkPacketCopies('],
  ['native input/execution span sources witness', 'await checkSpanSources('],
  ['native no-capture transport witness', 'await checkNativeCapturedRecords()'],
  ['native long material unavailable as content not completely read witness', 'await checkNativeLongMaterialUnavailable()'],
]);

// A lane carries no operator memory: the prose in both verification skills, the runner's default
// flag and observed-init rejection, and the witnesses that pin them.
requireAll(SWARM_SKILL_FILE, read(SWARM_SKILL_FILE), [
  ['operator context excluded from lanes', "**Keep the operator's own context out of the lane.**"],
  ['no operator memory in input framing', 'carries no operator memory'],
]);
for (const relPath of ['skills/derivation-verify/SKILL.md', 'skills/derivation-verify/references/contract.md']) {
  requireAll(relPath, read(relPath), [
    ['no operator memory in input independence', 'Input independence also requires that a lane carry no operator memory'],
  ]);
}
requireAll('skills/claude-cli-runner/SKILL.md', read('skills/claude-cli-runner/SKILL.md'), [
  ['hermetic default section', '## Context sources (hermetic by default)'],
  ['per-invocation record', '`context_sources.json`'],
]);
requireAll('skills/claude-cli-runner/scripts/run_claude.sh', read('skills/claude-cli-runner/scripts/run_claude.sh'), [
  ['safe mode is the default context', 'HERMETIC=1'],
  ['safe mode flag', 'CONTEXT_ARGS=(--safe-mode)'],
  ['git snapshot dropped', 'export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1'],
  ['flag reaches the real invocation', '"${CONTEXT_ARGS[@]+"${CONTEXT_ARGS[@]}"}"'],
  ['declared sources record', 'declare "${context_declare_args[@]}"'],
  ['observed init-event check', '"${CONTEXT_SOURCES}" observe'],
]);
requireAll('skills/claude-cli-runner/tests/test_context_sources.py', read('skills/claude-cli-runner/tests/test_context_sources.py'), [
  ['default flag witness', 'def test_runner_starts_every_lane_in_safe_mode_by_default'],
  ['memory rejection witness', 'def test_live_lane_reporting_operator_memory_is_rejected_not_retried'],
  ['reduced real stream witness', 'def test_reduced_real_init_events_separate_hermetic_from_operator_lanes'],
  ['installed CLI witness', 'def test_installed_cli_offers_safe_mode'],
]);

if (errors.length > 0) {
  console.error('[check-review-verification-contract-anti-drift] FAIL');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('[check-review-verification-contract-anti-drift] OK');
