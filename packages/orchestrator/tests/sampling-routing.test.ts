import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LedgerWriter } from '../src/ledger-writer.js';
import { loadSamplingRoutingConfig, resolveSamplingRoute } from '../src/routing/sampling-loader.js';
import { executeSamplingRequest } from '../src/sampling-handler.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sampling-'));
}

describe('sampling routing', () => {
  it('resolves prompt-version and module overrides before risk/cost fallbacks', () => {
    const config = loadSamplingRoutingConfig({
      version: 1,
      default_route: 'balanced',
      routes: {
        balanced: { backend: 'anthropic', model: 'claude-sonnet-4-6', max_tokens: 1200 },
        cheap: { backend: 'anthropic', model: 'claude-haiku-4-5', max_tokens: 600 },
        careful: { backend: 'anthropic', model: 'claude-opus-4-6', max_tokens: 1800 },
      },
      selectors: {
        modules: { sem02_claim_extraction: 'cheap' },
        module_prompt_versions: { 'sem04_theoretical_conflicts@v2': 'careful' },
        risk_levels: { read: 'balanced' },
        cost_classes: { high: 'careful' },
      },
    }, 'balanced');

    const extractionRoute = resolveSamplingRoute(config, {
      module: 'sem02_claim_extraction',
      tool: 'inspire_grade_evidence',
      prompt_version: 'sem02_claim_extraction_v1',
      risk_level: 'read',
      cost_class: 'high',
    });
    expect(extractionRoute.route_key).toBe('cheap');
    expect(extractionRoute.selector.kind).toBe('module');

    const theoreticalRoute = resolveSamplingRoute(config, {
      module: 'sem04_theoretical_conflicts',
      tool: 'inspire_theoretical_conflicts',
      prompt_version: 'v2',
      risk_level: 'read',
      cost_class: 'high',
    });
    expect(theoreticalRoute.route_key).toBe('careful');
    expect(theoreticalRoute.selector.kind).toBe('module_prompt_version');
  });

  it('rejects malformed selectors and unknown fallback routes', () => {
    expect(() => loadSamplingRoutingConfig({
      version: 1,
      default_route: 'balanced',
      routes: {
        balanced: { backend: 'anthropic', model: 'claude-sonnet-4-6', fallbacks: ['missing'] },
      },
      selectors: {},
    }, 'balanced')).toThrow(/unknown fallback/i);

    expect(() => resolveSamplingRoute(loadSamplingRoutingConfig({
      version: 1,
      default_route: 'balanced',
      routes: {
        balanced: { backend: 'anthropic', model: 'claude-sonnet-4-6' },
      },
      selectors: {},
    }, 'balanced'), {
      module: 'sem02_claim_extraction',
      tool: 'inspire_grade_evidence',
      prompt_version: 'v1',
      risk_level: 'read',
    } as never)).toThrow(/cost_class/i);
  });

  it('records fallback attempts and chosen route in audit surface', async () => {
    const tmpDir = makeTmpDir();
    const ledger = new LedgerWriter(tmpDir);
    const config = loadSamplingRoutingConfig({
      version: 1,
      default_route: 'balanced',
      routes: {
        balanced: {
          backend: 'anthropic',
          model: 'claude-sonnet-4-6',
          max_tokens: 900,
          fallbacks: ['careful'],
        },
        careful: { backend: 'anthropic', model: 'claude-opus-4-6', max_tokens: 1200 },
      },
      selectors: {
        tools: { inspire_theoretical_conflicts: 'balanced' },
        cost_classes: { high: 'balanced' },
      },
    }, 'balanced');

    const createMessage = vi.fn()
      .mockRejectedValueOnce(new Error('primary backend unavailable'))
      .mockResolvedValueOnce({
        model: 'claude-opus-4-6',
        role: 'assistant',
        content: [{ type: 'text', text: '{"ok":true}' }],
        stopReason: 'endTurn',
      });

    const executed = await executeSamplingRequest({
      request: {
        messages: [{ role: 'user', content: { type: 'text', text: 'Please adjudicate.' } }],
        maxTokens: 800,
        metadata: {
          module: 'sem04_theoretical_conflicts',
          tool: 'inspire_theoretical_conflicts',
          prompt_version: 'v2',
          risk_level: 'read',
          cost_class: 'high',
        },
      },
      routingConfig: config,
      backendFactory: () => ({ createMessage }),
      ledger,
    });

    expect(executed.audit.route.route_key).toBe('balanced');
    expect(executed.audit.attempts.map(attempt => attempt.route_key)).toEqual(['balanced', 'careful']);
    expect(executed.result.model).toBe('claude-opus-4-6');

    const events = ledger.tail(10).filter(event => event.event_type.startsWith('mcp_client.sampling_'));
    expect(events.some(event => event.event_type === 'mcp_client.sampling_route_resolved')).toBe(true);
    expect(events.some(event => event.event_type === 'mcp_client.sampling_attempt_failed')).toBe(true);
    expect(events.some(event => event.event_type === 'mcp_client.sampling_completed')).toBe(true);
  });

  it('fails after exhausting every fallback attempt and records terminal audit', async () => {
    const tmpDir = makeTmpDir();
    const ledger = new LedgerWriter(tmpDir);
    const config = loadSamplingRoutingConfig({
      version: 1,
      default_route: 'balanced',
      routes: {
        balanced: { backend: 'anthropic', model: 'claude-sonnet-4-6', fallbacks: ['careful'] },
        careful: { backend: 'anthropic', model: 'claude-opus-4-6' },
      },
      selectors: { tools: { inspire_theoretical_conflicts: 'balanced' } },
    }, 'balanced');

    const createMessage = vi.fn().mockRejectedValue(new Error('all backends unavailable'));

    await expect(executeSamplingRequest({
      request: {
        messages: [{ role: 'user', content: { type: 'text', text: 'Please adjudicate.' } }],
        metadata: {
          module: 'sem04_theoretical_conflicts',
          tool: 'inspire_theoretical_conflicts',
          prompt_version: 'v2',
          risk_level: 'read',
          cost_class: 'high',
        },
      },
      routingConfig: config,
      backendFactory: () => ({ createMessage }),
      ledger,
    })).rejects.toThrow('Sampling request failed after 2 attempt(s)');

    const events = ledger.tail(10).filter(event => event.event_type.startsWith('mcp_client.sampling_'));
    expect(events.filter(event => event.event_type === 'mcp_client.sampling_attempt_failed')).toHaveLength(2);
    expect(events.some(event => event.event_type === 'mcp_client.sampling_failed')).toBe(true);
  });
});
