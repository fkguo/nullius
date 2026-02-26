import { describe, it, expect } from 'vitest';
import { buildReviewNextActions } from '../../src/core/writing/submitReview.js';
import type { ReviewerReportV2 } from '../../src/core/contracts/reviewerReport.js';

function makeReport(overrides: Partial<ReviewerReportV2> = {}): ReviewerReportV2 {
  return {
    version: 2,
    severity: 'none',
    summary: 'All good',
    major_issues: [],
    minor_issues: [],
    notation_changes: [],
    asset_pointer_issues: [],
    follow_up_evidence_queries: [],
    structure_issues: [],
    grounding_risks: [],
    ...overrides,
  } as ReviewerReportV2;
}

describe('NEW-CONN-02: buildReviewNextActions', () => {
  it('returns next_actions with inspire_search + rebuild evidence when follow_up_evidence_queries exist', () => {
    const report = makeReport({
      follow_up_evidence_queries: [
        {
          section_number: '3.1',
          query: 'heavy quark expansion corrections',
          purpose: 'Missing HQET evidence for B meson form factors',
          expected_evidence_kinds: ['lattice', 'sum_rules'],
        },
        {
          section_number: '4.2',
          query: 'chiral perturbation theory pion',
          purpose: 'Need ChPT references for pion mass dependence',
          expected_evidence_kinds: ['chiral'],
        },
      ],
    });

    const actions = buildReviewNextActions({
      run_id: 'test-run',
      report,
      resume_from: 'review',
      reviewer_report_uri: 'hep://runs/test-run/artifact/writing_reviewer_report.json',
      manifest_uri: 'hep://runs/test-run/manifest',
    });

    // 2 inspire_search + 1 rebuild evidence + 1 resume tool = 4
    const searchActions = actions.filter(a => a.tool === 'inspire_search');
    expect(searchActions).toHaveLength(2);
    expect(searchActions[0].args.query).toBe('heavy quark expansion corrections');
    expect(searchActions[0].args.size).toBe(10);
    expect(searchActions[0].reason).toBe('Missing HQET evidence for B meson form factors');

    const rebuildActions = actions.filter(a => a.tool === 'hep_run_build_writing_evidence');
    expect(rebuildActions).toHaveLength(1);
    expect(rebuildActions[0].args.run_id).toBe('test-run');
  });

  it('returns no inspire_search actions when no follow_up_evidence_queries', () => {
    const report = makeReport({ follow_up_evidence_queries: [] });
    const actions = buildReviewNextActions({
      run_id: 'test-run',
      report,
      resume_from: 'review',
      reviewer_report_uri: 'hep://runs/test-run/artifact/writing_reviewer_report.json',
      manifest_uri: 'hep://runs/test-run/manifest',
    });

    const searchActions = actions.filter(a => a.tool === 'inspire_search');
    expect(searchActions).toHaveLength(0);

    const rebuildActions = actions.filter(a => a.tool === 'hep_run_build_writing_evidence');
    expect(rebuildActions).toHaveLength(0);
  });

  it('suggests outline tool when resume_from is outline', () => {
    const report = makeReport({ severity: 'major', iteration_entry: 'outline' });
    const actions = buildReviewNextActions({ run_id: 'test-run', report, resume_from: 'outline' });

    const resumeAction = actions.find(a => a.tool === 'hep_run_writing_create_outline_candidates_packet_v1');
    expect(resumeAction).toBeTruthy();
    expect(resumeAction!.args.run_id).toBe('test-run');
    expect(resumeAction!.reason).toContain('outline');
  });

  it('suggests section write tool when resume_from is sections', () => {
    const report = makeReport({ severity: 'major', iteration_entry: 'sections' });
    const actions = buildReviewNextActions({ run_id: 'test-run', report, resume_from: 'sections' });

    const resumeAction = actions.find(a => a.tool === 'hep_run_writing_create_section_write_packet_v1');
    expect(resumeAction).toBeTruthy();
    expect(resumeAction!.args.run_id).toBe('test-run');
  });

  it('suggests revision plan tool with correct URIs and round when resume_from is review', () => {
    const report = makeReport();
    const actions = buildReviewNextActions({
      run_id: 'test-run',
      report,
      resume_from: 'review',
      round: 3,
      reviewer_report_uri: 'hep://runs/test-run/artifact/writing_reviewer_report.json',
      manifest_uri: 'hep://runs/test-run/manifest',
    });

    const resumeAction = actions.find(a => a.tool === 'hep_run_writing_create_revision_plan_packet_v1');
    expect(resumeAction).toBeTruthy();
    expect(resumeAction!.args.reviewer_report_uri).toBe('hep://runs/test-run/artifact/writing_reviewer_report.json');
    expect(resumeAction!.args.manifest_uri).toBe('hep://runs/test-run/manifest');
    expect(resumeAction!.args.round).toBe(3);
    expect(resumeAction!.args).not.toHaveProperty('run_id');
  });

  it('falls back to run_id for review hint when URIs not provided', () => {
    const report = makeReport();
    const actions = buildReviewNextActions({ run_id: 'test-run', report, resume_from: 'review' });

    const resumeAction = actions.find(a => a.tool === 'hep_run_writing_create_revision_plan_packet_v1');
    expect(resumeAction).toBeTruthy();
    expect(resumeAction!.args.run_id).toBe('test-run');
  });

  it('caps follow_up queries at 5', () => {
    const queries = Array.from({ length: 8 }, (_, i) => ({
      section_number: `${i + 1}`,
      query: `query ${i + 1}`,
      purpose: `purpose ${i + 1}`,
      expected_evidence_kinds: ['theory'],
    }));
    const report = makeReport({ follow_up_evidence_queries: queries });
    const actions = buildReviewNextActions({
      run_id: 'test-run',
      report,
      resume_from: 'review',
      reviewer_report_uri: 'hep://runs/test-run/artifact/writing_reviewer_report.json',
      manifest_uri: 'hep://runs/test-run/manifest',
    });

    const searchActions = actions.filter(a => a.tool === 'inspire_search');
    expect(searchActions).toHaveLength(5);
  });

  it('all actions follow { tool, args, reason } convention', () => {
    const report = makeReport({
      follow_up_evidence_queries: [
        { section_number: '1', query: 'test', purpose: 'test purpose', expected_evidence_kinds: ['exp'] },
      ],
    });
    const actions = buildReviewNextActions({ run_id: 'test-run', report, resume_from: 'sections' });

    for (const action of actions) {
      expect(typeof action.tool).toBe('string');
      expect(action.tool.length).toBeGreaterThan(0);
      expect(typeof action.args).toBe('object');
      expect(action.args).not.toBeNull();
      expect(typeof action.reason).toBe('string');
      expect(action.reason.length).toBeGreaterThan(0);
    }
  });
});
