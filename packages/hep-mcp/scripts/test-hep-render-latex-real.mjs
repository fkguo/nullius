#!/usr/bin/env node
/**
 * Demonstrate calling `hep_render_latex` with a nested `draft` object via MCP stdio.
 *
 * This is useful when an MCP client UI/LLM struggles to construct/submit deeply nested JSON.
 *
 * Usage:
 *   pnpm -r build
 *   node packages/hep-mcp/scripts/test-hep-render-latex-real.mjs --run-id <run_id> [--data-dir <HEP_DATA_DIR>]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function parseArgs(argv) {
  const out = { runId: undefined, dataDir: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--run-id') {
      out.runId = argv[i + 1];
      i++;
      continue;
    }
    if (arg === '--data-dir') {
      out.dataDir = argv[i + 1];
      i++;
      continue;
    }
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  pnpm -r build',
    '  node packages/hep-mcp/scripts/test-hep-render-latex-real.mjs --run-id <run_id> [--data-dir <HEP_DATA_DIR>]',
    '',
    'Notes:',
    '  - `--data-dir` must match the data dir used when the run was created (HEP_DATA_DIR).',
    '  - This script uses a real INSPIRE recid + citekey: 1597424 / Guo:2017jvc.',
  ].join('\n');
}

const { runId, dataDir, help } = parseArgs(process.argv.slice(2));

if (help) {
  console.log(usage());
  process.exit(0);
}

if (!runId || String(runId).trim().length === 0) {
  console.error('Missing --run-id');
  console.error(usage());
  process.exit(1);
}

if (dataDir) {
  const abs = path.resolve(dataDir);
  if (!fs.existsSync(abs)) {
    console.error(`HEP_DATA_DIR does not exist: ${abs}`);
    process.exit(1);
  }
}

const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const env = { ...process.env };
if (dataDir) env.HEP_DATA_DIR = path.resolve(dataDir);

const transport = new StdioClientTransport({
  command: 'node',
  args: [serverEntry],
  env,
});

const client = new Client({ name: 'hep-render-latex-real', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);

const callArgs = {
  run_id: String(runId).trim(),
  draft: {
    version: 1,
    title: 'hep_render_latex real recid/citekey test',
    paragraphs: [
      {
        sentences: [
          {
            sentence: 'This sentence is grounded and must be cited (real INSPIRE recid + citekey).',
            type: 'fact',
            is_grounded: true,
            evidence_ids: ['manual_test_ev_1'],
            recids: ['1597424'],
          },
        ],
      },
    ],
  },
  allowed_citations: ['inspire:1597424'],
  cite_mapping: {
    'Guo:2017jvc': { status: 'matched', recid: '1597424' },
  },
  latex_artifact_name: 'rendered_latex_real.tex',
  section_output_artifact_name: 'rendered_section_output_real.json',
  verification_artifact_name: 'rendered_latex_verification_real.json',
};

const res = await client.callTool({ name: 'hep_render_latex', arguments: callArgs });
const rawText = res.content?.[0]?.text ?? '';

let payload;
try {
  payload = JSON.parse(rawText);
} catch {
  payload = undefined;
}

if (res.isError) {
  console.error('hep_render_latex returned isError=true');
  console.error(rawText);
  await client.close();
  process.exit(2);
}

console.log(JSON.stringify(payload, null, 2));

const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
const latexUri = artifacts.find(a => a?.name === 'rendered_latex_real.tex')?.uri;

if (typeof latexUri !== 'string' || latexUri.trim().length === 0) {
  console.error('Missing rendered LaTeX artifact URI in tool result');
  await client.close();
  process.exit(3);
}

const latexRes = await client.readResource({ uri: latexUri });
const latexText = String(latexRes?.contents?.[0]?.text ?? '');

console.log('\n--- rendered_latex_real.tex (first 300 chars) ---\n');
console.log(latexText.slice(0, 300));
console.log('\n--- contains expected citekey? ---\n');
console.log(latexText.includes('\\cite{Guo:2017jvc}') ? 'OK: found \\cite{Guo:2017jvc}' : 'ERROR: missing \\cite{Guo:2017jvc}');

await client.close();
