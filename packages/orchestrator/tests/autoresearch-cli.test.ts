import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTORESEARCH_PUBLIC_COMMANDS,
  AUTORESEARCH_PUBLIC_COMMAND_INVENTORY,
} from '../src/cli-command-inventory.js';
import { StateManager } from '../src/state-manager.js';
import { createTeamExecutionState } from '../src/team-execution-state.js';
import { TeamExecutionStateManager } from '../src/team-execution-storage.js';
import type { TeamPermissionMatrix } from '../src/team-execution-types.js';
import type { RunState } from '../src/types.js';
import { runCli } from '../src/cli.js';
import { getFrontDoorAuthoritySurface } from '../../../scripts/lib/front-door-authority-map.mjs';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-cli-'));
}

function makeIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stderr: (text: string) => stderr.push(text),
      stdout: (text: string) => stdout.push(text),
    },
    stderr,
    stdout,
  };
}

function extractTopLevelCommands(helpText: string): string[] {
  return helpText
    .split('\n')
    .map(line => line.match(/^\s+autoresearch\s+([a-z-]+)\b/)?.[1] ?? null)
    .filter((value): value is string => value !== null);
}

function createComputationFixture(projectRoot: string, runId: string): { runDir: string; manifestPath: string } {
  const runDir = path.join(projectRoot, runId);
  const scriptPath = path.join(runDir, 'computation', 'scripts', 'write_ok.py');
  const manifestPath = path.join(runDir, 'computation', 'manifest.json');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/ok.txt').write_text('ok\\n', encoding='utf-8')\n",
    'utf-8',
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schema_version: 1,
        entry_point: { script: 'scripts/write_ok.py', tool: 'python' },
        steps: [
          {
            id: 'write_ok',
            tool: 'python',
            script: 'scripts/write_ok.py',
            expected_outputs: ['outputs/ok.txt'],
          },
        ],
        environment: { python_version: '3.11', platform: 'any' },
        dependencies: {},
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  return { runDir, manifestPath };
}

const EXISTING_EVIDENCE_PATH = 'artifacts/computation_result_v1.json';

const TEAM_PERMISSIONS: TeamPermissionMatrix = {
  delegation: [
    {
      from_role: 'lead',
      to_role: 'delegate',
      allowed_task_kinds: ['compute', 'review'],
      allowed_handoff_kinds: ['compute', 'review'],
    },
  ],
  interventions: [
    {
      actor_role: 'lead',
      allowed_scopes: ['task', 'team'],
      allowed_kinds: ['pause', 'resume', 'cancel', 'cascade_stop'],
    },
  ],
};

function makeAwaitingApprovalState(): { projectRoot: string; approvalId: string } {
  const projectRoot = makeTempProjectRoot();
  const manager = new StateManager(projectRoot);
  manager.ensureDirs();
  const approvalId = 'A1-0001';
  const packetDir = path.join(projectRoot, 'artifacts', 'runs', 'M1', 'approvals', approvalId);
  fs.mkdirSync(packetDir, { recursive: true });
  fs.writeFileSync(path.join(packetDir, 'approval_packet_v1.json'), JSON.stringify({ approval_id: approvalId }, null, 2));
  const state = manager.readState() as RunState;
  state.run_id = 'M1';
  state.workflow_id = 'ingest';
  state.run_status = 'awaiting_approval';
  state.pending_approval = {
    approval_id: approvalId,
    category: 'A1',
    plan_step_ids: [],
    requested_at: '2026-03-23T00:00:00Z',
    timeout_at: null,
    on_timeout: 'block',
    packet_path: path.join('artifacts', 'runs', 'M1', 'approvals', approvalId, 'packet.md'),
  };
  manager.saveState(state);
  return { approvalId, projectRoot };
}

function writeProjectSurfaceGuidanceFiles(
  projectRoot: string,
  options: {
    includeOptionalHostMentions?: boolean;
    includeResearchContractResidue?: boolean;
  } = {},
): void {
  const optionalHostText = options.includeOptionalHostMentions
    ? 'Use prompts/ and team/ only after wiring research_team_config.json for the host layer.'
    : 'Host-local support layers are optional and do not replace the project read order.';
  const researchContractHeader = options.includeResearchContractResidue
    ? '# research_contract.md (Template)'
    : '# research_contract.md';
  const researchContractLegacyText = options.includeResearchContractResidue
    ? [
        '- If research-team host surfaces exist, run `run_team_cycle.sh --preflight-only` once to catch missing gates early.',
        '> If doubled backslashes appear inside math, fix them with `python3 ~/.codex/skills/research-team/scripts/bin/fix_markdown_double_backslash_math.py --notes research_contract.md --in-place`.',
        'This section is checked by the knowledge layers gate when `knowledge_layers_gate=true` (via [research_team_config.json](research_team_config.json)).',
      ].join('\n')
    : 'Host-local automation may add extra support layers, but this contract and `.autoresearch/` state remain the durable restart truth.';

  fs.writeFileSync(
    path.join(projectRoot, 'AGENTS.md'),
    [
      '# AGENTS.md',
      '',
      '## Reconnect discipline',
      '',
      '- If `.autoresearch/` exists, run `autoresearch status --json` before continuing.',
      `- ${optionalHostText}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'project_index.md'),
    [
      '# project_index.md',
      '',
      '## Optional expansions',
      '',
      options.includeOptionalHostMentions
        ? '- prompts/, team/, and research_team_config.json are host-local support surfaces.'
        : '- Host-local team or automation surfaces are opt-in support layers.',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'research_plan.md'),
    [
      '# research_plan.md',
      '',
      '## Restart checklist',
      '',
      '- Read `AGENTS.md`, then `project_charter.md`, then this file.',
      '- Keep `research_plan.md` and `.autoresearch/state.json` current enough for the next reconnect.',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'research_contract.md'),
    [
      researchContractHeader,
      '',
      '<!-- RESEARCH_NOTEBOOK_SYNC_START -->',
      '- Source notebook: [research_notebook.md](research_notebook.md)',
      '- Notebook sha256: `(refresh to populate)`',
      '<!-- RESEARCH_NOTEBOOK_SYNC_END -->',
      '',
      researchContractLegacyText,
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe('autoresearch CLI', () => {
  it('renders top-level help with the canonical lifecycle scope', async () => {
    const { io, stdout } = makeIo(process.cwd());
    const code = await runCli(['--help'], io);
    const helpText = stdout.join('');
    const requiredSnippets = [
      'Canonical generic lifecycle and workflow-plan entrypoint',
      'autoresearch run --workflow-id <id> [options]',
      'autoresearch workflow-plan --recipe <recipe_id> [options]',
      '`run` remains the only execution front door',
      'Pipeline A parser support commands `doctor`, `bridge`, and `literature-gap` are deleted.',
      'Retired-public maintainer helpers `method-design` and `run-card` are deleted; only `branch` remains on the provider-local internal parser.',
    ] as const;
    const forbiddenSnippets = [
      'Provider-local `doctor`/`bridge` remain on the transitional Pipeline A surface',
      '`hepar literature-gap` remains',
      'internal parser support commands remain the recommended entrypoint',
    ] as const;

    expect(code).toBe(0);
    for (const snippet of requiredSnippets) {
      expect(helpText).toContain(snippet);
    }
    for (const snippet of forbiddenSnippets) {
      expect(helpText).not.toContain(snippet);
    }
    const topLevelCommands = extractTopLevelCommands(helpText);
    expect(topLevelCommands).toEqual([...AUTORESEARCH_PUBLIC_COMMANDS]);
    expect(topLevelCommands).not.toContain('doctor');
    expect(topLevelCommands).not.toContain('bridge');
    expect(topLevelCommands).not.toContain('literature-gap');
    expect(topLevelCommands).not.toContain('method-design');
    expect(topLevelCommands).not.toContain('run-card');
    expect(topLevelCommands).not.toContain('branch');
  });

  it('front-door authority map keeps the canonical autoresearch inventory exact', () => {
    const surface = getFrontDoorAuthoritySurface('autoresearch_cli');

    expect(surface.classification).toBe('canonical_public');
    expect(surface.surface_kind).toBe('cli_command_inventory');
    expect(surface.exact_inventory_source).toBe('packages/orchestrator/src/cli-command-inventory.ts');
    expect(surface.commands).toEqual([...AUTORESEARCH_PUBLIC_COMMAND_INVENTORY]);
  });

  it('records decisive verification through the canonical public CLI inventory', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const runId = 'M-VERIFY-1';
    const state = manager.readState();
    state.run_id = runId;
    state.workflow_id = 'computation';
    state.run_status = 'running';
    state.gate_satisfied.A3 = 'A3-0001';
    manager.saveState(state);
    const { runDir, manifestPath } = createComputationFixture(projectRoot, runId);

    await expect(runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], makeIo(projectRoot).io)).resolves.toBe(0);

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli([
      'verify',
      '--run-id', runId,
      '--status', 'passed',
      '--summary', 'Decisive verification completed successfully.',
      '--evidence-path', EXISTING_EVIDENCE_PATH,
      '--confidence-level', 'high',
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      recorded: true,
      run_id: runId,
      status: 'passed',
    });
  });

  it('records a proposal decision through the canonical public CLI inventory', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();

    for (const runId of ['M-PROP-1', 'M-PROP-2']) {
      const state = manager.readState();
      state.run_id = runId;
      state.workflow_id = 'computation';
      state.run_status = 'running';
      state.gate_satisfied.A3 = 'A3-0001';
      manager.saveState(state);
      const runDir = path.join(projectRoot, runId);
      const scriptPath = path.join(runDir, 'computation', 'scripts', 'fail.py');
      const manifestPath = path.join(runDir, 'computation', 'manifest.json');
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, "raise SystemExit(1)\n", 'utf-8');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            schema_version: 1,
            entry_point: { script: 'scripts/fail.py', tool: 'python' },
            steps: [
              {
                id: 'fail_step',
                tool: 'python',
                script: 'scripts/fail.py',
                expected_outputs: [],
              },
            ],
            environment: { python_version: '3.11', platform: 'any' },
            dependencies: { python_packages: ['sympy'] },
          },
          null,
          2,
        ) + '\n',
        'utf-8',
      );
      await expect(runCli([
        'run',
        '--workflow-id', 'computation',
        '--run-id', runId,
        '--run-dir', runDir,
        '--manifest', manifestPath,
      ], makeIo(projectRoot).io)).resolves.toBe(1);
    }
    const current = manager.readState();
    current.run_id = 'M-PROP-2';
    current.workflow_id = 'computation';
    current.run_status = 'failed';
    const proposalPath = path.join(projectRoot, 'artifacts', 'runs', 'M-PROP-2', 'mutation_proposal_repair_v1.json');
    const proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf-8')) as { proposal_id: string };
    current.artifacts = {
      ...current.artifacts,
      mutation_proposal_repair_v1: path.join('artifacts', 'runs', 'M-PROP-2', 'mutation_proposal_repair_v1.json'),
    };
    manager.saveState(current);

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli([
      'proposal-decision',
      '--proposal-kind', 'repair',
      '--proposal-id', proposal.proposal_id,
      '--decision', 'dismissed',
      '--note', 'too noisy',
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      recorded: true,
      proposal_kind: 'repair',
      proposal_id: proposal.proposal_id,
      decision: 'dismissed',
      suppress_duplicates: true,
    });
  });

  it('resolves public stateful workflow plans through the canonical autoresearch front door', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli([
      'workflow-plan',
      '--recipe', 'literature_landscape',
      '--phase', 'prework',
      '--run-id', 'M-LIT-1',
      '--query', 'bootstrap amplitudes',
      '--topic', 'bootstrap amplitudes',
      '--seed-recid', '1234',
      '--preferred-provider', 'openalex',
      '--available-tool', 'openalex_search',
      '--available-tool', 'inspire_topic_analysis',
      '--available-tool', 'inspire_network_analysis',
      '--available-tool', 'inspire_trace_original_source',
    ], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join('')) as {
      recipe_id: string;
      phase?: string;
      entry_tool: string;
      resolved_steps: Array<Record<string, unknown>>;
    };
    expect(payload).toMatchObject({
      recipe_id: 'literature_landscape',
      phase: 'prework',
      entry_tool: 'literature_workflows.resolve',
    });
    expect(payload.resolved_steps[0]).toMatchObject({
      id: 'seed_search',
      provider: 'openalex',
      tool: 'openalex_search',
    });
    const persistedState = manager.readState();
    expect(persistedState).toMatchObject({
      run_id: 'M-LIT-1',
      workflow_id: 'literature_landscape',
      run_status: 'idle',
      plan_md_path: '.autoresearch/plan.md',
      plan: {
        plan_id: 'M-LIT-1:literature_landscape',
      },
    });
    const persistedSteps = ((persistedState.plan as Record<string, unknown>).steps ?? []) as Record<string, unknown>[];
    expect(persistedSteps[0]).toMatchObject({
      step_id: 'seed_search',
      task: {
        task_id: 'seed_search',
        task_kind: 'literature',
        task_intent: 'discover.seed_search',
        title: 'Seed Search',
        description: 'Run a broad keyword search to seed the landscape',
        depends_on_task_ids: [],
        required_capabilities: ['supports_keyword_search'],
        expected_artifacts: ['seed_search'],
        preconditions: [],
      },
      recovery_notes: '',
      execution: {
        action: 'discover.seed_search',
        tool: 'openalex_search',
        provider: 'openalex',
        depends_on: [],
        required_capabilities: ['supports_keyword_search'],
        degrade_mode: 'fail_closed',
      },
    });
    const planMd = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'plan.md'), 'utf-8');
    expect(planMd).toContain('SSOT: `.autoresearch/state.json#/plan`');
    expect(planMd).toContain('seed_search');
    expect(planMd).toContain('execution_tool: openalex_search');
  });

  it('persists literature gap analysis plans through the canonical autoresearch front door', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli([
      'workflow-plan',
      '--recipe', 'literature_gap_analysis',
      '--phase', 'analyze',
      '--run-id', 'M-LIT-GAP-1',
      '--topic', 'bootstrap amplitudes',
      '--analysis-seed', '1234',
      '--recid', '1234',
      '--recid', '5678',
      '--available-tool', 'inspire_search',
      '--available-tool', 'inspire_topic_analysis',
      '--available-tool', 'inspire_critical_analysis',
      '--available-tool', 'inspire_network_analysis',
      '--available-tool', 'inspire_find_connections',
    ], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join('')) as {
      recipe_id: string;
      phase?: string;
      entry_tool: string;
      resolved_steps: Array<Record<string, unknown>>;
    };
    expect(payload).toMatchObject({
      recipe_id: 'literature_gap_analysis',
      phase: 'analyze',
      entry_tool: 'literature_workflows.resolve',
    });
    expect(payload.resolved_steps).toHaveLength(4);
    expect(payload.resolved_steps[0]).toMatchObject({
      id: 'topic_scan',
      provider: 'inspire',
      tool: 'inspire_topic_analysis',
    });
    expect(payload.resolved_steps[3]).toMatchObject({
      id: 'connection_scan',
      provider: 'inspire',
      tool: 'inspire_find_connections',
    });
    const persistedState = manager.readState();
    expect(persistedState).toMatchObject({
      run_id: 'M-LIT-GAP-1',
      workflow_id: 'literature_gap_analysis',
      run_status: 'idle',
      plan_md_path: '.autoresearch/plan.md',
      plan: {
        plan_id: 'M-LIT-GAP-1:literature_gap_analysis',
      },
    });
    const persistedSteps = ((persistedState.plan as Record<string, unknown>).steps ?? []) as Record<string, unknown>[];
    expect(persistedSteps[0]).toMatchObject({
      step_id: 'topic_scan',
      task: {
        task_id: 'topic_scan',
        task_kind: 'literature',
        task_intent: 'analyze.topic_evolution',
        title: 'Topic Scan',
        description: 'Summarize trends and identify underexplored subtopics',
        depends_on_task_ids: ['seed_search'],
        required_capabilities: ['analysis.topic_evolution'],
        expected_artifacts: ['topic_analysis'],
        preconditions: [],
      },
      execution: {
        action: 'analyze.topic_evolution',
        tool: 'inspire_topic_analysis',
        provider: 'inspire',
      },
    });
    expect(persistedSteps[1]).toMatchObject({
      step_id: 'critical_analysis',
      task: {
        task_kind: 'review',
      },
      execution: {
        provider: 'inspire',
        tool: 'inspire_critical_analysis',
      },
    });
    expect(persistedSteps[2]).toMatchObject({
      step_id: 'citation_network',
      task: {
        task_kind: 'finding',
      },
    });
    expect(persistedSteps[3]).toMatchObject({
      step_id: 'connection_scan',
      task: {
        task_kind: 'finding',
      },
    });
    const planMd = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'plan.md'), 'utf-8');
    expect(planMd).toContain('topic_scan');
    expect(planMd).toContain('connection_scan');
    expect(planMd).toContain('execution_tool: inspire_topic_analysis');
  });

  it('persists literature gap analysis plans even when connection_scan starts from an empty recid set', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli([
      'workflow-plan',
      '--recipe', 'literature_gap_analysis',
      '--phase', 'analyze',
      '--run-id', 'M-LIT-GAP-EMPTY-1',
      '--topic', 'bootstrap amplitudes',
      '--analysis-seed', '1234',
      '--available-tool', 'inspire_topic_analysis',
      '--available-tool', 'inspire_critical_analysis',
      '--available-tool', 'inspire_network_analysis',
      '--available-tool', 'inspire_find_connections',
    ], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join('')) as {
      recipe_id: string;
      phase?: string;
      resolved_steps: Array<Record<string, unknown>>;
    };
    expect(payload).toMatchObject({
      recipe_id: 'literature_gap_analysis',
      phase: 'analyze',
    });
    expect(payload.resolved_steps[3]).toMatchObject({
      id: 'connection_scan',
      params: {
        recids: [],
      },
    });

    const persistedSteps = (((manager.readState().plan as Record<string, unknown>).steps) ?? []) as Record<string, unknown>[];
    expect(persistedSteps[3]).toMatchObject({
      step_id: 'connection_scan',
      execution: {
        tool: 'inspire_find_connections',
        params: {
          recids: [],
        },
      },
    });
  });

  it('keeps task_intent provider-neutral when a recipe step has no explicit action', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'workflow-plan',
      '--recipe', 'review_cycle',
      '--run-id', 'M-REVIEW-1',
      '--recid', '1234',
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      recipe_id: 'review_cycle',
      entry_tool: 'inspire_critical_analysis',
    });
    const persistedSteps = (((manager.readState().plan as Record<string, unknown>).steps) ?? []) as Record<string, unknown>[];
    expect(persistedSteps[0]).toMatchObject({
      step_id: 'critical_review',
      task: {
        task_id: 'critical_review',
        task_kind: 'review',
        task_intent: 'workflow_step.critical_review',
        preconditions: [],
      },
      execution: {
        tool: 'inspire_critical_analysis',
      },
    });
    expect(persistedSteps[1]).toMatchObject({
      step_id: 'render_latex',
      task: {
        task_kind: 'draft_update',
      },
    });
    expect(persistedSteps[2]).toMatchObject({
      step_id: 'export_project',
      task: {
        task_kind: 'draft_update',
      },
    });
  });

  it('keeps landscape provenance and network task kinds sourced from recipe authority', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'workflow-plan',
      '--recipe', 'literature_landscape',
      '--phase', 'prework',
      '--run-id', 'M-LIT-2',
      '--query', 'bootstrap amplitudes',
      '--topic', 'bootstrap amplitudes',
      '--seed-recid', '1234',
      '--preferred-provider', 'openalex',
      '--available-tool', 'openalex_search',
      '--available-tool', 'inspire_topic_analysis',
      '--available-tool', 'inspire_network_analysis',
      '--available-tool', 'inspire_trace_original_source',
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      recipe_id: 'literature_landscape',
      phase: 'prework',
    });
    const persistedSteps = (((manager.readState().plan as Record<string, unknown>).steps) ?? []) as Record<string, unknown>[];
    expect(persistedSteps[2]).toMatchObject({
      step_id: 'citation_network',
      task: {
        task_kind: 'finding',
      },
    });
    expect(persistedSteps[3]).toMatchObject({
      step_id: 'source_trace',
      task: {
        task_kind: 'evidence_search',
      },
    });
  });

  it('fails closed when workflow-plan targets an uninitialized project root', async () => {
    const projectRoot = makeTempProjectRoot();
    const { io } = makeIo(projectRoot);

    await expect(runCli([
      'workflow-plan',
      '--recipe', 'literature_landscape',
      '--query', 'bootstrap amplitudes',
    ], io)).rejects.toThrow(`project root is not initialized: ${projectRoot}; run autoresearch init first`);
  });

  it('rejects workflow-plan replacement while a run is active', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = 'M-ACTIVE-1';
    state.workflow_id = 'ingest';
    state.run_status = 'running';
    manager.saveState(state);
    const { io } = makeIo(projectRoot);

    await expect(runCli([
      'workflow-plan',
      '--recipe', 'literature_landscape',
      '--query', 'bootstrap amplitudes',
    ], io)).rejects.toThrow('cannot replace workflow plan while run_status=running; finish or reset the current run first');
  });

  it('derives a stable fallback run_id when --run-id is omitted', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'workflow-plan',
      '--recipe', 'literature_landscape',
      '--phase', 'prework',
      '--query', 'bootstrap amplitudes',
      '--topic', 'bootstrap amplitudes',
      '--seed-recid', '1234',
      '--preferred-provider', 'openalex',
      '--available-tool', 'openalex_search',
      '--available-tool', 'inspire_topic_analysis',
      '--available-tool', 'inspire_network_analysis',
      '--available-tool', 'inspire_trace_original_source',
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      recipe_id: 'literature_landscape',
      phase: 'prework',
    });
    expect(manager.readState()).toMatchObject({
      run_id: 'literature_landscape-prework',
      plan: {
        plan_id: 'literature_landscape-prework:literature_landscape',
      },
    });
  });

  it('shows JSON status for the nearest project root', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M1';
    state.workflow_id = 'ingest';
    manager.saveState(state);

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      run_id: 'M1',
      run_status: 'idle',
      workflow_id: 'ingest',
    });
  });

  it('rebuilds plan view from state when derived plan.md is missing without faking current_step', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-PLAN-1';
    state.workflow_id = 'review_cycle';
    state.run_status = 'idle';
    state.current_step = null;
    state.plan = {
      schema_version: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      plan_id: 'M-PLAN-1:review_cycle',
      run_id: 'M-PLAN-1',
      workflow_id: 'review_cycle',
      current_step_id: 'export_project',
      steps: [
        {
          step_id: 'critical_review',
          description: 'Critical review',
          status: 'completed',
          expected_approvals: [],
          expected_outputs: ['critical_analysis'],
          recovery_notes: '',
        },
        {
          step_id: 'export_project',
          description: 'Export project',
          status: 'pending',
          expected_approvals: [],
          expected_outputs: ['research_pack'],
          recovery_notes: '',
        },
      ],
    };
    manager.saveState(state);
    fs.unlinkSync(path.join(projectRoot, '.autoresearch', 'plan.md'));

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join(''));
    expect(payload).toMatchObject({
      run_id: 'M-PLAN-1',
      current_step: null,
      resume_context: {
        status_command: 'autoresearch status --json',
        current_run_id: 'M-PLAN-1',
        run_status: 'idle',
        recommended_files: expect.arrayContaining(['AGENTS.md', 'project_charter.md', 'research_plan.md', 'research_contract.md']),
      },
      plan_view: {
        plan_current_step_id: 'export_project',
        step_count: 2,
      },
      plan_view_warning: {
        code: 'PLAN_VIEW_REBUILT_FROM_STATE',
      },
      recovery_context: {
        status_commands: {
          canonical: 'autoresearch status --json',
          project_local_fallback: null,
        },
        current_run: {
          run_id: 'M-PLAN-1',
          run_status: 'idle',
          source: 'state',
        },
        plan_focus: {
          step_id: 'export_project',
          status: 'pending',
          source: 'state.plan',
        },
      },
    });
    expect(payload.recovery_context.recommended_files).not.toContain('research_notebook.md');
    expect(payload.resume_context.recommended_files).not.toContain('research_notebook.md');
  });

  it('reconstructs recovery_context from legacy state, plan.md, and ledger.jsonl without changing resume_context', async () => {
    const projectRoot = makeTempProjectRoot();
    fs.mkdirSync(path.join(projectRoot, '.autoresearch'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.autoresearch', 'state.json'),
      JSON.stringify({
        schema_version: 1,
        run_id: 'M-LEGACY-1',
        workflow_id: 'legacy_review',
        current_step: null,
        notes: 'legacy reconnect note',
      }, null, 2) + '\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectRoot, '.autoresearch', 'plan.md'),
      [
        '# Plan (derived view)',
        '',
        '- Run: M-LEGACY-1',
        '- Workflow: legacy_review',
        '',
        'SSOT: `.autoresearch/state.json#/plan`',
        '',
        '## Steps',
        '',
        '1. [completed] gather_sources — Gather sources',
        '   - expected_approvals: -',
        '2. [pending] export_project — Export project',
        '   - expected_approvals: -',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectRoot, '.autoresearch', 'ledger.jsonl'),
      [
        JSON.stringify({
          ts: '2026-04-15T00:00:00Z',
          event_type: 'initialized',
          run_id: 'M-LEGACY-1',
          workflow_id: 'legacy_review',
          details: {},
        }),
        JSON.stringify({
          ts: '2026-04-15T00:05:00Z',
          event_type: 'run_started',
          run_id: 'M-LEGACY-1',
          workflow_id: 'legacy_review',
          details: {},
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join(''));
    expect(payload.resume_context).toMatchObject({
      status_command: 'autoresearch status --json',
      current_run_id: 'M-LEGACY-1',
    });
    expect(payload.recovery_context).toMatchObject({
      status_commands: {
        canonical: 'autoresearch status --json',
        project_local_fallback: null,
      },
      control_files: {
        state_json: { path: '.autoresearch/state.json', exists: true },
        plan_md: { path: '.autoresearch/plan.md', exists: true },
        ledger_jsonl: { path: '.autoresearch/ledger.jsonl', exists: true },
        project_local_launcher: { path: '.autoresearch/bin/autoresearch', exists: false },
      },
      current_run: {
        run_id: 'M-LEGACY-1',
        workflow_id: 'legacy_review',
        run_status: 'running',
        notes: 'legacy reconnect note',
        source: 'state+ledger',
      },
      plan_focus: {
        step_id: 'export_project',
        status: 'pending',
        description: 'Export project',
        source: 'plan.md',
      },
      latest_ledger_event: {
        event_type: 'run_started',
        timestamp_utc: '2026-04-15T00:05:00Z',
        derived_run_status: 'running',
        run_id: 'M-LEGACY-1',
      },
    });
    expect(payload.recovery_context.derivation_warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RECOVERY_RUN_STATUS_FROM_LEDGER' }),
      expect.objectContaining({ code: 'RECOVERY_PLAN_FOCUS_FROM_PLAN_MD' }),
    ]));
  });

  it('shows current_run_workflow_outputs in JSON status when bounded workflow results already exist', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-OUT-1';
    state.workflow_id = 'literature_gap_analysis';
    state.run_status = 'completed';
    state.workflow_outputs = {
      topic_analysis: {
        step_id: 'topic_scan',
        tool: 'inspire_topic_analysis',
        runtime_status: 'completed',
        artifact_uri: 'hep://runs/M-OUT-1/artifact/topic_analysis.json',
        additional_artifact_uris: [],
        summary_text: 'Topic timeline completed successfully.',
        payload: { topic: 'bootstrap amplitudes' },
        payload_truncated: false,
      },
      connection_scan: {
        step_id: 'connection_scan',
        tool: 'inspire_find_connections',
        runtime_status: 'skipped' as never,
        artifact_uri: 'orch://runs/M-OUT-1/artifact/workflow_steps/connection_scan.json',
        additional_artifact_uris: [],
        summary_text: 'skipped because no_input_recids',
        payload: { status: 'skipped', reason: 'no_input_recids' },
        payload_truncated: false,
      },
    } as any;
    manager.saveState(state);

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      current_run_workflow_outputs: {
        topic_analysis: {
          status: 'completed',
          artifact_uri: 'hep://runs/M-OUT-1/artifact/topic_analysis.json',
          summary: 'Topic timeline completed successfully.',
        },
        connection_scan: {
          status: 'skipped',
          artifact_uri: 'orch://runs/M-OUT-1/artifact/workflow_steps/connection_scan.json',
          summary: 'skipped because no_input_recids',
        },
      },
      resume_context: {
        status_command: 'autoresearch status --json',
        current_run_id: 'M-OUT-1',
        run_status: 'completed',
        curated_workflow_output_keys: ['topic_analysis', 'critical_analysis', 'network_analysis', 'connection_scan'],
        workflow_output_keys: expect.arrayContaining(['topic_analysis', 'connection_scan']),
      },
      recovery_context: {
        current_run: {
          run_id: 'M-OUT-1',
          run_status: 'completed',
          source: 'state',
        },
      },
    });
  });

  it('includes research_notebook.md in recommended_files only when the notebook has substantive content', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-NOTE-1';
    state.run_status = 'idle';
    manager.saveState(state);

    fs.writeFileSync(
      path.join(projectRoot, 'research_notebook.md'),
      [
        '# research_notebook.md',
        '',
        'Project: Demo',
        'Last updated: 2026-04-16',
        '',
        '## Goal',
        '',
        '- One-sentence objective:',
        '- Why it matters:',
        '',
        '## Results',
        '',
        '- Main takeaways:',
        '- The bootstrap scan already falsified the small-coupling prior.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join(''));
    expect(payload.resume_context.recommended_files).toContain('research_notebook.md');
    expect(payload.recovery_context.recommended_files).toContain('research_notebook.md');
  });

  it('keeps research_notebook.md out of recommended_files when only the scaffold notebook skeleton exists', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-NOTE-0';
    state.run_status = 'idle';
    manager.saveState(state);

    fs.writeFileSync(
      path.join(projectRoot, 'research_notebook.md'),
      [
        '# research_notebook.md',
        '',
        'Project: Demo',
        'Last updated: 2026-04-16',
        '',
        'This file is the human-facing research notebook.',
        'Write narrative derivations, interpretation, figures, and references here.',
        'Keep machine-stable gate structure in [research_contract.md](research_contract.md).',
        '',
        '## Goal',
        '',
        '- One-sentence objective:',
        '- Why it matters:',
        '',
        '## Derivation Notes',
        '',
        '- State assumptions explicitly.',
        '- Keep the reasoning readable; move machine-checkable pointers to [research_contract.md](research_contract.md).',
        '',
        '## Results',
        '',
        '- Key figures/tables:',
        '- Main takeaways:',
        '',
        '## Open Questions',
        '',
        '- What is still uncertain?',
        '- What would falsify the current direction?',
        '',
        '## References',
        '',
        '- Add stable links and local note pointers here as the project grows.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join(''));
    expect(payload.resume_context.recommended_files).not.toContain('research_notebook.md');
    expect(payload.recovery_context.recommended_files).not.toContain('research_notebook.md');
  });

  it('reports a clean project_surface_drift block for a minimal root without stale optional surfaces', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-DRIFT-CLEAN';
    state.run_status = 'idle';
    manager.saveState(state);
    writeProjectSurfaceGuidanceFiles(projectRoot);

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      project_surface_drift: {
        status: 'clean',
        canonical_scaffold_variant: 'minimal',
        warning_count: 0,
        issues: [],
      },
      project_surface_drift_error: null,
    });
  });

  it('warns when a legacy .mcp.template.json exists without an active .mcp.json', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-DRIFT-MCP';
    state.run_status = 'idle';
    manager.saveState(state);
    writeProjectSurfaceGuidanceFiles(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.mcp.template.json'), '{\"mcpServers\":{}}\n', 'utf-8');

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      project_surface_drift: {
        status: 'warning_only',
        warning_count: 1,
        issues: [
          {
            code: 'LEGACY_MCP_TEMPLATE_NO_ACTIVE_CONFIG',
            path: '.mcp.template.json',
          },
        ],
      },
    });
  });

  it('warns when a legacy root plan schema appears in a minimal-style project root', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-DRIFT-SCHEMA';
    state.run_status = 'idle';
    manager.saveState(state);
    writeProjectSurfaceGuidanceFiles(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'specs', 'plan.schema.json'), '{}\n', 'utf-8');

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      project_surface_drift: {
        status: 'warning_only',
        warning_count: 1,
        issues: [
          {
            code: 'LEGACY_PLAN_SCHEMA_IN_MINIMAL_ROOT',
            path: 'specs/plan.schema.json',
          },
        ],
      },
    });
  });

  it('warns on missing optional host surfaces only while guidance still mentions them', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-DRIFT-HOST';
    state.run_status = 'idle';
    manager.saveState(state);
    writeProjectSurfaceGuidanceFiles(projectRoot, { includeOptionalHostMentions: true });

    const first = makeIo(projectRoot);
    const firstCode = await runCli(['status', '--json'], first.io);
    expect(firstCode).toBe(0);
    expect(JSON.parse(first.stdout.join(''))).toMatchObject({
      project_surface_drift: {
        status: 'warning_only',
        warning_count: 1,
        issues: [
          {
            code: 'OPTIONAL_HOST_SURFACE_MENTION_MISSING',
            evidence: {
              missing_paths: ['prompts/', 'team/', 'research_team_config.json'],
            },
          },
        ],
      },
    });

    fs.mkdirSync(path.join(projectRoot, 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'team'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'research_team_config.json'), '{}\n', 'utf-8');

    const second = makeIo(projectRoot);
    const secondCode = await runCli(['status', '--json'], second.io);
    expect(secondCode).toBe(0);
    expect(JSON.parse(second.stdout.join(''))).toMatchObject({
      project_surface_drift: {
        status: 'clean',
        warning_count: 0,
        issues: [],
      },
    });
  });

  it('reports research_contract template residue as warning-only drift', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-DRIFT-CONTRACT';
    state.run_status = 'idle';
    manager.saveState(state);
    writeProjectSurfaceGuidanceFiles(projectRoot, { includeResearchContractResidue: true });
    fs.mkdirSync(path.join(projectRoot, 'team'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'research_team_config.json'), '{}\n', 'utf-8');

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      project_surface_drift: {
        status: 'warning_only',
        warning_count: 1,
        issues: [
          {
            code: 'RESEARCH_CONTRACT_TEMPLATE_RESIDUE',
            path: 'research_contract.md',
          },
        ],
      },
    });
  });

  it('reports current_run_workflow_outputs_error when a curated workflow output is malformed', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-BAD-1';
    state.run_status = 'running';
    state.workflow_outputs = {
      topic_analysis: {
        step_id: 'topic_scan',
        tool: 'inspire_topic_analysis',
        artifact_uri: 'hep://runs/M-BAD-1/artifact/topic_analysis.json',
        summary_text: 'missing runtime status',
      },
    } as any;
    manager.saveState(state);

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      current_run_workflow_outputs: null,
      current_run_workflow_outputs_error: {
        code: 'CURRENT_RUN_WORKFLOW_OUTPUTS_PARTIAL',
        curated_output_keys: ['topic_analysis', 'critical_analysis', 'network_analysis', 'connection_scan'],
        output_errors: [
          {
            code: 'WORKFLOW_OUTPUT_INVALID',
            output_key: 'topic_analysis',
          },
        ],
      },
    });
  });

  it('prints a compact recent digest in non-JSON status output', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M-CURRENT';
    state.workflow_id = 'computation';
    state.run_status = 'running';
    manager.saveState(state);

    manager.appendLedger('approval_approved', {
      run_id: 'M-FINAL',
      details: { category: 'A5' },
    });
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'M-FINAL'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'artifacts', 'runs', 'M-FINAL', 'final_conclusions_v1.json'),
      JSON.stringify({
        approval_id: 'A5-0001',
        summary: 'A5 final conclusions were approved for M-FINAL',
        created_at: '2026-04-15T00:00:00Z',
      }, null, 2) + '\n',
      'utf-8',
    );

    manager.appendLedger('status_failed', {
      run_id: 'M-REPAIR',
      details: {},
    });
    fs.mkdirSync(path.join(projectRoot, 'artifacts', 'runs', 'M-REPAIR'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'artifacts', 'runs', 'M-REPAIR', 'mutation_proposal_repair_v1.json'),
      JSON.stringify({
        schema_version: 1,
        proposal_id: 'mp-repair-1',
        mutation_type: 'repair',
        gene_id: 'gene:repair:test',
        gate_level: 'A1',
        status: 'proposed',
        run_id: 'M-REPAIR',
        signals: ['boundary:compute_result', 'execution_status:failed'],
        created_at: '2026-04-15T00:00:01Z',
      }, null, 2) + '\n',
      'utf-8',
    );

    manager.appendLedger('run_started', {
      run_id: 'M-TEAM',
      workflow_id: 'computation',
      details: { source: 'status-text-test' },
    });
    const teamState = createTeamExecutionState({
      workspace_id: 'ws-M-TEAM',
      coordination_policy: 'supervised_delegate',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-1',
        task_kind: 'compute',
        handoff_kind: 'compute',
      },
      permissions: TEAM_PERMISSIONS,
    }, 'M-TEAM');
    teamState.delegate_assignments[0]!.status = 'running';
    new TeamExecutionStateManager(projectRoot).save(teamState);

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status'], io);

    expect(code).toBe(0);
    const text = stdout.join('');
    expect(text).toContain('recent_digest:');
    expect(text).toContain('latest_final_conclusions: M-FINAL');
    expect(text).toContain('latest_repair_proposal: M-REPAIR');
    expect(text).toContain('active_team_run: M-TEAM status=running');
  });

  it('approves a pending gate without requiring the operator to pass a SHA', async () => {
    const { approvalId, projectRoot } = makeAwaitingApprovalState();
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli(['approve', approvalId, '--note', 'ship it'], io);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain(`approved: ${approvalId}`);
    const state = new StateManager(projectRoot).readState();
    expect(state.run_status).toBe('running');
    expect(state.pending_approval).toBeNull();
    expect(state.approval_history).toHaveLength(1);
  });

  it('preserves pause/resume state-manager semantics on the canonical lifecycle surface', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = 'M-PAUSE-1';
    state.workflow_id = 'ingest';
    state.run_status = 'completed';
    manager.saveState(state);

    const pausedIo = makeIo(projectRoot);
    await expect(runCli(['pause', '--note', 'hold'], pausedIo.io)).resolves.toBe(0);
    const paused = manager.readState();
    expect(paused.run_status).toBe('paused');
    expect(paused.paused_from_status).toBe('completed');
    expect(fs.existsSync(path.join(projectRoot, '.pause'))).toBe(true);

    const resumeIo = makeIo(projectRoot);
    await expect(runCli(['resume', '--note', 'go'], resumeIo.io)).resolves.toBe(0);
    const resumed = manager.readState();
    expect(resumed.run_status).toBe('completed');
    expect(resumed.paused_from_status).toBeUndefined();
    expect(resumed.notes).toBe('go');
    expect(fs.existsSync(path.join(projectRoot, '.pause'))).toBe(false);
  });

  it('supports resume --force on terminal states', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = 'M-RESUME-FORCE';
    state.workflow_id = 'ingest';
    state.run_status = 'completed';
    manager.saveState(state);

    const { io } = makeIo(projectRoot);
    await expect(runCli(['resume'], io)).rejects.toThrow('cannot resume from status=completed');
    await expect(runCli(['resume', '--force', '--note', 'force resume'], io)).resolves.toBe(0);

    const resumed = manager.readState();
    expect(resumed.run_status).toBe('running');
    expect(resumed.notes).toBe('force resume');
  });

  it('fails closed when run workflow_id conflicts with the persisted workflow plan', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = 'M-RUN-1';
    state.workflow_id = 'literature_landscape';
    state.plan = {
      schema_version: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      plan_id: 'M-RUN-1:literature_landscape',
      run_id: 'M-RUN-1',
      workflow_id: 'literature_landscape',
      current_step_id: 'seed_search',
      steps: [],
      notes: '',
    };
    manager.saveState(state);
    const { io } = makeIo(projectRoot);
    await expect(
      runCli(['run', '--workflow-id', 'review_cycle', '--run-id', 'M-RUN-1'], io),
    ).rejects.toThrow('run workflow_id mismatch: state.workflow_id=literature_landscape but got review_cycle');
  });

  it('fails closed when run targets an uninitialized project root', async () => {
    const projectRoot = makeTempProjectRoot();
    const { io } = makeIo(projectRoot);
    await expect(
      runCli(['run', '--workflow-id', 'computation', '--run-id', 'M-RUN-UNINIT'], io),
    ).rejects.toThrow(`project root is not initialized: ${projectRoot}; run autoresearch init first`);
  });

  it('dry-runs the next persisted workflow-plan step through the canonical run front door', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    await runCli([
      'workflow-plan',
      '--recipe', 'literature_gap_analysis',
      '--run-id', 'M-REVIEW-DRY',
      '--query', 'bootstrap amplitudes',
      '--topic', 'bootstrap amplitudes',
      '--analysis-seed', '1234',
      '--recid', '1234',
      '--recid', '5678',
      '--available-tool', 'inspire_search',
      '--available-tool', 'inspire_topic_analysis',
      '--available-tool', 'inspire_critical_analysis',
      '--available-tool', 'inspire_network_analysis',
      '--available-tool', 'inspire_find_connections',
    ], makeIo(projectRoot).io);

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli([
      'run',
      '--workflow-id', 'literature_gap_analysis',
      '--run-id', 'M-REVIEW-DRY',
      '--dry-run',
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'dry_run',
      dry_run: true,
      workflow_id: 'literature_gap_analysis',
      next_step_id: 'seed_search',
      step: {
        step_id: 'seed_search',
        execution: {
          tool: 'inspire_search',
        },
      },
    });
  });

  it('requests A3 approval when computation run is unsatisfied', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const runId = 'M-RUN-A3';
    const { runDir, manifestPath } = createComputationFixture(projectRoot, runId);
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A3',
      run_id: runId,
    });
    const state = manager.readState();
    expect(state.run_status).toBe('awaiting_approval');
    expect(state.pending_approval?.category).toBe('A3');
    expect(state.workflow_id).toBe('computation');
    expect(state.run_id).toBe(runId);
  });

  it('replays the same pending A3 approval when rerunning the active computation request', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const runId = 'M-RUN-A3-REPLAY';
    const { runDir, manifestPath } = createComputationFixture(projectRoot, runId);
    const first = makeIo(projectRoot);

    const firstCode = await runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], first.io);

    expect(firstCode).toBe(0);
    const firstResult = JSON.parse(first.stdout.join(''));
    expect(firstResult).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A3',
      run_id: runId,
    });

    const second = makeIo(projectRoot);
    const secondCode = await runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], second.io);

    expect(secondCode).toBe(0);
    const secondResult = JSON.parse(second.stdout.join(''));
    expect(secondResult).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A3',
      run_id: runId,
      approval_id: firstResult.approval_id,
      packet_path: firstResult.packet_path,
      packet_json_path: firstResult.packet_json_path,
    });
    const state = manager.readState();
    expect(state.run_status).toBe('awaiting_approval');
    expect(state.pending_approval?.approval_id).toBe(firstResult.approval_id);
    expect(state.approval_seq.A3).toBe(1);
  });

  it('clears stale gate satisfaction before starting a fresh computation run', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const stale = manager.readState();
    stale.run_id = 'M-OLD';
    stale.workflow_id = 'computation';
    stale.run_status = 'completed';
    stale.gate_satisfied.A3 = 'A3-OLD';
    stale.approval_history.push({
      ts: '2026-01-01T00:00:00Z',
      approval_id: 'A3-OLD',
      category: 'A3',
      decision: 'approved',
      note: 'stale',
    });
    manager.saveState(stale);
    const runId = 'M-RUN-RESET-A3';
    const { runDir, manifestPath } = createComputationFixture(projectRoot, runId);
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A3',
      run_id: runId,
    });
    const state = manager.readState();
    expect(state.run_status).toBe('awaiting_approval');
    expect(state.gate_satisfied.A3).toBeUndefined();
    expect(state.approval_history).toHaveLength(0);
  });

  it('executes computation manifests only when A3 is satisfied for the active run', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const runId = 'M-RUN-OK';
    const state = manager.readState();
    state.run_id = runId;
    state.workflow_id = 'computation';
    state.run_status = 'running';
    state.gate_satisfied.A3 = 'A3-0001';
    manager.saveState(state);
    const { runDir, manifestPath } = createComputationFixture(projectRoot, runId);
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'completed',
      ok: true,
      run_id: runId,
    });
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'ok.txt'))).toBe(true);
    expect(manager.readState()).toMatchObject({
      run_id: runId,
      workflow_id: 'computation',
      run_status: 'completed',
    });
  });
});
