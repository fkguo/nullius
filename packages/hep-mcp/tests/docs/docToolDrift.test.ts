import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { FRONT_DOOR_SNIPPETS } from '../../../../scripts/lib/front-door-boundary-authority.mjs';
import {
  FRONT_DOOR_AUTHORITY_MAP_BY_SURFACE,
  FRONT_DOOR_AUTHORITY_SURFACE_IDS,
  getFrontDoorAuthoritySurface,
} from '../../../../scripts/lib/front-door-authority-map.mjs';

type ToolName = string;

function repoRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..');
}

function readText(root: string, relPath: string): string {
  return fs.readFileSync(path.join(root, relPath), 'utf-8');
}

function extractInlineCodeSpans(markdown: string): string[] {
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
    out.push(String(m[1] ?? ''));
  }
  return out;
}

function extractToolLikeTokensFromText(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:hep|inspire|zotero|pdg)_[a-z0-9]+(?:_[a-z0-9]+)*\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(String(m[0] ?? ''));
  }
  return out;
}

function extractOrchToolNamesFromText(text: string): string[] {
  const out: string[] = [];
  const re = /\borch_[a-z0-9]+(?:_[a-z0-9]+)*\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(String(m[0] ?? ''));
  }
  return Array.from(new Set(out));
}

function extractToolNamesFromToolCategories(markdown: string): string[] {
  const names: string[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('-')) continue;
    for (const span of extractInlineCodeSpans(line)) {
      const tokens = extractToolLikeTokensFromText(span);
      names.push(...tokens);
    }
  }
  return Array.from(new Set(names));
}

function extractToolNamesFromMarkdownTableFirstColumn(markdown: string): string[] {
  const names: string[] = [];
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 3) continue;
    const first = cells[1] ?? '';
    const m = first.match(/^`([a-z0-9_]+)`$/);
    if (!m) continue;
    const token = m[1] ?? '';
    if (!token.startsWith('hep_') && !token.startsWith('inspire_') && !token.startsWith('zotero_') && !token.startsWith('pdg_')) continue;
    names.push(token);
  }
  return Array.from(new Set(names));
}

function extractToolNamesFromHeadings(markdown: string): string[] {
  const names: string[] = [];
  const headingRe = /^#{2,6}\s+.*$/gm;
  for (let m = headingRe.exec(markdown); m; m = headingRe.exec(markdown)) {
    const line = String(m[0] ?? '');
    for (const span of extractInlineCodeSpans(line)) {
      const tokens = extractToolLikeTokensFromText(span);
      names.push(...tokens);
    }
  }
  return Array.from(new Set(names));
}

function extractToolNamesFromToolJsonExamples(markdown: string): string[] {
  const names: string[] = [];
  const re = /"tool"\s*:\s*"([a-z0-9_]+)"/g;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
    const token = String(m[1] ?? '');
    if (!token) continue;
    if (!token.startsWith('hep_') && !token.startsWith('inspire_') && !token.startsWith('zotero_') && !token.startsWith('pdg_')) continue;
    names.push(token);
  }
  return Array.from(new Set(names));
}

function extractPdgToolHeadings(markdown: string): string[] {
  const names: string[] = [];
  const re = /^###\s+\d+\)\s+`(pdg_[a-z0-9_]+)`\s*$/gm;
  for (let m = re.exec(markdown); m; m = re.exec(markdown)) {
    names.push(String(m[1] ?? ''));
  }
  return Array.from(new Set(names));
}

function assertAllExist(params: { referenced: ToolName[]; allowed: Set<ToolName>; label: string }): void {
  const missing = params.referenced.filter(name => !params.allowed.has(name)).sort((a, b) => a.localeCompare(b));
  expect(missing, `${params.label}: missing tools: ${missing.join(', ')}`).toEqual([]);
}

function assertContainsAll(params: { text: string; snippets: string[]; label: string }): void {
  const missing = params.snippets.filter(snippet => !params.text.includes(snippet));
  expect(missing, `${params.label}: missing required boundary wording: ${missing.join(' | ')}`).toEqual([]);
}

function assertContainsNone(params: { text: string; snippets: string[]; label: string }): void {
  const present = params.snippets.filter(snippet => params.text.includes(snippet));
  expect(present, `${params.label}: forbidden retired public-shell wording still present: ${present.join(' | ')}`).toEqual([]);
}

function assertOrdered(params: { text: string; snippets: string[]; label: string }): void {
  let lastIndex = -1;
  const problems: string[] = [];
  for (const snippet of params.snippets) {
    const nextIndex = params.text.indexOf(snippet);
    if (nextIndex === -1) {
      problems.push(`missing ordered snippet: ${snippet}`);
      continue;
    }
    if (nextIndex < lastIndex) {
      problems.push(`out-of-order snippet: ${snippet}`);
    }
    lastIndex = nextIndex;
  }
  expect(problems, `${params.label}: generic-first ordering drifted: ${problems.join(' | ')}`).toEqual([]);
}

function mustMatch(md: string, re: RegExp, label: string): RegExpMatchArray {
  const m = md.match(re);
  expect(m, `${label}: expected to match ${String(re)}`).not.toBeNull();
  return m as RegExpMatchArray;
}

describe('Docs tool drift guard', () => {
  const root = repoRootFromThisFile();
  const originalEnv = {
    HEP_ENABLE_ZOTERO: process.env.HEP_ENABLE_ZOTERO,
  };

  beforeAll(() => {
    // Docs are written assuming Zotero tools exist (optional feature). Force-enable for a stable tool set here.
    process.env.HEP_ENABLE_ZOTERO = '1';
  });

  afterAll(() => {
    if (originalEnv.HEP_ENABLE_ZOTERO === undefined) delete process.env.HEP_ENABLE_ZOTERO;
    else process.env.HEP_ENABLE_ZOTERO = originalEnv.HEP_ENABLE_ZOTERO;
  });

  it('docs/TOOL_CATEGORIES.md only references live tools and may mark temporary full-only bridges explicitly', async () => {
    const { getTools } = await import('../../src/tools/index.js');
    const full = new Set(getTools('full').map(t => t.name));

    const md = readText(root, 'docs/TOOL_CATEGORIES.md');
    const referenced = extractToolNamesFromToolCategories(md);
    assertAllExist({ referenced, allowed: full, label: 'docs/TOOL_CATEGORIES.md' });
  });

  it('README tables reference existing tools', async () => {
    const { getTools } = await import('../../src/tools/index.js');
    const full = new Set(getTools('full').map(t => t.name));

    for (const p of ['README.md', 'docs/README_zh.md']) {
      const md = readText(root, p);
      const referenced = extractToolNamesFromMarkdownTableFirstColumn(md);
      assertAllExist({ referenced, allowed: full, label: p });
    }
  });

  it('docs/WRITING_RECIPE_* reference existing tools', async () => {
    const { getTools } = await import('../../src/tools/index.js');
    const full = new Set(getTools('full').map(t => t.name));

    for (const p of ['docs/WRITING_RECIPE_DRAFT_PATH.md']) {
      const md = readText(root, p);
      const referenced = Array.from(new Set([...extractToolNamesFromHeadings(md), ...extractToolNamesFromToolJsonExamples(md)]));
      assertAllExist({ referenced, allowed: full, label: p });
    }
  });

  it('docs/TESTING_GUIDE.md headings/examples reference existing tools', async () => {
    const { getTools } = await import('../../src/tools/index.js');
    const full = new Set(getTools('full').map(t => t.name));

    const md = readText(root, 'docs/TESTING_GUIDE.md');
    const referenced = Array.from(new Set([...extractToolNamesFromHeadings(md), ...extractToolNamesFromToolJsonExamples(md)]));
    assertAllExist({ referenced, allowed: full, label: 'docs/TESTING_GUIDE.md' });
  });

  it('pdg-mcp README headings reference existing pdg tools', async () => {
    const { getTools } = await import('../../src/tools/index.js');
    const full = new Set(getTools('full').map(t => t.name));

    for (const p of ['packages/pdg-mcp/README.md', 'packages/pdg-mcp/README_zh.md']) {
      const md = readText(root, p);
      const referenced = extractPdgToolHeadings(md);
      assertAllExist({ referenced, allowed: full, label: p });
    }
  });

  it('zotero-mcp README tool list references existing zotero tools', async () => {
    const { getTools } = await import('../../src/tools/index.js');
    const full = new Set(getTools('full').map(t => t.name));

    const md = readText(root, 'packages/zotero-mcp/README.md');
    const spans = extractInlineCodeSpans(md);
    const referenced = Array.from(new Set(spans.flatMap(span => extractToolLikeTokensFromText(span)).filter(t => t.startsWith('zotero_'))));
    assertAllExist({ referenced, allowed: full, label: 'packages/zotero-mcp/README.md' });
  });

  it('meta/docs/orchestrator-mcp-tools-spec.md publishes the exact live orch_* inventory', async () => {
    const { ORCH_TOOL_SPECS } = await import('@nullius/orchestrator');
    const live = ORCH_TOOL_SPECS
      .map(tool => tool.name)
      .filter(name => name.startsWith('orch_'))
      .sort((left, right) => left.localeCompare(right));

    const md = readText(root, 'meta/docs/orchestrator-mcp-tools-spec.md');
    const referenced = extractOrchToolNamesFromText(md).sort((left, right) => left.localeCompare(right));

    expect(referenced).toEqual(live);
  });

  it('meta/docs/orchestrator-mcp-tools-spec.md keeps control-plane narrative invariants', () => {
    const md = readText(root, 'meta/docs/orchestrator-mcp-tools-spec.md');
    assertContainsAll({
      text: md,
      snippets: [
        '**Rule**: `orch_*` owns lifecycle state, approvals, queueing, and orchestration policy.',
        '5. `nullius` remains the generic front door for lifecycle / workflow-plan / bounded computation; `orch_*` is the MCP/operator counterpart of that control plane rather than a competing product identity.',
        '`hep://` and `orch://` are intentionally separate owned namespaces. Cross-scheme correlation must be carried explicitly by workflow metadata or operator context, not by implicit aliasing.',
        '2. The provider-local Python parser package has been retired. Do not recreate provider-local Python control-plane authority.',
      ],
      label: 'meta/docs/orchestrator-mcp-tools-spec.md',
    });
  });

  it('docs/URI_REGISTRY.md keeps exact live schemes and no implicit cross-scheme aliasing', () => {
    const md = readText(root, 'docs/URI_REGISTRY.md');
    assertContainsAll({
      text: md,
      snippets: [
        'The current emitted/resolved URI schemes covered by this registry are `hep://`, `pdg://`, `orch://`, `rep://`, `hepdata://`, `openalex://`, `zotero://`, `file://`, and `project://`.',
        '`orch://runs/{run_id}/artifact/{artifact_path}`',
        '`rep://runs/{run_id}/artifact/{artifact_path}`',
        '`hepdata://artifacts/submissions/{hepdata_id}/hepdata_submission.zip`',
        '`openalex://content/{work_id}/{file_name}`',
        '`zotero://select/library/items/{item_key}`',
        '`hep://` and `orch://` are separate owned namespaces.',
        'There is no implicit `hep://` <-> `orch://` aliasing layer in live authority.',
      ],
      label: 'docs/URI_REGISTRY.md',
    });
    assertContainsNone({
      text: md,
      snippets: ['| `hep://corpora` | Live |'],
      label: 'docs/URI_REGISTRY.md',
    });
  });

  it('public MCP docs keep the contracted local-stdio capability story narrow', () => {
    const docs = [
      {
        label: 'README.md',
        text: readText(root, 'README.md'),
        snippets: ['local stdio', 'inputSchema', 'JSON/text', 'no prompts'],
      },
      {
        label: 'docs/README_zh.md',
        text: readText(root, 'docs/README_zh.md'),
        snippets: ['本地 stdio', 'inputSchema', 'JSON/text', '没有 prompts'],
      },
      {
        label: 'docs/TESTING_GUIDE.md',
        text: readText(root, 'docs/TESTING_GUIDE.md'),
        snippets: ['本地 stdio', 'inputSchema', 'JSON/text', '没有 prompts'],
      },
      {
        label: 'docs/ARCHITECTURE.md',
        text: readText(root, 'docs/ARCHITECTURE.md'),
        snippets: ['local stdio', 'inputSchema', 'JSON/text', 'no prompts'],
      },
    ] as const;

    for (const { label, text, snippets } of docs) {
      assertContainsAll({
        text,
        snippets,
        label,
      });
      assertContainsNone({
        text,
        snippets: [
          '"transport": "http"',
          '"transport": "streamable-http"',
          '"oauth"',
        ],
        label,
      });
    }

    expect(Object.keys(JSON.parse(readText(root, 'mcp.template.json')))).toEqual(['mcpServers']);

    assertContainsAll({
      text: readText(root, 'README.md'),
      snippets: [
        '`orch_*` is an operator/tool inventory exposed by the orchestrator package; it is not a separately packaged root MCP server.',
        'Remote MCP transports, OAuth, and registry publishing remain future deployment work outside the current local-stdio contract.',
      ],
      label: 'README.md',
    });
  });

  it('front-door authority map classifies the live public surfaces', () => {
    expect(FRONT_DOOR_AUTHORITY_SURFACE_IDS).toEqual([
      'nullius_cli',
      'orchestrator_mcp_tools_spec',
      'idea_mcp',
    ]);

    expect(getFrontDoorAuthoritySurface('nullius_cli')).toMatchObject({
      classification: 'canonical_public',
      surface_kind: 'cli_command_inventory',
      exact_inventory_source: 'packages/orchestrator/src/cli-command-inventory.ts',
    });
    expect(getFrontDoorAuthoritySurface('orchestrator_mcp_tools_spec')).toMatchObject({
      classification: 'canonical_public',
      surface_kind: 'exact_doc_inventory',
      exact_inventory_source: 'meta/docs/orchestrator-mcp-tools-spec.md',
    });
    expect(getFrontDoorAuthoritySurface('idea_mcp')).toMatchObject({
      classification: 'canonical_public',
      surface_kind: 'mcp_tool_inventory',
      exact_inventory_source: 'packages/idea-mcp/src/tool-registry.ts',
    });
  });

  it('front-door authority JS helpers stay in sync with the JSON authority map', () => {
    expect(Object.keys(FRONT_DOOR_AUTHORITY_MAP_BY_SURFACE)).toEqual(FRONT_DOOR_AUTHORITY_SURFACE_IDS);

    expect(FRONT_DOOR_AUTHORITY_MAP_BY_SURFACE.nullius_cli).toMatchObject({
      surface: 'nullius_cli',
      classification: getFrontDoorAuthoritySurface('nullius_cli').classification,
      owner: getFrontDoorAuthoritySurface('nullius_cli').owner,
      relPath: getFrontDoorAuthoritySurface('nullius_cli').exact_inventory_source,
    });
    expect(FRONT_DOOR_AUTHORITY_MAP_BY_SURFACE.orchestrator_mcp_tools_spec).toMatchObject({
      surface: 'orchestrator_mcp_tools_spec',
      classification: getFrontDoorAuthoritySurface('orchestrator_mcp_tools_spec').classification,
      owner: getFrontDoorAuthoritySurface('orchestrator_mcp_tools_spec').owner,
      relPath: getFrontDoorAuthoritySurface('orchestrator_mcp_tools_spec').exact_inventory_source,
    });
    expect(FRONT_DOOR_AUTHORITY_MAP_BY_SURFACE.idea_mcp).toMatchObject({
      surface: 'idea_mcp',
      classification: getFrontDoorAuthoritySurface('idea_mcp').classification,
      owner: getFrontDoorAuthoritySurface('idea_mcp').owner,
      relPath: getFrontDoorAuthoritySurface('idea_mcp').exact_inventory_source,
    });

    expect(() => getFrontDoorAuthoritySurface(['hep', 'nullius', 'internal', 'parser'].join('_'))).toThrow(
      /unknown front-door authority surface/,
    );
  });

  it('README files avoid stale static HEP tool counts', () => {
    const en = readText(root, 'README.md');
    const zh = readText(root, 'docs/README_zh.md');

    for (const [label, md] of [
      ['README.md', en],
      ['docs/README_zh.md', zh],
    ] as const) {
      expect(md, `${label}: should not publish count snippets in the README`).not.toMatch(/\b\d+\s+std\s*\/\s*\d+\b/);
      expect(md, `${label}: should not publish a standard/full count table`).not.toMatch(/^\|\s*`standard`\s*\|\s*\d+\s*\|/m);
      expect(md, `${label}: should not publish a standard/full count table`).not.toMatch(/^\|\s*`full`\s*\|\s*\d+\s*\|/m);
    }

    expect(en).not.toContain('Tool counts:');
    expect(zh).not.toContain('工具数量：');
    expect(en).toContain('exact counts in the generated category/status docs');
    expect(zh).toContain('精确工具数量只保留在生成的分类/状态文档里');
  });

  it('docs tool count headers match the built-in tool registry', async () => {
    const { getTools } = await import('../../src/tools/index.js');
    const standardCount = getTools('standard').length;
    const fullCount = getTools('full').length;

    const categories = readText(root, 'docs/TOOL_CATEGORIES.md');
    const status = readText(root, 'docs/PROJECT_STATUS.md');

    {
      const m = mustMatch(categories, /^# Tool Categories（standard=(\d+)\s*\/\s*full=(\d+)）/m, 'docs/TOOL_CATEGORIES.md');
      expect(Number(m[1])).toBe(standardCount);
      expect(Number(m[2])).toBe(fullCount);
    }

    {
      const m = mustMatch(status, /-\s*`standard=(\d+)`,\s*`full=(\d+)`/m, 'docs/PROJECT_STATUS.md');
      expect(Number(m[1])).toBe(standardCount);
      expect(Number(m[2])).toBe(fullCount);
    }
  });

  it('front-door docs keep generic lifecycle and shell-boundary framing', () => {
    for (const { relPath, snippets, forbiddenSnippets = [], orderedSnippets = [] } of FRONT_DOOR_SNIPPETS) {
      const text = readText(root, relPath);
      assertContainsAll({ text, snippets, label: relPath });
      assertContainsNone({ text, snippets: forbiddenSnippets, label: relPath });
      assertOrdered({ text, snippets: orderedSnippets, label: relPath });
    }
  });
});
