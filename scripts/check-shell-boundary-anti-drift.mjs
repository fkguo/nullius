#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = path.join(repoRoot, 'packages');

const FRONT_DOOR_SNIPPETS = [
  {
    relPath: 'README.md',
    snippets: [
      // Keep these assertions line-stable: the checker uses exact substring
      // matches so front-door wording drift fails closed.
      'Autoresearch Lab is a domain-neutral, evidence-first research monorepo.',
      '`python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` resolve workflow recipes into bounded steps. `hepar literature-gap` is still live only as a legacy compatibility shell pending retirement.',
      '| Generic lifecycle front door | `autoresearch` | External project-root lifecycle state, approvals, pause/resume, export |',
      '| High-level literature workflow plan consumer | `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` | Checked-in generic recipe consumer for launcher-backed workflow plans |',
      'Legacy compatibility note: `hepar literature-gap` still exists in the legacy Pipeline A CLI surface, but it is no longer a recommended mainline entrypoint and is headed toward retirement.',
      '| Workflow shells | `workflow-plan` | Checked-in generic recipe consumer; `hepar literature-gap` remains only as a legacy compatibility wrapper pending retirement |',
      'Do not treat `hepar literature-gap` as a new front-door shell.',
      '- the root product identity',
    ],
  },
  {
    relPath: 'docs/README_zh.md',
    snippets: [
      // Keep these assertions line-stable: the checker uses exact substring
      // matches so front-door wording drift fails closed.
      'Autoresearch Lab 是一个面向理论研究的 domain-neutral、evidence-first monorepo。',
      '`python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 这类 checked-in generic workflow-plan consumer 会把 workflow recipe 解析成受限步骤。`hepar literature-gap` 仍然存在，但只作为待退役的 legacy compatibility shell。',
      '| 通用 lifecycle front door | `autoresearch` | 外部 project root 的 lifecycle state、审批、pause/resume、export |',
      '| 高层文献工作流入口 | `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` | launcher-backed workflow recipe 的 checked-in generic consumer |',
      'Legacy compatibility 说明：`hepar literature-gap` 仍在旧的 Pipeline A CLI 面上存活，但已不再是推荐的新入口，并且处于退役方向上。',
      '| Workflow shells | `workflow-plan` | checked-in generic recipe consumer；`hepar literature-gap` 仅剩 legacy compatibility wrapper，等待退役 |',
      '不要把 `hepar literature-gap` 当成新的前门 shell。',
      '- root 产品身份本身',
    ],
  },
  {
    relPath: 'docs/PROJECT_STATUS.md',
    snippets: [
      '**Root framing**: Domain-neutral substrate + control plane; HEP is the current most mature provider family, not the root identity',
      '**Main generic lifecycle entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state',
      '**Recommended launcher-backed literature workflow consumer**: `literature_fetch.py workflow-plan`',
      'Legacy compatibility note: `hepar literature-gap` is still live on the legacy Pipeline A CLI surface, but it is no longer a recommended mainline entrypoint.',
      '**Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`',
    ],
  },
  {
    relPath: 'docs/ARCHITECTURE.md',
    snippets: [
      '- The root architecture is domain-neutral.',
      '- checked-in workflow recipes that can be consumed by generic workflow-plan consumers or agent clients',
      'The current user-facing generic lifecycle entrypoint is the `autoresearch` CLI, not the root MCP server.',
      'High-level literature workflows are meant to enter through checked-in generic workflow-plan consumers:',
      '`hepar literature-gap` still exists on the legacy Pipeline A CLI surface as a compatibility wrapper, but it is not the recommended mainline entrypoint and should keep moving toward retirement.',
      'Users who need generic lifecycle state should invoke `autoresearch` directly rather than expecting the root MCP server to own that surface today.',
    ],
  },
  {
    relPath: 'docs/TOOL_CATEGORIES.md',
    snippets: [
      'launcher 解析后再下沉到 `inspire_search` / provenance / network operators；`hepar literature-gap` 仅剩 legacy compatibility shell',
      '不再通过 provider-specific high-level MCP facade；`hepar literature-gap` 不再作为推荐主入口',
      '高层 literature workflow 现由 checked-in `workflow-plan` consumer 承担；`hepar literature-gap` 仍是 legacy compatibility shell，但不再是推荐的新入口。',
    ],
  },
];

const FORBIDDEN_EXACT_PACKAGE_NAMES = new Set(['agent', 'autoresearch-agent']);
const FORBIDDEN_PACKAGE_TOKENS = new Set(['shell', 'gateway', 'frontend']);

function readRepoFile(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf-8');
}

function checkFrontDoorFiles(errors) {
  for (const { relPath, snippets } of FRONT_DOOR_SNIPPETS) {
    const content = readRepoFile(relPath);
    for (const snippet of snippets) {
      if (!content.includes(snippet)) {
        errors.push(`${relPath}: missing required boundary wording: ${JSON.stringify(snippet)}`);
      }
    }
  }

  const packageJson = JSON.parse(readRepoFile('package.json'));
  const description = typeof packageJson.description === 'string' ? packageJson.description : '';
  const requiredDescriptionSnippets = [
    'Autoresearch ecosystem monorepo',
    'control-plane',
    'provider packages',
  ];
  for (const snippet of requiredDescriptionSnippets) {
    if (!description.includes(snippet)) {
      errors.push(`package.json: description must include ${JSON.stringify(snippet)}`);
    }
  }
}

function packageTokens(name) {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function checkFutureShellPackages(errors) {
  if (!existsSync(packagesRoot)) {
    errors.push('packages/: directory is missing');
    return;
  }

  const packageDirs = readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const packageName of packageDirs) {
    if (FORBIDDEN_EXACT_PACKAGE_NAMES.has(packageName)) {
      errors.push(`packages/${packageName}: future leaf-shell package must not exist before P5A closure`);
      continue;
    }

    const forbiddenTokens = packageTokens(packageName).filter(token => FORBIDDEN_PACKAGE_TOKENS.has(token));
    if (forbiddenTokens.length > 0) {
      errors.push(
        `packages/${packageName}: forbidden future-shell token(s) in package name: ${forbiddenTokens.join(', ')}`
      );
    }
  }
}

function main() {
  const errors = [];
  checkFrontDoorFiles(errors);
  checkFutureShellPackages(errors);

  if (errors.length > 0) {
    process.stderr.write('[boundary-drift] root/shell boundary anti-drift check failed.\n');
    for (const error of errors) {
      process.stderr.write(` - ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('[ok] generic entrypoint truth and shell boundary wording are locked.\n');
}

main();
