import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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

  it('docs/TOOL_CATEGORIES.md only references standard tools', async () => {
    const { getTools } = await import('../../src/tools/index.js');
    const standard = new Set(getTools('standard').map(t => t.name));

    const md = readText(root, 'docs/TOOL_CATEGORIES.md');
    const referenced = extractToolNamesFromToolCategories(md);
    assertAllExist({ referenced, allowed: standard, label: 'docs/TOOL_CATEGORIES.md' });
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

  it('README tool counts match the built-in tool registry', async () => {
    const { getTools } = await import('../../src/tools/index.js');
    const standardCount = getTools('standard').length;
    const fullCount = getTools('full').length;

    const en = readText(root, 'README.md');
    const zh = readText(root, 'docs/README_zh.md');

    {
      const m = mustMatch(
        en,
        /Tool counts:\s*\*\*(\d+)\s+tools in `standard` mode\*\*[\s\S]*?\*\*(\d+)\s+tools in `full` mode\*\*/m,
        'README.md'
      );
      expect(Number(m[1])).toBe(standardCount);
      expect(Number(m[2])).toBe(fullCount);
    }

    {
      const m = mustMatch(
        zh,
        /工具数量：\s*\*\*`standard`\s*模式\s*(\d+)\s*个\*\*[\s\S]*?\*\*`full`\s*模式\s*(\d+)\s*个\*\*/m,
        'docs/README_zh.md'
      );
      expect(Number(m[1])).toBe(standardCount);
      expect(Number(m[2])).toBe(fullCount);
    }

    for (const [label, md] of [
      ['README.md', en],
      ['docs/README_zh.md', zh],
    ] as const) {
      const mStd = mustMatch(md, /^\|\s*`standard`\s*\|\s*(\d+)\s*\|/m, label);
      const mFull = mustMatch(md, /^\|\s*`full`\s*\|\s*(\d+)\s*\|/m, label);
      expect(Number(mStd[1])).toBe(standardCount);
      expect(Number(mFull[1])).toBe(fullCount);

      const mDiagram = mustMatch(md, /\(\s*(\d+)\s+std\s*\/\s*(\d+)\s*\)/m, label);
      expect(Number(mDiagram[1])).toBe(standardCount);
      expect(Number(mDiagram[2])).toBe(fullCount);
    }
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

  it('root docs keep generic lifecycle and shell-boundary framing', () => {
    const requiredByPath: Array<[string, string[]]> = [
      [
        'README.md',
        [
          '`autoresearch workflow-plan` is the recommended stateful launcher-backed front door for literature workflows on an initialized external project root; it resolves checked-in generic workflow recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`. The checked-in `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` remains a lower-level consumer of the same workflow authority, and `hepar literature-gap` is still live only as a legacy compatibility shell pending retirement.',
          '| Generic lifecycle + workflow-plan front door | `autoresearch` | External project-root lifecycle state, approvals, pause/resume, export, and stateful workflow-plan persistence |',
          '| High-level literature workflow plan entrypoint | `autoresearch workflow-plan` | Recommended stateful launcher-backed entrypoint for initialized external project roots; resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`; `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` is the lower-level parallel consumer and `hepar literature-gap` is legacy compatibility-only |',
          'Legacy compatibility note: `hepar literature-gap` still exists in the legacy Pipeline A CLI surface, but it is no longer a recommended mainline entrypoint and is headed toward retirement.',
          '| Workflow shells | `workflow-plan` | Checked-in generic workflow authority consumed directly by `autoresearch workflow-plan` and by the lower-level `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan`; `hepar literature-gap` remains only as a legacy compatibility wrapper pending retirement |',
          '- For launcher-backed literature workflows, first initialize the target external project root with `autoresearch init`, then use `autoresearch workflow-plan` from that root or with `--project-root`. It resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`, and leaves the checked-in Python `workflow-plan` script as the lower-level parallel consumer. Do not treat `hepar literature-gap` as a new front-door shell.',
          '- the root product identity',
        ],
      ],
      [
        'docs/README_zh.md',
        [
          '`autoresearch workflow-plan` 是推荐的 stateful launcher-backed 前门，面向已经初始化好的外部 project root；它会直接通过 `@autoresearch/literature-workflows` 解析 checked-in generic workflow recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。checked-in 的 `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 仍是同一 workflow authority 的较底层 consumer；`hepar literature-gap` 仍然存在，但只作为待退役的 legacy compatibility shell。',
          '| 通用 lifecycle + workflow-plan front door | `autoresearch` | 外部 project root 的 lifecycle state、审批、pause/resume、export，以及 stateful workflow-plan 持久化 |',
          '| 高层文献工作流入口 | `autoresearch workflow-plan` | 推荐的 stateful launcher-backed 前门，面向已初始化的外部 project root；直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；`python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 是较底层的并行 consumer，`hepar literature-gap` 仅作 legacy compatibility |',
          'Legacy compatibility 说明：`hepar literature-gap` 仍在旧的 Pipeline A CLI 面上存活，但已不再是推荐的新入口，并且处于退役方向上。',
          '| Workflow shells | `workflow-plan` | checked-in generic workflow authority，由 `autoresearch workflow-plan` 直接消费，也由较底层的 `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 消费；`hepar literature-gap` 仅剩 legacy compatibility wrapper，等待退役 |',
          '- 对 launcher-backed 文献工作流，先用 `autoresearch init` 初始化目标外部 project root，再在该 root 内或通过 `--project-root` 调用 `autoresearch workflow-plan`。它会直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；checked-in 的 Python `workflow-plan` 脚本仍是较底层的并行 consumer；不要把 `hepar literature-gap` 当成新的前门 shell。',
          '- root 产品身份本身',
        ],
      ],
      [
        'docs/PROJECT_STATUS.md',
        [
          '**Root framing**: Domain-neutral substrate + control plane; HEP is the current most mature provider family, not the root identity',
          '**Main generic lifecycle + workflow-plan entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state',
          '- **Recommended launcher-backed literature workflow entrypoint**: `autoresearch workflow-plan` (requires an initialized external project root; resolves recipes directly via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`; the checked-in Python `workflow-plan` script remains a lower-level parallel consumer, and `hepar literature-gap` remains legacy compatibility-only)',
          'Legacy compatibility note: `hepar literature-gap` is still live on the legacy Pipeline A CLI surface, but it is no longer a recommended mainline entrypoint.',
          '**Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`',
        ],
      ],
      [
        'docs/ARCHITECTURE.md',
        [
          '- The root architecture is domain-neutral.',
          '- checked-in workflow recipes that can be consumed by generic workflow-plan consumers or agent clients',
          'The current user-facing generic lifecycle + workflow-plan entrypoint is the `autoresearch` CLI, not the root MCP server.',
          'High-level literature workflows are meant to enter through the stateful launcher-backed `autoresearch workflow-plan`, which requires an initialized external project root and resolves checked-in workflow authority directly via `@autoresearch/literature-workflows`:',
          '`hepar literature-gap` still exists on the legacy Pipeline A CLI surface as a compatibility wrapper, but it is not the recommended mainline entrypoint and should keep moving toward retirement.',
          '`autoresearch workflow-plan` → native TS front door using `@autoresearch/literature-workflows`, persisting `.autoresearch/state.json#/plan` and deriving `.autoresearch/plan.md`',
          'Users who need generic lifecycle state should invoke `autoresearch` directly rather than expecting the root MCP server to own that surface today.',
        ],
      ],
      [
        'docs/TOOL_CATEGORIES.md',
        [
          'launcher 解析后再下沉到 `inspire_search` / provenance / network operators；`hepar literature-gap` 仅剩 legacy compatibility shell',
          '不再通过 provider-specific high-level MCP facade；`hepar literature-gap` 不再作为推荐主入口',
          '高层 literature workflow 现由 stateful launcher-backed `autoresearch workflow-plan` 前门承载，需先 `autoresearch init` 并且会直接通过 `@autoresearch/literature-workflows` 解析后写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；checked-in 的 Python `workflow-plan` 脚本是同一 authority 的较底层 consumer；`hepar literature-gap` 仍是 legacy compatibility shell，但不再是推荐的新入口。',
        ],
      ],
    ];

    for (const [relPath, snippets] of requiredByPath) {
      assertContainsAll({ text: readText(root, relPath), snippets, label: relPath });
    }
  });
});
