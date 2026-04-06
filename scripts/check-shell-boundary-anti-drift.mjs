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
      '`autoresearch workflow-plan` is the recommended stateful launcher-backed front door for literature workflows on an initialized external project root; it resolves checked-in generic workflow recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`. The checked-in `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` remains a lower-level consumer of the same workflow authority, and `hepar literature-gap` is still live only as a legacy compatibility shell pending retirement.',
      '| Generic lifecycle + workflow-plan front door | `autoresearch` | External project-root lifecycle state, approvals, pause/resume, export, and stateful workflow-plan persistence |',
      '| High-level literature workflow plan entrypoint | `autoresearch workflow-plan` | Recommended stateful launcher-backed entrypoint for initialized external project roots; resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`; `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` is the lower-level parallel consumer and `hepar literature-gap` is legacy compatibility-only |',
      'Legacy compatibility note: `hepar literature-gap` still exists in the legacy Pipeline A CLI surface, but it is no longer a recommended mainline entrypoint and is headed toward retirement.',
      '| Workflow shells | `workflow-plan` | Checked-in generic workflow authority consumed directly by `autoresearch workflow-plan` and by the lower-level `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan`; `hepar literature-gap` remains only as a legacy compatibility wrapper pending retirement |',
      '- For launcher-backed literature workflows, first initialize the target external project root with `autoresearch init`, then use `autoresearch workflow-plan` from that root or with `--project-root`. It resolves recipes directly via `@autoresearch/literature-workflows`, persists `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`, and leaves the checked-in Python `workflow-plan` script as the lower-level parallel consumer. Do not treat `hepar literature-gap` as a new front-door shell.',
      '- the root product identity',
    ],
  },
  {
    relPath: 'docs/README_zh.md',
    snippets: [
      // Keep these assertions line-stable: the checker uses exact substring
      // matches so front-door wording drift fails closed.
      'Autoresearch Lab 是一个面向理论研究的 domain-neutral、evidence-first monorepo。',
      '`autoresearch workflow-plan` 是推荐的 stateful launcher-backed 前门，面向已经初始化好的外部 project root；它会直接通过 `@autoresearch/literature-workflows` 解析 checked-in generic workflow recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`。checked-in 的 `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 仍是同一 workflow authority 的较底层 consumer；`hepar literature-gap` 仍然存在，但只作为待退役的 legacy compatibility shell。',
      '| 通用 lifecycle + workflow-plan front door | `autoresearch` | 外部 project root 的 lifecycle state、审批、pause/resume、export，以及 stateful workflow-plan 持久化 |',
      '| 高层文献工作流入口 | `autoresearch workflow-plan` | 推荐的 stateful launcher-backed 前门，面向已初始化的外部 project root；直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；`python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 是较底层的并行 consumer，`hepar literature-gap` 仅作 legacy compatibility |',
      'Legacy compatibility 说明：`hepar literature-gap` 仍在旧的 Pipeline A CLI 面上存活，但已不再是推荐的新入口，并且处于退役方向上。',
      '| Workflow shells | `workflow-plan` | checked-in generic workflow authority，由 `autoresearch workflow-plan` 直接消费，也由较底层的 `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan` 消费；`hepar literature-gap` 仅剩 legacy compatibility wrapper，等待退役 |',
      '- 对 launcher-backed 文献工作流，先用 `autoresearch init` 初始化目标外部 project root，再在该 root 内或通过 `--project-root` 调用 `autoresearch workflow-plan`。它会直接通过 `@autoresearch/literature-workflows` 解析 recipe，并写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；checked-in 的 Python `workflow-plan` 脚本仍是较底层的并行 consumer；不要把 `hepar literature-gap` 当成新的前门 shell。',
      '- root 产品身份本身',
    ],
  },
  {
    relPath: 'docs/PROJECT_STATUS.md',
    snippets: [
      '**Root framing**: Domain-neutral substrate + control plane; HEP is the current most mature provider family, not the root identity',
      '**Main generic lifecycle + workflow-plan entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state',
      '**Recommended launcher-backed literature workflow entrypoint**: `autoresearch workflow-plan` (requires an initialized external project root; resolves recipes directly via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`; the checked-in Python `workflow-plan` script remains a lower-level parallel consumer, and `hepar literature-gap` remains legacy compatibility-only)',
      'Legacy compatibility note: `hepar literature-gap` is still live on the legacy Pipeline A CLI surface, but it is no longer a recommended mainline entrypoint.',
      '**Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`',
    ],
  },
  {
    relPath: 'docs/ARCHITECTURE.md',
    snippets: [
      '- The root architecture is domain-neutral.',
      '- checked-in workflow recipes that can be consumed by generic workflow-plan consumers or agent clients',
      'The current user-facing generic lifecycle + workflow-plan entrypoint is the `autoresearch` CLI, not the root MCP server.',
      'High-level literature workflows are meant to enter through the stateful launcher-backed `autoresearch workflow-plan`, which requires an initialized external project root and resolves checked-in workflow authority directly via `@autoresearch/literature-workflows`:',
      '`autoresearch workflow-plan` → native TS front door using `@autoresearch/literature-workflows`, persisting `.autoresearch/state.json#/plan` and deriving `.autoresearch/plan.md`',
      '`hepar literature-gap` still exists on the legacy Pipeline A CLI surface as a compatibility wrapper, but it is not the recommended mainline entrypoint and should keep moving toward retirement.',
      'Users who need generic lifecycle state should invoke `autoresearch` directly rather than expecting the root MCP server to own that surface today.',
    ],
  },
  {
    relPath: 'docs/TOOL_CATEGORIES.md',
    snippets: [
      'launcher 解析后再下沉到 `inspire_search` / provenance / network operators；`hepar literature-gap` 仅剩 legacy compatibility shell',
      '不再通过 provider-specific high-level MCP facade；`hepar literature-gap` 不再作为推荐主入口',
      '高层 literature workflow 现由 stateful launcher-backed `autoresearch workflow-plan` 前门承载，需先 `autoresearch init` 并且会直接通过 `@autoresearch/literature-workflows` 解析后写入 `.autoresearch/state.json#/plan` / `.autoresearch/plan.md`；checked-in 的 Python `workflow-plan` 脚本是同一 authority 的较底层 consumer；`hepar literature-gap` 仍是 legacy compatibility shell，但不再是推荐的新入口。',
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
