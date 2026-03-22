import { describe, expect, it } from 'vitest';

import {
  ORCH_FLEET_CLAIM,
  ORCH_FLEET_ENQUEUE,
  ORCH_FLEET_RELEASE,
  ORCH_FLEET_STATUS,
  ORCH_FLEET_WORKER_HEARTBEAT,
  ORCH_FLEET_WORKER_POLL,
  ORCH_RUN_EXECUTE_AGENT,
} from '@autoresearch/shared';
import { ORCH_TOOL_SPECS } from '@autoresearch/orchestrator';

import { getToolSpecs } from '../../src/tools/index.js';

describe('shared orchestrator package export boundary', () => {
  it('exports the durable execution tool name from the shared package entrypoint', () => {
    expect(ORCH_RUN_EXECUTE_AGENT).toBe('orch_run_execute_agent');
  });

  it('keeps orchestrator package entrypoint aligned with the shared tool-name seam', () => {
    expect(ORCH_TOOL_SPECS.some(spec => spec.name === ORCH_RUN_EXECUTE_AGENT)).toBe(true);
    expect(ORCH_TOOL_SPECS.some(spec => spec.name === ORCH_FLEET_ENQUEUE)).toBe(true);
    expect(ORCH_TOOL_SPECS.some(spec => spec.name === ORCH_FLEET_CLAIM)).toBe(true);
    expect(ORCH_TOOL_SPECS.some(spec => spec.name === ORCH_FLEET_RELEASE)).toBe(true);
    expect(ORCH_TOOL_SPECS.some(spec => spec.name === ORCH_FLEET_STATUS)).toBe(true);
    expect(ORCH_TOOL_SPECS.some(spec => spec.name === ORCH_FLEET_WORKER_POLL)).toBe(true);
    expect(ORCH_TOOL_SPECS.some(spec => spec.name === ORCH_FLEET_WORKER_HEARTBEAT)).toBe(true);
  });

  it('keeps hep-mcp as a host adapter over the shared/orchestrator authority', () => {
    const spec = getToolSpecs('full').find(item => item.name === ORCH_RUN_EXECUTE_AGENT);
    expect(spec?.riskLevel).toBe('destructive');
    expect(spec?.exposure).toBe('full');
  });

  it('surfaces fleet visibility through the same shared/orchestrator host path', () => {
    const spec = getToolSpecs('full').find(item => item.name === ORCH_FLEET_STATUS);
    expect(spec?.riskLevel).toBe('read');
    expect(spec?.exposure).toBe('full');
  });

  it('surfaces fleet queue mutation tools through the same shared/orchestrator host path', () => {
    for (const name of [ORCH_FLEET_ENQUEUE, ORCH_FLEET_CLAIM, ORCH_FLEET_RELEASE]) {
      const spec = getToolSpecs('full').find(item => item.name === name);
      expect(spec?.riskLevel).toBe('write');
      expect(spec?.exposure).toBe('full');
    }
  });

  it('surfaces fleet worker tools through the same shared/orchestrator host path', () => {
    for (const name of [ORCH_FLEET_WORKER_POLL, ORCH_FLEET_WORKER_HEARTBEAT]) {
      const spec = getToolSpecs('full').find(item => item.name === name);
      expect(spec?.riskLevel).toBe('write');
      expect(spec?.exposure).toBe('full');
    }
  });
});
