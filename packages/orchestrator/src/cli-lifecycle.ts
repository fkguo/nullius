import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INTEGRITY_MODES,
  writeIntegrityReceipt,
  type IntegrityMode,
} from '@nullius/shared';
import { shellQuote } from './decisions-ledger.js';
import { handleOrchRunApprove } from './orch-tools/approval.js';
import { createStateManager, requireState } from './orch-tools/common.js';
import { handleOrchRunRequestFinalConclusions } from './orch-tools/final-conclusions.js';
import { handleOrchRunRecordProposalDecision } from './orch-tools/proposal-decision.js';
import { handleOrchRunRecordVerification } from './orch-tools/verification.js';
import { handleOrchRunPause, handleOrchRunResume } from './orch-tools/control.js';
import { handleOrchRunStatus } from './orch-tools/create-status-list.js';
import type { ParsedCliArgs } from './cli-args.js';

export type CliIo = {
  cwd: string;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
};

function writeJson(io: CliIo, payload: unknown): void {
  io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
}

// Ledger strings (decision text, authorship, timestamps) are arbitrary user
// input rendered into a receipt other agents parse visually: raw control
// characters could forge receipt-looking lines or reprogram the terminal.
// Escape C0 controls, DEL, C1 controls, and the JS line separators with
// explicit unicode escapes (JSON.stringify leaves DEL/C1/U+2028/U+2029
// literal, so it cannot be used for this).
const RENDER_ESCAPE_SHORTHAND: Record<string, string> = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
};

function renderInline(value: unknown): string {
  return String(value ?? '').replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    ch => RENDER_ESCAPE_SHORTHAND[ch] ?? `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function writeStatusText(io: CliIo, payload: Record<string, unknown>, statusProjectRoot: string): void {
  io.stdout(`run_id: ${String(payload.run_id ?? '')}\n`);
  io.stdout(`run_status: ${String(payload.run_status ?? '')}\n`);
  // Always stated: "undeclared" is itself load-bearing information for a
  // reconnecting agent (see the undeclared-looks-file-mode drift hint).
  io.stdout(`execution_mode: ${payload.execution_mode ? String(payload.execution_mode) : 'undeclared'}\n`);
  io.stdout(`workflow_id: ${String(payload.workflow_id ?? '')}\n`);
  io.stdout(`project_uri: ${String(payload.uri ?? '')}\n`);
  if (payload.current_step) {
    io.stdout(`current_step: ${JSON.stringify(payload.current_step)}\n`);
  }
  if (payload.pending_approval) {
    io.stdout(`pending_approval: ${JSON.stringify(payload.pending_approval)}\n`);
  }
  if (payload.notes) {
    io.stdout(`notes: ${String(payload.notes)}\n`);
  }
  if (payload.plan_view_warning) {
    io.stdout(`plan_view_warning: ${JSON.stringify(payload.plan_view_warning)}\n`);
  }
  if (payload.plan_view && typeof payload.plan_view === 'object') {
    const planView = payload.plan_view as Record<string, unknown>;
    if (planView.plan_md_path) {
      io.stdout(`plan_md_path: ${String(planView.plan_md_path)}\n`);
    }
    if (planView.plan_current_step_id) {
      io.stdout(`plan_current_step: ${String(planView.plan_current_step_id)}\n`);
    }
    const steps = Array.isArray(planView.steps) ? planView.steps : [];
    if (steps.length > 0) {
      io.stdout('plan_steps:\n');
      for (const rawStep of steps) {
        if (!rawStep || typeof rawStep !== 'object') continue;
        const step = rawStep as Record<string, unknown>;
        io.stdout(`  - ${String(step.step_id ?? '')} [${String(step.status ?? '')}]: ${String(step.description ?? '')}\n`);
      }
    }
  }
  if (payload.resume_context && typeof payload.resume_context === 'object') {
    const resumeContext = payload.resume_context as Record<string, unknown>;
    io.stdout(`resume_status_command: ${String(resumeContext.status_command ?? '')}\n`);
    io.stdout(`resume_current_run_id: ${String(resumeContext.current_run_id ?? '')}\n`);
    io.stdout(`resume_run_status: ${String(resumeContext.run_status ?? '')}\n`);
    io.stdout(`resume_plan_md_path: ${String(resumeContext.plan_md_path ?? '')}\n`);
    const recommendedFiles = Array.isArray(resumeContext.recommended_files) ? resumeContext.recommended_files : [];
    if (recommendedFiles.length > 0) {
      io.stdout('resume_recommended_files:\n');
      for (const file of recommendedFiles) {
        io.stdout(`  - ${String(file)}\n`);
      }
    }
  }
  if (payload.recovery_context && typeof payload.recovery_context === 'object') {
    const recoveryContext = payload.recovery_context as Record<string, unknown>;
    const statusCommands = recoveryContext.status_commands && typeof recoveryContext.status_commands === 'object'
      ? recoveryContext.status_commands as Record<string, unknown>
      : {};
    io.stdout(`recovery_status_command: ${String(statusCommands.canonical ?? '')}\n`);
    io.stdout(`recovery_status_command_fallback: ${String(statusCommands.project_local_fallback ?? '')}\n`);
    const currentRun = recoveryContext.current_run && typeof recoveryContext.current_run === 'object'
      ? recoveryContext.current_run as Record<string, unknown>
      : {};
    io.stdout(`recovery_current_run_id: ${String(currentRun.run_id ?? '')}\n`);
    io.stdout(`recovery_current_run_status: ${String(currentRun.run_status ?? '')}\n`);
    io.stdout(`recovery_current_run_source: ${String(currentRun.source ?? '')}\n`);
    const planFocus = recoveryContext.plan_focus && typeof recoveryContext.plan_focus === 'object'
      ? recoveryContext.plan_focus as Record<string, unknown>
      : null;
    if (planFocus) {
      io.stdout(
        `recovery_plan_focus: ${String(planFocus.step_id ?? '')} [${String(planFocus.status ?? '')}] ${String(planFocus.description ?? '')} (source=${String(planFocus.source ?? '')})\n`,
      );
    }
    const latestLedgerEvent = recoveryContext.latest_ledger_event && typeof recoveryContext.latest_ledger_event === 'object'
      ? recoveryContext.latest_ledger_event as Record<string, unknown>
      : null;
    if (latestLedgerEvent) {
      io.stdout(
        `recovery_latest_ledger_event: ${String(latestLedgerEvent.event_type ?? '')} @ ${String(latestLedgerEvent.timestamp_utc ?? '')} => ${String(latestLedgerEvent.derived_run_status ?? '')}\n`,
      );
    }
    const recommendedFiles = Array.isArray(recoveryContext.recommended_files) ? recoveryContext.recommended_files : [];
    if (recommendedFiles.length > 0) {
      io.stdout('recovery_recommended_files:\n');
      for (const file of recommendedFiles) {
        io.stdout(`  - ${String(file)}\n`);
      }
    }
    const derivationWarnings = Array.isArray(recoveryContext.derivation_warnings) ? recoveryContext.derivation_warnings : [];
    if (derivationWarnings.length > 0) {
      io.stdout('recovery_derivation_warnings:\n');
      for (const warning of derivationWarnings) {
        io.stdout(`  - ${JSON.stringify(warning)}\n`);
      }
    }
  }
  if (payload.current_run_workflow_outputs_error) {
    io.stdout(`current_run_workflow_outputs_error: ${JSON.stringify(payload.current_run_workflow_outputs_error)}\n`);
  }
  if (payload.current_run_workflow_outputs_source) {
    io.stdout(`current_run_workflow_outputs_source: ${String(payload.current_run_workflow_outputs_source)}\n`);
  }
  if (payload.current_run_workflow_outputs && typeof payload.current_run_workflow_outputs === 'object') {
    io.stdout('workflow_outputs:\n');
    for (const [key, rawEntry] of Object.entries(payload.current_run_workflow_outputs as Record<string, unknown>)) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const entry = rawEntry as Record<string, unknown>;
      io.stdout(
        `  - ${key}: ${String(entry.status ?? '')}${entry.reason_code ? ` [reason=${String(entry.reason_code)}]` : ''}${entry.recoverable === true ? ' [recoverable]' : ''} :: ${String(entry.summary ?? '')}${entry.artifact_uri ? ` (${String(entry.artifact_uri)})` : ''}\n`,
      );
    }
  }
  if (payload.legacy_workflow_projection && typeof payload.legacy_workflow_projection === 'object') {
    io.stdout(`legacy_workflow_projection: ${JSON.stringify(payload.legacy_workflow_projection)}\n`);
  }
  // Surface-drift warnings (stale plan dates, unverified recent runs, stale
  // support files) were previously JSON-only; an operator reading the plain
  // status text never saw them, which is exactly how a stale progress record
  // goes unnoticed. Render each issue as one actionable line.
  const surfaceDrift = payload.project_surface_drift;
  if (surfaceDrift && typeof surfaceDrift === 'object') {
    const drift = surfaceDrift as Record<string, unknown>;
    const issues = Array.isArray(drift.issues) ? drift.issues : [];
    if (issues.length > 0) {
      io.stdout('project_attention:\n');
      for (const rawIssue of issues) {
        if (!rawIssue || typeof rawIssue !== 'object') continue;
        const issue = rawIssue as Record<string, unknown>;
        io.stdout(`  - ${String(issue.code ?? '')} (${String(issue.path ?? '')}): ${String(issue.message ?? '')}\n`);
      }
    }
  }
  // Conversational decisions: recorded totals plus every still-open item.
  // Open items are exactly what a reconnecting agent must not lose — they are
  // the questions a human still owes an answer to.
  const decisionLedger = payload.decision_ledger;
  if (decisionLedger && typeof decisionLedger === 'object') {
    const ledger = decisionLedger as Record<string, unknown>;
    const decidedCount = Number(ledger.decided_count ?? 0);
    const openCount = Number(ledger.open_count ?? 0);
    const invalidLines = Number(ledger.invalid_lines ?? 0);
    const duplicateIdCount = Number(ledger.duplicate_id_count ?? 0);
    const ambiguousProvisionalIdCount = Number(ledger.ambiguous_provisional_id_count ?? 0);
    const unlandedCount = Number(ledger.unlanded_count ?? 0);
    // A ledger FILE that exists renders even at 0/0 — an emptied ledger is a
    // deliberate state the operator should see, unlike the never-adopted case
    // (no file), which stays silent.
    if (
      ledger.exists === true
      || decidedCount > 0
      || openCount > 0
      || invalidLines > 0
      || duplicateIdCount > 0
      || ambiguousProvisionalIdCount > 0
      || unlandedCount > 0
    ) {
      io.stdout(`decisions: ${decidedCount} decided, ${openCount} open\n`);
      const openItems = Array.isArray(ledger.open_items) ? ledger.open_items : [];
      for (const rawItem of openItems) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const item = rawItem as Record<string, unknown>;
        io.stdout(`  - [open] ${renderInline(item.id)} (${renderInline(item.ts)}): ${renderInline(item.text)}\n`);
      }
      const omitted = Number(ledger.open_items_omitted ?? 0);
      if (omitted > 0) {
        io.stdout(`  ... and ${omitted} more open (run: nullius decision list --project-root ${shellQuote(statusProjectRoot)})\n`);
      }
      if (invalidLines > 0) {
        io.stdout(`  decisions_invalid_lines: ${invalidLines} (invalid, duplicate, or mis-resolving lines in ${String(ledger.path ?? 'the decisions ledger')})\n`);
      }
      if (duplicateIdCount > 0) {
        io.stdout(
          `  decisions_duplicate_ids: ${duplicateIdCount} (one id on more than one entry in `
          + `${String(ledger.path ?? 'the decisions ledger')}; --resolves cannot name one of them)\n`,
        );
        const duplicates = Array.isArray(ledger.duplicate_ids) ? ledger.duplicate_ids : [];
        for (const rawDuplicate of duplicates) {
          if (!rawDuplicate || typeof rawDuplicate !== 'object') continue;
          const duplicate = rawDuplicate as Record<string, unknown>;
          const lines = Array.isArray(duplicate.lines) ? duplicate.lines.join(', ') : '';
          // Quoted for the same reason as in `decision list`: an empty or
          // whitespace-only id must still be visible as a thing to repair.
          io.stdout(`    - "${renderInline(duplicate.id)}" on lines ${lines}\n`);
        }
        const duplicatesOmitted = Number(ledger.duplicate_ids_omitted ?? 0);
        if (duplicatesOmitted > 0) {
          io.stdout(`    ... and ${duplicatesOmitted} more (run: nullius decision list --project-root ${shellQuote(statusProjectRoot)})\n`);
        }
      }
      if (ambiguousProvisionalIdCount > 0) {
        io.stdout(
          `  decisions_ambiguous_provisional_ids: ${ambiguousProvisionalIdCount} `
          + `(a retained branch id is reused by another entry in `
          + `${String(ledger.path ?? 'the decisions ledger')}; old branch resolutions `
          + 'cannot name one target)\n',
        );
        const ambiguous = Array.isArray(ledger.ambiguous_provisional_ids)
          ? ledger.ambiguous_provisional_ids
          : [];
        for (const rawEntry of ambiguous) {
          if (!rawEntry || typeof rawEntry !== 'object') continue;
          const entry = rawEntry as Record<string, unknown>;
          const lines = Array.isArray(entry.lines) ? entry.lines.join(', ') : '';
          io.stdout(`    - "${renderInline(entry.id)}" on lines ${lines}\n`);
        }
        const ambiguousOmitted = Number(ledger.ambiguous_provisional_ids_omitted ?? 0);
        if (ambiguousOmitted > 0) {
          io.stdout(
            `    ... and ${ambiguousOmitted} more `
            + `(run: nullius decision list --project-root ${shellQuote(statusProjectRoot)})\n`,
          );
        }
      }
      if (unlandedCount > 0) {
        io.stdout(
          `  decisions_unlanded: ${unlandedCount} (provisional branch ids in `
          + `${String(ledger.path ?? 'the decisions ledger')}; run nullius decision land `
          + `--project-root ${shellQuote(statusProjectRoot)} on the trunk before citing them)\n`,
        );
        const unlandedIds = Array.isArray(ledger.unlanded_ids) ? ledger.unlanded_ids : [];
        for (const id of unlandedIds) {
          io.stdout(`    - ${renderInline(id)}\n`);
        }
        const unlandedOmitted = Number(ledger.unlanded_ids_omitted ?? 0);
        if (unlandedOmitted > 0) {
          io.stdout(`    ... and ${unlandedOmitted} more (run: nullius decision list --project-root ${shellQuote(statusProjectRoot)})\n`);
        }
      }
    }
  }
  if (payload.decision_ledger_error && typeof payload.decision_ledger_error === 'object') {
    io.stdout(`decision_ledger_error: ${JSON.stringify(payload.decision_ledger_error)}\n`);
  }
  const digestError = payload.project_recent_digest_error;
  if (digestError && typeof digestError === 'object') {
    io.stdout(`project_recent_digest_error: ${JSON.stringify(digestError)}\n`);
  }
  const digest = payload.project_recent_digest;
  if (!digest || typeof digest !== 'object') {
    return;
  }
  io.stdout('recent_digest:\n');
  const latestFinalConclusions = (digest as Record<string, unknown>).latest_final_conclusions;
  if (latestFinalConclusions && typeof latestFinalConclusions === 'object') {
    const entry = latestFinalConclusions as Record<string, unknown>;
    io.stdout(
      `  latest_final_conclusions: ${String(entry.run_id ?? '')} @ ${String(entry.created_at ?? '')} :: ${String(entry.summary ?? '')}\n`,
    );
  }
  const latestProposals = (digest as Record<string, unknown>).latest_proposals;
  if (latestProposals && typeof latestProposals === 'object') {
    for (const kind of ['repair', 'skill', 'optimize', 'innovate'] as const) {
      const entry = (latestProposals as Record<string, unknown>)[kind];
      if (!entry || typeof entry !== 'object') continue;
      const proposal = entry as Record<string, unknown>;
      const decision = typeof proposal.decision === 'string' ? ` [decision=${proposal.decision}]` : '';
      io.stdout(
        `  latest_${kind}_proposal: ${String(proposal.run_id ?? '')} :: ${String(proposal.summary ?? '')}${decision}\n`,
      );
    }
  }
  const activeTeamRun = (digest as Record<string, unknown>).active_team_run;
  if (activeTeamRun && typeof activeTeamRun === 'object') {
    const entry = activeTeamRun as Record<string, unknown>;
    io.stdout(
      `  active_team_run: ${String(entry.run_id ?? '')} status=${String(entry.run_status ?? '')} active_assignments=${String(entry.active_assignment_count ?? '')} pending_approvals=${String(entry.pending_approval_count ?? '')}\n`,
    );
  }
}

function pendingApprovalPacketSha(projectRoot: string, approvalId: string): string {
  const { manager } = createStateManager(projectRoot);
  const state = requireState(projectRoot, manager);
  const pending = state.pending_approval as Record<string, unknown> | null;
  if (!pending || pending.approval_id !== approvalId) {
    throw new Error(`pending approval mismatch for ${approvalId}`);
  }
  const packetPath = typeof pending.packet_path === 'string' ? pending.packet_path : '';
  if (!packetPath) {
    throw new Error(`pending approval ${approvalId} is missing packet_path`);
  }
  const packetJsonPath = path.join(projectRoot, path.dirname(packetPath), 'approval_packet_v1.json');
  if (!fs.existsSync(packetJsonPath)) {
    throw new Error(`missing approval packet: ${packetJsonPath}`);
  }
  return createHash('sha256').update(fs.readFileSync(packetJsonPath)).digest('hex');
}

export async function runStatusCommand(projectRoot: string, json: boolean, io: CliIo): Promise<void> {
  const payload = await handleOrchRunStatus({ project_root: projectRoot }) as Record<string, unknown>;
  if (json) {
    writeJson(io, payload);
    return;
  }
  writeStatusText(io, payload, projectRoot);
}

export async function runPauseCommand(projectRoot: string, note: string | null, io: CliIo): Promise<void> {
  const payload = await handleOrchRunPause({ project_root: projectRoot, ...(note ? { note } : {}) }) as Record<string, unknown>;
  io.stdout(`paused: ${String(payload.run_id ?? '')}\n`);
}

export async function runResumeCommand(projectRoot: string, note: string | null, force: boolean, io: CliIo): Promise<void> {
  const payload = await handleOrchRunResume({
    project_root: projectRoot,
    force,
    ...(note ? { note } : {}),
  }) as Record<string, unknown>;
  io.stdout(`resumed: ${String(payload.run_id ?? '')}\n`);
}

export async function runApproveCommand(
  projectRoot: string,
  approvalId: string,
  note: string | null,
  io: CliIo,
): Promise<void> {
  const payload = await handleOrchRunApprove({
    _confirm: true,
    approval_id: approvalId,
    approval_packet_sha256: pendingApprovalPacketSha(projectRoot, approvalId),
    project_root: projectRoot,
    ...(note ? { note } : {}),
  }) as Record<string, unknown>;
  io.stdout(`approved: ${String(payload.approval_id ?? approvalId)}\n`);
  if (payload.final_conclusions_path) {
    io.stdout(`final_conclusions_path: ${String(payload.final_conclusions_path)}\n`);
  }
  if (payload.final_conclusions_uri) {
    io.stdout(`final_conclusions_uri: ${String(payload.final_conclusions_uri)}\n`);
  }
}

export async function runIntegrityRecordCommand(
  projectRoot: string,
  parsed: Extract<ParsedCliArgs, { command: 'integrity-record' }>,
  io: CliIo,
): Promise<void> {
  // Validate modes against the canonical INTEGRITY_MODES list. We coerce at
  // the CLI boundary so the shared primitive's invariant ("modes are M1..M7")
  // does not need to re-parse free-form strings.
  const allowed = new Set<string>(INTEGRITY_MODES);
  const modesChecked: IntegrityMode[] = [];
  for (const m of parsed.modes) {
    if (!allowed.has(m)) {
      throw new Error(`integrity-record --modes value ${JSON.stringify(m)} is not one of ${INTEGRITY_MODES.join(',')}`);
    }
    modesChecked.push(m as IntegrityMode);
  }
  const skipped: Array<{ mode: IntegrityMode; reason: string }> = [];
  for (const s of parsed.skipped) {
    if (!allowed.has(s.mode)) {
      throw new Error(`integrity-record --skip mode ${JSON.stringify(s.mode)} is not one of ${INTEGRITY_MODES.join(',')}`);
    }
    skipped.push({ mode: s.mode as IntegrityMode, reason: s.reason });
  }
  const receipt = writeIntegrityReceipt(
    projectRoot,
    parsed.approvalId,
    modesChecked,
    parsed.notes,
    skipped,
  );
  writeJson(io, {
    recorded: true,
    approval_id: receipt.approval_id,
    modes_checked: receipt.modes_checked,
    ...(receipt.modes_skipped ? { modes_skipped: receipt.modes_skipped } : {}),
    timestamp_utc: receipt.timestamp_utc,
  });
}

export async function runFinalConclusionsCommand(
  projectRoot: string,
  runId: string,
  note: string | null,
  io: CliIo,
): Promise<void> {
  const payload = await handleOrchRunRequestFinalConclusions({
    project_root: projectRoot,
    run_id: runId,
    ...(note ? { note } : {}),
  });
  writeJson(io, payload);
}

export async function runProposalDecisionCommand(
  projectRoot: string,
  parsed: Extract<ParsedCliArgs, { command: 'proposal-decision' }>,
  io: CliIo,
): Promise<void> {
  const payload = await handleOrchRunRecordProposalDecision({
    project_root: projectRoot,
    proposal_kind: parsed.proposalKind,
    proposal_id: parsed.proposalId,
    decision: parsed.decision,
    ...(parsed.note ? { note: parsed.note } : {}),
  });
  writeJson(io, payload);
}

export async function runDecisionCommand(
  projectRoot: string,
  parsed: Extract<ParsedCliArgs, { command: 'decision' }>,
  io: CliIo,
): Promise<number> {
  const {
    appendDecision,
    landDecisionIds,
    openDecisions,
    readDecisionsLedger,
    sortDecisionsByTimestamp,
  } = await import('./decisions-ledger.js');
  if (parsed.action === 'land') {
    const result = landDecisionIds(projectRoot);
    if (result.landed.length > 0 || result.rewritten_resolutions > 0) {
      try {
        const { manager } = createStateManager(projectRoot);
        manager.appendLedger('decision_ids_landed', {
          details: {
            mappings: result.landed,
            rewritten_resolution_count: result.rewritten_resolutions,
          },
        });
      } catch (error) {
        io.stderr(
          `[warn] decision landing changed ${result.landed.length} id(s) and `
          + `${result.rewritten_resolutions} resolution(s), but the ledger.jsonl `
          + `mirror event failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    if (parsed.json) {
      writeJson(io, {
        path: result.path,
        landed_count: result.landed.length,
        rewritten_resolution_count: result.rewritten_resolutions,
        mappings: result.landed,
      });
      return 0;
    }
    if (result.landed.length === 0 && result.rewritten_resolutions === 0) {
      io.stdout(`landed: 0 (ledger already canonical in ${result.path})\n`);
      return 0;
    }
    io.stdout(`landed: ${result.landed.length}\n`);
    for (const mapping of result.landed) {
      io.stdout(`  - ${mapping.provisional_id} -> ${mapping.id}\n`);
    }
    io.stdout(`rewritten_resolutions: ${result.rewritten_resolutions}\n`);
    return 0;
  }
  if (parsed.action === 'list') {
    const snapshot = readDecisionsLedger(projectRoot);
    const records = sortDecisionsByTimestamp(snapshot.records);
    const open = sortDecisionsByTimestamp(openDecisions(snapshot.records));
    // A duplicate id makes `--resolves <id>` name two entries at once, so the
    // read commands refuse to hand back the ledger as if it were sound: the
    // records still print (a reader may be checking whether an entry landed),
    // followed by the collisions and the repair, and the command exits
    // non-zero. Nothing at merge time reports a collision, so this is where a
    // ledger already carrying one becomes visible.
    const ledgerDefectExitCode = (
      snapshot.duplicate_ids.length > 0
      || snapshot.ambiguous_provisional_ids.length > 0
    ) ? 1 : 0;
    const reportLedgerDefects = (): number => {
      if (snapshot.duplicate_ids.length > 0) {
        io.stdout(`duplicate_ids: ${snapshot.duplicate_ids.length} (one id, more than one entry in ${snapshot.path})\n`);
        for (const duplicate of snapshot.duplicate_ids) {
          // Quoted: an id can be empty or whitespace-only on a hand-edited
          // line, and an unquoted one would leave the repair pointing at
          // nothing visible.
          io.stdout(`  - "${renderInline(duplicate.id)}" on lines ${duplicate.lines.join(', ')}\n`);
        }
        io.stdout('  repair: keep the first occurrence of each id, reissue every later one, and repoint any resolves naming it\n');
      }
      if (snapshot.ambiguous_provisional_ids.length > 0) {
        io.stdout(
          `ambiguous_provisional_ids: ${snapshot.ambiguous_provisional_ids.length} `
          + `(one retained branch id names more than one entry in ${snapshot.path})\n`,
        );
        for (const ambiguous of snapshot.ambiguous_provisional_ids) {
          io.stdout(`  - "${renderInline(ambiguous.id)}" on lines ${ambiguous.lines.join(', ')}\n`);
        }
        io.stdout(
          '  repair: keep one durable mapping for each provisional id, reissue any current entry '
          + 'that reused it, and repoint old resolutions to the intended D<n>\n',
        );
      }
      return ledgerDefectExitCode;
    };
    if (parsed.json) {
      writeJson(io, {
        path: snapshot.path,
        exists: snapshot.exists,
        invalid_lines: snapshot.invalid_lines,
        duplicate_ids: snapshot.duplicate_ids,
        ambiguous_provisional_ids: snapshot.ambiguous_provisional_ids,
        unlanded_ids: snapshot.unlanded_ids,
        records,
        open_ids: open.map((record) => record.id),
      });
      return ledgerDefectExitCode;
    }
    if (!snapshot.exists || snapshot.records.length === 0) {
      io.stdout('no decisions recorded\n');
      if (snapshot.invalid_lines > 0) {
        io.stdout(`invalid_lines: ${snapshot.invalid_lines} (invalid, duplicate, or mis-resolving lines in ${snapshot.path})\n`);
      }
      return reportLedgerDefects();
    }
    const openIds = new Set(open.map((entry) => entry.id));
    for (const record of records) {
      const openMark = record.kind === 'pending' && openIds.has(record.id) ? ' [open]' : '';
      const unlandedMark = snapshot.unlanded_ids.includes(record.id) ? ' [unlanded]' : '';
      const landedFromMark = record.provisional_id ? ` landed_from=${record.provisional_id}` : '';
      const resolvesMark = record.resolves ? ` resolves=${record.resolves}` : '';
      io.stdout(
        `${record.id} ${record.kind}${openMark}${unlandedMark} @ ${renderInline(record.ts)} `
        + `(${renderInline(record.by)})${landedFromMark}${resolvesMark}: ${renderInline(record.text)}\n`,
      );
    }
    io.stdout(
      `decisions: ${snapshot.records.filter((record) => record.kind === 'decided').length} decided, `
      + `${open.length} open, ${snapshot.unlanded_ids.length} unlanded\n`,
    );
    if (snapshot.invalid_lines > 0) {
      io.stdout(`invalid_lines: ${snapshot.invalid_lines}\n`);
    }
    return reportLedgerDefects();
  }
  const record = appendDecision(projectRoot, {
    kind: parsed.action === 'record' ? 'decided' : 'pending',
    text: parsed.text ?? '',
    by: parsed.by,
    resolves: parsed.resolves,
  });
  // Mirror into the machine event log so the chronological ledger stays whole.
  // .nullius/decisions.jsonl is the parse source of truth and is already
  // durably written at this point; a mirror failure must not make a recorded
  // decision look unrecorded (a retry would duplicate it), so it degrades to
  // a warning instead of failing the command.
  try {
    const { manager } = createStateManager(projectRoot);
    manager.appendLedger(record.kind === 'decided' ? 'decision_recorded' : 'decision_pending_recorded', {
      details: {
        decision_id: record.id,
        by: record.by,
        ...(record.resolves ? { resolves: record.resolves } : {}),
      },
    });
  } catch (error) {
    io.stderr(`[warn] decision ${record.id} recorded, but the ledger.jsonl mirror event failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  io.stdout(`${record.kind === 'decided' ? 'recorded' : 'pending'}: ${record.id}\n`);
  if (record.resolves) {
    io.stdout(`resolved: ${record.resolves}\n`);
  }
  return 0;
}

export async function runVerifyCommand(
  projectRoot: string,
  parsed: Extract<ParsedCliArgs, { command: 'verify' }>,
  io: CliIo,
): Promise<void> {
  const payload = await handleOrchRunRecordVerification({
    project_root: projectRoot,
    run_id: parsed.runId,
    status: parsed.status,
    summary: parsed.summary,
    evidence_paths: parsed.evidencePaths,
    checker_path: parsed.checkerPath,
    checker_runtime: parsed.checkerRuntime,
    checker_helper_paths: parsed.checkerHelperPaths,
    quantity_id: parsed.quantityId,
    layer_id: parsed.layerId,
    reference_provenance: parsed.referenceProvenance,
    disputed_dimensions: parsed.disputedDimensions,
    required_negative_control_ids: parsed.requiredNegativeControlIds,
    check_kind: parsed.checkKind,
    confidence_level: parsed.confidenceLevel,
    ...(parsed.confidenceScore !== null ? { confidence_score: parsed.confidenceScore } : {}),
    ...(parsed.notes ? { notes: parsed.notes } : {}),
  });
  writeJson(io, payload);
}
