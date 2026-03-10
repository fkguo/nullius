import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { invalidParams } from '@autoresearch/shared';

import type { RunArtifactRef } from '../runs.js';
import { getRun } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { HEP_RUN_BUILD_CITATION_MAPPING } from '../../tool-names.js';
import { createHepRunArtifactRef, makeHepRunArtifactUri } from '../runArtifactUri.js';

function nowIso(): string {
  return new Date().toISOString();
}

function makeRunArtifactRef(runId: string, artifactName: string, mimeType: string): RunArtifactRef {
  return createHepRunArtifactRef(runId, artifactName, mimeType);
}

function sanitizeStem(stem: string): string {
  const s = String(stem ?? '').trim();
  if (!s) return 'latex';
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

function commandExists(cmd: string): boolean {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(cmd)) return false;
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      fs.accessSync(full, fs.constants.X_OK);
      return true;
    } catch {
      // ignore
    }
  }
  return false;
}

async function runCommandToArtifacts(params: {
  run_id: string;
  cwd: string;
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeout_ms: number;
  stdout_artifact_name: string;
  stderr_artifact_name: string;
}): Promise<{ exit_code: number; artifacts: RunArtifactRef[] }> {
  const stdoutPath = getRunArtifactPath(params.run_id, params.stdout_artifact_name);
  const stderrPath = getRunArtifactPath(params.run_id, params.stderr_artifact_name);

  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'w' });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: 'w' });

  const artifacts = [
    makeRunArtifactRef(params.run_id, params.stdout_artifact_name, 'text/plain'),
    makeRunArtifactRef(params.run_id, params.stderr_artifact_name, 'text/plain'),
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(params.cmd, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, Math.max(1_000, params.timeout_ms));

    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);

    child.on('error', err => {
      clearTimeout(timeout);
      try {
        stdoutStream.end();
        stderrStream.end();
      } catch {
        // ignore
      }
      reject(err);
    });

    child.on('close', code => {
      clearTimeout(timeout);
      stdoutStream.end();
      stderrStream.end();
      resolve({ exit_code: typeof code === 'number' ? code : 1, artifacts });
    });
  });
}

export async function compileRunLatexOrThrow(params: {
  run_id: string;
  tex_artifact_name: string;
  bib_artifact_name?: string;
  output_pdf_artifact_name?: string;
  output_prefix?: string;
  passes: number;
  run_bibtex: boolean;
  timeout_ms: number;
}): Promise<{ artifacts: RunArtifactRef[]; summary: Record<string, unknown> }> {
  const runId = params.run_id;
  const texName = params.tex_artifact_name;
  const bibName = params.bib_artifact_name?.trim() ? params.bib_artifact_name.trim() : 'writing_master.bib';

  getRun(runId);

  if (!commandExists('pdflatex') || (params.run_bibtex && !commandExists('bibtex'))) {
    throw invalidParams(
      params.run_bibtex
        ? 'LaTeX toolchain not available (pdflatex+bibtex required) (fail-fast)'
        : 'LaTeX toolchain not available (pdflatex required) (fail-fast)',
      {
        run_id: runId,
        missing: {
          pdflatex: !commandExists('pdflatex'),
          bibtex: params.run_bibtex ? !commandExists('bibtex') : false,
        },
        next_actions: [
          params.run_bibtex
            ? 'Install a TeX Live distribution that provides `pdflatex` and `bibtex`.'
            : 'Install a TeX Live distribution that provides `pdflatex`.',
          'Then retry the write pipeline step that triggers the LaTeX compile gate.',
        ],
      }
    );
  }

  if (!Number.isFinite(params.passes) || params.passes < 1) {
    throw invalidParams('passes must be >= 1', { passes: params.passes });
  }

  const texPath = getRunArtifactPath(runId, texName);
  if (!fs.existsSync(texPath)) {
    throw invalidParams('Missing LaTeX artifact to compile (fail-fast)', {
      run_id: runId,
      artifact_name: texName,
    });
  }

  const bibPath = getRunArtifactPath(runId, bibName);
  if (params.run_bibtex && !fs.existsSync(bibPath)) {
    throw invalidParams('Missing BibTeX artifact required for LaTeX compile gate (fail-fast)', {
      run_id: runId,
      bib_artifact_name: bibName,
      next_actions: [
        { tool: HEP_RUN_BUILD_CITATION_MAPPING, args: { run_id: runId, identifier: '<paper-identifier>' }, reason: 'Build citation mapping to generate writing_master.bib.' },
      ],
    });
  }

  const stem = sanitizeStem(params.output_prefix ?? texName.replace(/\.tex$/i, ''));
  const pdfArtifactName = params.output_pdf_artifact_name?.trim()
    ? params.output_pdf_artifact_name.trim()
    : `latex_compile_${stem}.pdf`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hep-tex-${stem}-`));
  const tmpTexName = 'content.tex';
  const tmpBibName = 'writing_master.bib';
  const mainTexName = 'main.tex';
  const mainBase = 'main';

  const cleanup = (): void => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  const artifacts: RunArtifactRef[] = [];

  try {
    fs.copyFileSync(texPath, path.join(tmpDir, tmpTexName));
    if (params.run_bibtex && fs.existsSync(bibPath)) {
      fs.copyFileSync(bibPath, path.join(tmpDir, tmpBibName));
    }

    const wrapper = [
      '\\documentclass[11pt]{article}',
      '\\usepackage{amsmath,amssymb}',
      '\\usepackage{graphicx}',
      '\\usepackage{hyperref}',
      '\\usepackage{cite}',
      '\\begin{document}',
      `\\input{${tmpTexName}}`,
      params.run_bibtex ? '\\bibliographystyle{unsrt}' : '% bibtex disabled',
      params.run_bibtex ? `\\bibliography{${tmpBibName.replace(/\.bib$/i, '')}}` : '% bibtex disabled',
      '\\end{document}',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, mainTexName), wrapper, 'utf-8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Security: prevent shell escape and restrict openin/openout where supported (TeX Live honors these).
      openin_any: 'p',
      openout_any: 'p',
    };

    const pdflatexArgs = [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      '-no-shell-escape',
      mainTexName,
    ];

    // Pass 1
    const pass1 = await runCommandToArtifacts({
      run_id: runId,
      cwd: tmpDir,
      cmd: 'pdflatex',
      args: pdflatexArgs,
      env,
      timeout_ms: params.timeout_ms,
      stdout_artifact_name: `latex_compile_${stem}_pdflatex_pass1_stdout.txt`,
      stderr_artifact_name: `latex_compile_${stem}_pdflatex_pass1_stderr.txt`,
    });
    artifacts.push(...pass1.artifacts);
    if (pass1.exit_code !== 0) {
      throw invalidParams('LaTeX compile failed (pdflatex pass 1)', {
        run_id: runId,
        tex_artifact_name: texName,
        stdout_uri: makeHepRunArtifactUri(runId, `latex_compile_${stem}_pdflatex_pass1_stdout.txt`),
        stderr_uri: makeHepRunArtifactUri(runId, `latex_compile_${stem}_pdflatex_pass1_stderr.txt`),
      });
    }

    if (params.run_bibtex) {
      const bib = await runCommandToArtifacts({
        run_id: runId,
        cwd: tmpDir,
        cmd: 'bibtex',
        args: [mainBase],
        env,
        timeout_ms: params.timeout_ms,
        stdout_artifact_name: `latex_compile_${stem}_bibtex_stdout.txt`,
        stderr_artifact_name: `latex_compile_${stem}_bibtex_stderr.txt`,
      });
      artifacts.push(...bib.artifacts);
      if (bib.exit_code !== 0) {
        throw invalidParams('LaTeX compile failed (bibtex)', {
          run_id: runId,
          tex_artifact_name: texName,
          stdout_uri: makeHepRunArtifactUri(runId, `latex_compile_${stem}_bibtex_stdout.txt`),
          stderr_uri: makeHepRunArtifactUri(runId, `latex_compile_${stem}_bibtex_stderr.txt`),
        });
      }
    }

    // Remaining pdflatex passes
    for (let pass = 2; pass <= params.passes; pass++) {
      const res = await runCommandToArtifacts({
        run_id: runId,
        cwd: tmpDir,
        cmd: 'pdflatex',
        args: pdflatexArgs,
        env,
        timeout_ms: params.timeout_ms,
        stdout_artifact_name: `latex_compile_${stem}_pdflatex_pass${pass}_stdout.txt`,
        stderr_artifact_name: `latex_compile_${stem}_pdflatex_pass${pass}_stderr.txt`,
      });
      artifacts.push(...res.artifacts);
      if (res.exit_code !== 0) {
        throw invalidParams(`LaTeX compile failed (pdflatex pass ${pass})`, {
          run_id: runId,
          tex_artifact_name: texName,
          stdout_uri: makeHepRunArtifactUri(runId, `latex_compile_${stem}_pdflatex_pass${pass}_stdout.txt`),
          stderr_uri: makeHepRunArtifactUri(runId, `latex_compile_${stem}_pdflatex_pass${pass}_stderr.txt`),
        });
      }
    }

    const pdfSrc = path.join(tmpDir, `${mainBase}.pdf`);
    if (!fs.existsSync(pdfSrc)) {
      throw invalidParams('LaTeX compile produced no PDF (fail-fast)', {
        run_id: runId,
        tex_artifact_name: texName,
      });
    }

    fs.copyFileSync(pdfSrc, getRunArtifactPath(runId, pdfArtifactName));
    artifacts.push(makeRunArtifactRef(runId, pdfArtifactName, 'application/pdf'));

    const compileMetaName = `latex_compile_${stem}_result_v1.json`;
    fs.writeFileSync(
      getRunArtifactPath(runId, compileMetaName),
      JSON.stringify(
        {
          version: 1,
          generated_at: nowIso(),
          run_id: runId,
          tex_artifact_name: texName,
          bib_artifact_name: params.run_bibtex ? bibName : undefined,
          passes: params.passes,
          run_bibtex: params.run_bibtex,
          timeout_ms: params.timeout_ms,
          output_pdf_uri: makeHepRunArtifactUri(runId, pdfArtifactName),
        },
        null,
        2
      ),
      'utf-8'
    );
    artifacts.push(makeRunArtifactRef(runId, compileMetaName, 'application/json'));

    return {
      artifacts,
      summary: {
        compiled: true,
        tex_artifact: texName,
        pdf_uri: makeHepRunArtifactUri(runId, pdfArtifactName),
        passes: params.passes,
        run_bibtex: params.run_bibtex,
      },
    };
  } finally {
    cleanup();
  }
}
