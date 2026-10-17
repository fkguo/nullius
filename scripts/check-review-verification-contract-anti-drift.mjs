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
 * review-swarm reviewer roles).
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
  ['refusal above the window, never truncation', 'a request that still exceeds it is refused, never truncated'],
]);
// The copy count per packet record is pinned by offline witnesses in both executors; prose alone erodes.
requireAll('skills/derivation-verify/tests/test_full_derivation_transport.py', read('skills/derivation-verify/tests/test_full_derivation_transport.py'), [
  ['per-record copy count witness', 'def test_comparator_packet_repeats_lane_text_only_inside_transport'],
  ['live-capture content-block carriage witness', 'def test_live_capture_stream_is_carried_as_content_blocks_and_two_lanes_fit'],
  ['unproven captured content stays inline witness', 'def test_captured_content_not_proven_equal_to_a_shipped_field_stays_inline'],
  ['live-capture refusal above the window witness', 'def test_live_capture_request_above_the_window_is_refused_not_truncated'],
  ['stream view omits only bookkeeping witness', 'def test_stream_view_omits_only_bookkeeping_and_references_only_the_lanes_own_output'],
  ['captured text referenced only to a quotable field witness', 'def test_captured_text_is_referenced_only_to_a_field_spans_can_quote'],
  ['captured-content span sources witness', 'def test_input_execution_spans_quote_captured_content_only_as_the_packet_shows_it'],
  ['live-capture two-lane margin assertion', "assert mb.validate_request_bytes(mb._COMPARE_SYSTEM, prompt, mb.request_budgets()) <= 0.6 * mb.request_budgets()['context_bytes']"],
  ['two-lane fixture under the default window assertion', "assert len(seen[0].encode('utf-8')) <= mb.request_budgets()['context_bytes']"],
]);
requireAll('skills/derivation-verify/tests/test_native_workflow_transport.mjs', read('skills/derivation-verify/tests/test_native_workflow_transport.mjs'), [
  ['native packet copy count witness', 'async function checkPacketCopies('],
  ['native input/execution span sources witness', 'await checkSpanSources('],
  ['native no-capture transport witness', 'await checkNativeCapturedRecords()'],
]);

if (errors.length > 0) {
  console.error('[check-review-verification-contract-anti-drift] FAIL');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('[check-review-verification-contract-anti-drift] OK');
