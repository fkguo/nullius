import { describe, it, expect } from 'vitest';
import {
  RUN_STATES,
  RUN_STEP_STATES,
  TERMINAL_RUN_STATES,
  isTerminalRunState,
  isActiveRunState,
  isTerminalStepState,
  mapLegacyToRunState,
  type RunState,
} from '../run-state.js';

describe('RUN_STATES', () => {
  it('should contain all canonical states', () => {
    expect(Object.keys(RUN_STATES)).toEqual([
      'pending', 'running', 'paused', 'awaiting_approval', 'done', 'failed', 'needs_recovery',
    ]);
  });

  it('values should be snake_case strings matching keys', () => {
    for (const [key, value] of Object.entries(RUN_STATES)) {
      expect(value).toBe(key);
    }
  });
});

describe('TERMINAL_RUN_STATES', () => {
  it('should match SkillBridgeJobEnvelope terminal_statuses', () => {
    expect(TERMINAL_RUN_STATES).toContain('done');
    expect(TERMINAL_RUN_STATES).toContain('failed');
    expect(TERMINAL_RUN_STATES).toHaveLength(2);
  });
});

describe('isTerminalRunState', () => {
  it('should identify terminal states', () => {
    expect(isTerminalRunState('done')).toBe(true);
    expect(isTerminalRunState('failed')).toBe(true);
  });

  it('should not flag non-terminal states', () => {
    expect(isTerminalRunState('pending')).toBe(false);
    expect(isTerminalRunState('running')).toBe(false);
    expect(isTerminalRunState('paused')).toBe(false);
    expect(isTerminalRunState('awaiting_approval')).toBe(false);
    expect(isTerminalRunState('needs_recovery')).toBe(false);
  });
});

describe('isActiveRunState', () => {
  it('should identify active states', () => {
    expect(isActiveRunState('running')).toBe(true);
    expect(isActiveRunState('paused')).toBe(true);
    expect(isActiveRunState('awaiting_approval')).toBe(true);
  });

  it('should not flag inactive states', () => {
    expect(isActiveRunState('pending')).toBe(false);
    expect(isActiveRunState('done')).toBe(false);
    expect(isActiveRunState('failed')).toBe(false);
  });
});

describe('RUN_STEP_STATES', () => {
  it('should contain step-level states', () => {
    expect(Object.keys(RUN_STEP_STATES)).toEqual(['pending', 'in_progress', 'done', 'failed']);
  });
});

describe('isTerminalStepState', () => {
  it('should identify terminal step states', () => {
    expect(isTerminalStepState('done')).toBe(true);
    expect(isTerminalStepState('failed')).toBe(true);
  });

  it('should not flag non-terminal step states', () => {
    expect(isTerminalStepState('pending')).toBe(false);
    expect(isTerminalStepState('in_progress')).toBe(false);
  });
});

describe('mapLegacyToRunState', () => {
  it('should map canonical values to themselves', () => {
    const canonical: RunState[] = ['pending', 'running', 'paused', 'awaiting_approval', 'done', 'failed', 'needs_recovery'];
    for (const state of canonical) {
      expect(mapLegacyToRunState(state)).toBe(state);
    }
  });

  it('should map hep-mcp legacy "created" → "pending"', () => {
    expect(mapLegacyToRunState('created')).toBe('pending');
  });

  it('should map orchestrator legacy', () => {
    expect(mapLegacyToRunState('idle')).toBe('pending');
    expect(mapLegacyToRunState('completed')).toBe('done');
    expect(mapLegacyToRunState('rejected')).toBe('failed');
  });

  it('should map adapter legacy', () => {
    expect(mapLegacyToRunState('NOT_STARTED')).toBe('pending');
    expect(mapLegacyToRunState('RUNNING')).toBe('running');
    expect(mapLegacyToRunState('DONE')).toBe('done');
    expect(mapLegacyToRunState('FAILED')).toBe('failed');
  });

  it('should map plan step legacy', () => {
    expect(mapLegacyToRunState('in_progress')).toBe('running');
    expect(mapLegacyToRunState('blocked')).toBe('awaiting_approval');
    expect(mapLegacyToRunState('skipped')).toBe('done');
  });

  it('should return undefined for unknown values', () => {
    expect(mapLegacyToRunState('unknown')).toBeUndefined();
    expect(mapLegacyToRunState('')).toBeUndefined();
  });
});
