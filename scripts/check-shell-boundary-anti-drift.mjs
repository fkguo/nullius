#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  FORBIDDEN_EXACT_PACKAGE_NAMES,
  FORBIDDEN_PACKAGE_TOKENS,
  FRONT_DOOR_SNIPPETS,
  REQUIRED_PACKAGE_DESCRIPTION_SNIPPETS,
} from './lib/front-door-boundary-authority.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = path.join(repoRoot, 'packages');

function readRepoFile(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf-8');
}

function checkFrontDoorFiles(errors) {
  for (const { relPath, snippets, forbiddenSnippets = [] } of FRONT_DOOR_SNIPPETS) {
    const content = readRepoFile(relPath);
    for (const snippet of snippets) {
      if (!content.includes(snippet)) {
        errors.push(`${relPath}: missing required boundary wording: ${JSON.stringify(snippet)}`);
      }
    }
    for (const snippet of forbiddenSnippets) {
      if (content.includes(snippet)) {
        errors.push(`${relPath}: forbidden retired public-shell wording still present: ${JSON.stringify(snippet)}`);
      }
    }
  }

  const packageJson = JSON.parse(readRepoFile('package.json'));
  const description = typeof packageJson.description === 'string' ? packageJson.description : '';
  for (const snippet of REQUIRED_PACKAGE_DESCRIPTION_SNIPPETS) {
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
    process.stderr.write('[boundary-drift] front-door and shell-boundary anti-drift check failed.\n');
    for (const error of errors) {
      process.stderr.write(` - ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('[ok] generic entrypoint truth, package first-touch framing, and shell boundary wording are locked.\n');
}

main();
