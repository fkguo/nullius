#!/usr/bin/env node

/**
 * P3-A followup-4: integrity-receipt anti-drift CI check.
 *
 * Locks the contract that every approval-gate code path in the orchestrator
 * calls `verifyIntegrityReceipt` from `@autoresearch/shared` before granting
 * the approval. This catches:
 *   - A refactor that moves the approve handler to a new file without
 *     carrying the verifier call along.
 *   - The verifier import being dropped while the handler stays in place.
 *   - The call being downgraded to a no-op (the check is structural — we
 *     look for both the import and the bare call).
 *
 * The check is a structural grep on the canonical approve-gate handler.
 * Adding a new approval-gate entry-point: register the file in
 * `APPROVAL_GATE_HANDLERS`. The discovery pass also fails CI when a new
 * `handleOrchRunApprove`-style symbol is exported from a non-tracked file,
 * so this anti-drift check cannot be silently bypassed by routing approve
 * through a sibling module.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tracked approval-gate handler files. Each MUST import + reference
// `verifyIntegrityReceipt` from `@autoresearch/shared`.
const APPROVAL_GATE_HANDLERS = [
  'packages/orchestrator/src/orch-tools/approval.ts',
];

// Discovery pass: any file under `packages/orchestrator/src/` that defines
// `handleOrchRunApprove` (either as `export async function ...` or as
// `export const ... = async (...) => ...`) MUST be in the tracked list.
// Catches "approve handler moved without registering" across both function
// styles the repo might adopt in a future refactor.
const APPROVE_HANDLER_SYMBOL_RE = /export\s+(?:async\s+function|const)\s+handleOrchRunApprove\b/;
const ORCHESTRATOR_SRC_REL = 'packages/orchestrator/src';

const IMPORT_PATTERN = /verifyIntegrityReceipt[^;]*from\s+['"]@autoresearch\/shared['"]/;
const USAGE_PATTERN = /\bverifyIntegrityReceipt\s*\(/;

async function walkTsAsync(dir) {
  const fs = await import('node:fs');
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkTsAsync(p)));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function checkHandlerFile(relPath, errors) {
  const absPath = path.join(repoRoot, relPath);
  if (!existsSync(absPath)) {
    errors.push(`${relPath}: tracked approval-gate handler is missing — has the file been moved or renamed?`);
    return;
  }
  const content = readFileSync(absPath, 'utf-8');
  if (!APPROVE_HANDLER_SYMBOL_RE.test(content)) {
    errors.push(
      `${relPath}: tracked as an approval-gate handler but does not export \`handleOrchRunApprove\`. ` +
      `Has the symbol been moved? Update APPROVAL_GATE_HANDLERS in this script.`,
    );
    return;
  }
  if (!IMPORT_PATTERN.test(content)) {
    errors.push(
      `${relPath}: missing import of \`verifyIntegrityReceipt\` from '@autoresearch/shared'.`,
    );
  }
  if (!USAGE_PATTERN.test(content)) {
    errors.push(
      `${relPath}: imports \`verifyIntegrityReceipt\` but never calls it. ` +
      `The call must run before granting any A1-A5 approval.`,
    );
  }
}

async function main() {
  const errors = [];

  // 1. Every tracked approval-gate handler must wire the verifier.
  for (const relPath of APPROVAL_GATE_HANDLERS) {
    checkHandlerFile(relPath, errors);
  }

  // 2. Discovery pass: any file under packages/orchestrator/src/ that
  // exports `handleOrchRunApprove` must be in the tracked list. Catches
  // "approve handler moved without registering".
  const orchSrcAbs = path.join(repoRoot, ORCHESTRATOR_SRC_REL);
  if (existsSync(orchSrcAbs)) {
    const trackedSet = new Set(APPROVAL_GATE_HANDLERS);
    const allTs = await walkTsAsync(orchSrcAbs);
    for (const abs of allTs) {
      const content = readFileSync(abs, 'utf-8');
      if (!APPROVE_HANDLER_SYMBOL_RE.test(content)) continue;
      const rel = path.relative(repoRoot, abs);
      if (!trackedSet.has(rel)) {
        errors.push(
          `${rel}: defines \`handleOrchRunApprove\` but is not registered in APPROVAL_GATE_HANDLERS ` +
          `in scripts/check-integrity-receipt-anti-drift.mjs. Add the path to the tracked list and ` +
          `wire \`verifyIntegrityReceipt\` before granting the approval.`,
        );
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write('[integrity-receipt-drift] approval-gate anti-drift check failed:\n\n');
    for (const error of errors) {
      process.stderr.write(`  - ${error}\n`);
    }
    process.stderr.write(
      '\nEvery approval-gate handler must import and call `verifyIntegrityReceipt` ' +
      "from '@autoresearch/shared' before granting an A1-A5 approval. See " +
      'packages/orchestrator/src/orch-tools/approval.ts for the canonical wiring.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('[ok] all approval-gate handlers wire `verifyIntegrityReceipt` from @autoresearch/shared.\n');
}

await main();
