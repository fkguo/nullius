/**
 * Image Converter Utilities
 * 
 * Converts EPS/PS images to PNG using ghostscript and renders TikZ diagrams.
 * All conversions are optional - if tools are not installed, gracefully skip.
 * 
 * Security considerations:
 * - Uses spawn() with array arguments to avoid shell injection
 * - Disables LaTeX shell-escape to prevent command execution
 * - Limits stderr capture to prevent memory exhaustion
 * - Uses isolated temp directories for LaTeX compilation
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

// Security: Maximum stderr/stdout buffer size to prevent memory exhaustion
const MAX_OUTPUT_SIZE = 64 * 1024; // 64KB

// Security: Maximum LaTeX source size to prevent DoS
const MAX_LATEX_SOURCE_SIZE = 1024 * 1024; // 1MB

// Validation: DPI range (reasonable for image generation)
const MIN_DPI = 72;
const MAX_DPI = 1200;
const DEFAULT_DPI = 300;

// Validation: Timeout range in milliseconds
const MIN_TIMEOUT = 5000;    // 5 seconds minimum
const MAX_TIMEOUT = 300000;  // 5 minutes maximum
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_LATEX_TIMEOUT = 60000;

/**
 * Clamp a numeric value to a range
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversionResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  tool?: string;
}

export interface ToolAvailability {
  ghostscript: boolean;
  pdflatex: boolean;
  pdftoppm: boolean;
  convert: boolean;  // ImageMagick (legacy `convert` or IMv7 `magick`)
  magick: boolean;   // ImageMagick v7 `magick` command
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a command exists on the system
 */
async function commandExists(cmd: string): Promise<boolean> {
  // Security: avoid command injection if this helper is ever reused with untrusted input.
  // Also: avoid shelling out entirely (no `exec()`), which reduces attack surface.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(cmd)) return false;

  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  if (dirs.length === 0) return false;

  if (process.platform === 'win32') {
    const pathextRaw = process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
    const exts = pathextRaw
      .split(';')
      .map(s => s.trim())
      .filter(Boolean)
      .map(ext => (ext.startsWith('.') ? ext : `.${ext}`));

    const hasExt = path.extname(cmd) !== '';
    const candidates = hasExt ? [cmd] : exts.map(ext => `${cmd}${ext}`);

    for (const dir of dirs) {
      for (const name of candidates) {
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) return true;
        } catch {
          // ignore
        }
      }
    }
    return false;
  }

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

/**
 * Cache for tool availability (computed once per process)
 */
let toolAvailabilityCache: ToolAvailability | null = null;

/**
 * Check which image conversion tools are available on the system
 */
export async function checkToolAvailability(): Promise<ToolAvailability> {
  if (toolAvailabilityCache) {
    return toolAvailabilityCache;
  }

  const [ghostscript, pdflatex, pdftoppm, convert, magick] = await Promise.all([
    commandExists('gs'),
    commandExists('pdflatex'),
    commandExists('pdftoppm'),
    commandExists('convert'),  // ImageMagick legacy
    commandExists('magick'),   // ImageMagick v7
  ]);

  toolAvailabilityCache = { ghostscript, pdflatex, pdftoppm, convert, magick };
  return toolAvailabilityCache;
}

/**
 * Reset tool availability cache (useful for testing)
 */
export function resetToolAvailabilityCache(): void {
  toolAvailabilityCache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EPS/PS to PNG Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert EPS/PS file to PNG using Ghostscript
 * 
 * @param inputPath - Path to input EPS/PS file
 * @param outputPath - Path to output PNG file
 * @param options - Conversion options
 * @returns Conversion result
 */
export async function convertEpsToPng(
  inputPath: string,
  outputPath: string,
  options: { dpi?: number; timeout?: number } = {}
): Promise<ConversionResult> {
  const dpi = clamp(options.dpi ?? DEFAULT_DPI, MIN_DPI, MAX_DPI);
  const timeout = clamp(options.timeout ?? DEFAULT_TIMEOUT, MIN_TIMEOUT, MAX_TIMEOUT);

  // Check if ghostscript is available
  const tools = await checkToolAvailability();
  if (!tools.ghostscript) {
    return {
      success: false,
      error: 'ghostscript (gs) not installed - skipping EPS/PS conversion',
      tool: 'gs',
    };
  }

  // Verify input file exists
  if (!fs.existsSync(inputPath)) {
    return {
      success: false,
      error: `Input file not found: ${inputPath}`,
    };
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  return new Promise((resolve) => {
    const gs = spawn('gs', [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      '-dEPSCrop',  // Crop to EPS bounding box
      '-sDEVICE=png16m',
      `-r${dpi}`,
      `-sOutputFile=${outputPath}`,
      inputPath,
    ], {
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    gs.stderr?.on('data', (data) => {
      // Security: Limit stderr size to prevent memory exhaustion
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += data.toString().slice(0, MAX_OUTPUT_SIZE - stderr.length);
      }
    });

    gs.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ success: true, outputPath, tool: 'gs' });
      } else {
        resolve({
          success: false,
          error: `gs exited with code ${code}: ${stderr.slice(0, 200)}`,
          tool: 'gs',
        });
      }
    });

    gs.on('error', (err) => {
      resolve({
        success: false,
        error: `gs error: ${err.message}`,
        tool: 'gs',
      });
    });
  });
}

/**
 * Get the ImageMagick command to use (prefer `magick` for IMv7, fallback to `convert`)
 */
function getImageMagickCommand(tools: ToolAvailability): { cmd: string; args: string[] } | null {
  if (tools.magick) {
    // ImageMagick v7: use `magick` with convert subcommand
    return { cmd: 'magick', args: ['convert'] };
  }
  if (tools.convert) {
    // ImageMagick v6 or earlier: use `convert` directly
    return { cmd: 'convert', args: [] };
  }
  return null;
}

/**
 * Convert EPS/PS file to PNG using ImageMagick (fallback)
 */
export async function convertEpsToPngImageMagick(
  inputPath: string,
  outputPath: string,
  options: { dpi?: number; timeout?: number } = {}
): Promise<ConversionResult> {
  const dpi = clamp(options.dpi ?? DEFAULT_DPI, MIN_DPI, MAX_DPI);
  const timeout = clamp(options.timeout ?? DEFAULT_TIMEOUT, MIN_TIMEOUT, MAX_TIMEOUT);

  const tools = await checkToolAvailability();
  const imCmd = getImageMagickCommand(tools);
  if (!imCmd) {
    return {
      success: false,
      error: 'ImageMagick (magick/convert) not installed',
      tool: 'imagemagick',
    };
  }

  if (!fs.existsSync(inputPath)) {
    return {
      success: false,
      error: `Input file not found: ${inputPath}`,
    };
  }

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const toolName = imCmd.cmd === 'magick' ? 'magick' : 'convert';

  return new Promise((resolve) => {
    const convert = spawn(imCmd.cmd, [
      ...imCmd.args,
      '-density', String(dpi),
      inputPath,
      '-flatten',
      outputPath,
    ], {
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    convert.stderr?.on('data', (data) => {
      // Security: Limit stderr size
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += data.toString().slice(0, MAX_OUTPUT_SIZE - stderr.length);
      }
    });

    convert.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ success: true, outputPath, tool: toolName });
      } else {
        resolve({
          success: false,
          error: `${toolName} exited with code ${code}: ${stderr.slice(0, 200)}`,
          tool: toolName,
        });
      }
    });

    convert.on('error', (err) => {
      resolve({
        success: false,
        error: `${toolName} error: ${err.message}`,
        tool: toolName,
      });
    });
  });
}

/**
 * Convert EPS/PS to PNG using best available tool
 */
export async function convertEpsToPngAuto(
  inputPath: string,
  outputPath: string,
  options: { dpi?: number; timeout?: number } = {}
): Promise<ConversionResult> {
  // Try ghostscript first (better quality for EPS)
  let result = await convertEpsToPng(inputPath, outputPath, options);
  if (result.success) {
    return result;
  }

  // Fall back to ImageMagick
  result = await convertEpsToPngImageMagick(inputPath, outputPath, options);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// TikZ to PNG Rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Common custom colors used in HEP papers
 * These are defined to avoid "Undefined color" errors when rendering TikZ diagrams
 */
const COMMON_CUSTOM_COLORS = `
% Common grayscale shades
\\definecolor{verylightgray}{gray}{0.9}
\\definecolor{lightgray}{gray}{0.8}
\\definecolor{mediumgray}{gray}{0.5}
\\definecolor{darkgray}{gray}{0.3}

% Common HEP paper colors
\\definecolor{darkblue}{RGB}{0,0,139}
\\definecolor{darkred}{RGB}{139,0,0}
\\definecolor{darkgreen}{RGB}{0,100,0}
\\definecolor{lightblue}{RGB}{173,216,230}
\\definecolor{lightred}{RGB}{255,182,193}
\\definecolor{lightgreen}{RGB}{144,238,144}
\\definecolor{orange}{RGB}{255,165,0}
\\definecolor{purple}{RGB}{128,0,128}
\\definecolor{cyan}{RGB}{0,255,255}
\\definecolor{magenta}{RGB}{255,0,255}
\\definecolor{brown}{RGB}{139,69,19}
\\definecolor{olive}{RGB}{128,128,0}
\\definecolor{teal}{RGB}{0,128,128}
\\definecolor{navy}{RGB}{0,0,128}
\\definecolor{maroon}{RGB}{128,0,0}

% RevTeX/APS style colors
\\definecolor{apsblue}{RGB}{0,51,102}
\\definecolor{apsred}{RGB}{153,0,0}
`;

/**
 * Wrap TikZ source in a standalone LaTeX document
 * 
 * Includes comprehensive package support for:
 * - xcolor with dvipsnames,svgnames,x11names for maximum color support
 * - Common TikZ libraries for arrows, shapes, decorations, etc.
 * - pgfplots for data visualization
 * - amsmath/amssymb for math symbols
 * - Pre-defined custom colors commonly used in HEP papers
 */
function wrapTikzStandalone(tikzSource: string): string {
  // Check if it's already a complete tikzpicture environment
  const hasTikzEnv = /\\begin\{tikzpicture\}/i.test(tikzSource);
  
  const content = hasTikzEnv ? tikzSource : `\\begin{tikzpicture}\n${tikzSource}\n\\end{tikzpicture}`;
  
  return `\\documentclass[tikz,border=5pt]{standalone}

% Color support with all standard color names
\\usepackage[dvipsnames,svgnames,x11names]{xcolor}

% Math packages
\\usepackage{amsmath}
\\usepackage{amssymb}

% TikZ and pgfplots
\\usepackage{tikz}
\\usepackage{pgfplots}
\\pgfplotsset{compat=1.18}

% Comprehensive TikZ libraries
\\usetikzlibrary{
  arrows,
  arrows.meta,
  shapes,
  shapes.geometric,
  shapes.symbols,
  positioning,
  calc,
  decorations,
  decorations.pathmorphing,
  decorations.pathreplacing,
  decorations.markings,
  patterns,
  backgrounds,
  fit,
  matrix,
  chains,
  scopes,
  through,
  intersections,
  fadings,
  shadows,
  trees
}

% Custom colors commonly used in HEP papers
${COMMON_CUSTOM_COLORS}

\\begin{document}
${content}
\\end{document}
`;
}

/**
 * Wrap Feynman diagram source in a standalone LaTeX document
 */
function wrapFeynmanStandalone(feynmanSource: string): string {
  return `\\documentclass[border=5pt]{standalone}
\\usepackage{feynmp-auto}
\\begin{document}
${feynmanSource}
\\end{document}
`;
}

/**
 * Wrap PSTricks source in a standalone LaTeX document
 * 
 * Note: PSTricks traditionally requires latex + dvips, not pdflatex.
 * Modern pstricks packages may work with pdflatex via auto-pst-pdf,
 * but some diagrams may fail to render correctly.
 * For best results, ensure texlive-pstricks is installed.
 */
function wrapPstricksStandalone(pstricksSource: string): string {
  const hasPspictureEnv = /\\begin\{pspicture\}/i.test(pstricksSource);
  const content = hasPspictureEnv ? pstricksSource : `\\begin{pspicture}\n${pstricksSource}\n\\end{pspicture}`;
  
  return `\\documentclass[border=5pt]{standalone}
\\usepackage{pstricks}
\\usepackage{pstricks-add}
\\begin{document}
${content}
\\end{document}
`;
}

/**
 * Render TikZ/Feynman/PSTricks diagram to PNG
 * 
 * @param source - LaTeX source code for the diagram
 * @param outputPath - Path to output PNG file
 * @param options - Rendering options
 * @returns Conversion result
 */
export async function renderLatexToPng(
  source: string,
  outputPath: string,
  options: {
    drawingType?: 'tikz' | 'feynman' | 'pstricks' | 'picture' | 'auto';
    dpi?: number;
    timeout?: number;
  } = {}
): Promise<ConversionResult> {
  const drawingType = options.drawingType ?? 'auto';
  const dpi = clamp(options.dpi ?? DEFAULT_DPI, MIN_DPI, MAX_DPI);
  const timeout = clamp(options.timeout ?? DEFAULT_LATEX_TIMEOUT, MIN_TIMEOUT, MAX_TIMEOUT);

  // Security: Check source size to prevent DoS
  if (source.length > MAX_LATEX_SOURCE_SIZE) {
    return {
      success: false,
      error: `LaTeX source too large (${source.length} bytes, max ${MAX_LATEX_SOURCE_SIZE})`,
      tool: 'pdflatex',
    };
  }

  // Check tool availability
  const tools = await checkToolAvailability();
  if (!tools.pdflatex) {
    return {
      success: false,
      error: 'pdflatex not installed - skipping LaTeX rendering',
      tool: 'pdflatex',
    };
  }
  if (!tools.pdftoppm && !tools.convert && !tools.magick) {
    return {
      success: false,
      error: 'pdftoppm or ImageMagick not installed - cannot convert PDF to PNG',
      tool: 'pdftoppm',
    };
  }

  // Create temporary directory with UUID for isolation
  const tmpDir = path.join(os.tmpdir(), `latex-render-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const texPath = path.join(tmpDir, 'diagram.tex');

  try {
    // Determine drawing type and wrap source
    let wrappedSource: string;
    let detectedType = drawingType;
    
    if (drawingType === 'auto') {
      if (/\\begin\{tikzpicture\}|\\tikz\b/i.test(source)) {
        detectedType = 'tikz';
      } else if (/\\begin\{fmfgraph\}|\\begin\{feynman\}/i.test(source)) {
        detectedType = 'feynman';
      } else if (/\\begin\{pspicture\}|\\psline|\\pscircle/i.test(source)) {
        detectedType = 'pstricks';
      } else {
        detectedType = 'tikz';  // Default to tikz
      }
    }

    switch (detectedType) {
      case 'feynman':
        wrappedSource = wrapFeynmanStandalone(source);
        break;
      case 'pstricks':
        wrappedSource = wrapPstricksStandalone(source);
        break;
      case 'tikz':
      case 'picture':
      default:
        wrappedSource = wrapTikzStandalone(source);
        break;
    }

    // Write LaTeX source
    fs.writeFileSync(texPath, wrappedSource, 'utf-8');

    // Run pdflatex
    const pdflatexResult = await runPdflatex(texPath, tmpDir, timeout);
    if (!pdflatexResult.success) {
      return {
        success: false,
        error: pdflatexResult.error,
        tool: 'pdflatex',
      };
    }

    // Convert PDF to PNG
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const pdfPath = path.join(tmpDir, 'diagram.pdf');
    const pngResult = await convertPdfToPng(pdfPath, outputPath, { dpi, timeout });
    return pngResult;

  } finally {
    // Cleanup temporary directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Run pdflatex on a .tex file
 * 
 * Security: Uses --no-shell-escape to prevent \write18 command execution
 */
async function runPdflatex(
  texPath: string,
  workDir: string,
  timeout: number
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const pdflatex = spawn('pdflatex', [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '--no-shell-escape',  // Security: Prevent \write18 command execution
      '-output-directory', workDir,
      texPath,
    ], {
      cwd: workDir,
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    pdflatex.stdout?.on('data', (data) => {
      // Security: Limit output size
      if (output.length < MAX_OUTPUT_SIZE) {
        output += data.toString().slice(0, MAX_OUTPUT_SIZE - output.length);
      }
    });
    pdflatex.stderr?.on('data', (data) => {
      if (output.length < MAX_OUTPUT_SIZE) {
        output += data.toString().slice(0, MAX_OUTPUT_SIZE - output.length);
      }
    });

    pdflatex.on('close', (code) => {
      const pdfPath = texPath.replace(/\.tex$/, '.pdf');
      if (code === 0 && fs.existsSync(pdfPath)) {
        resolve({ success: true });
      } else {
        // Extract error message from LaTeX output
        const errorMatch = output.match(/! (.+?)(?:\n|$)/);
        const errorMsg = errorMatch ? errorMatch[1] : `pdflatex exited with code ${code}`;
        resolve({ success: false, error: errorMsg?.slice(0, 200) });
      }
    });

    pdflatex.on('error', (err) => {
      resolve({ success: false, error: `pdflatex error: ${err.message}` });
    });
  });
}

/**
 * Convert PDF to PNG using pdftoppm or ImageMagick
 */
async function convertPdfToPng(
  pdfPath: string,
  outputPath: string,
  options: { dpi: number; timeout: number }
): Promise<ConversionResult> {
  const { dpi, timeout } = options;
  const tools = await checkToolAvailability();

  // Try pdftoppm first (better quality)
  if (tools.pdftoppm) {
    const result = await convertPdfToPngPdftoppm(pdfPath, outputPath, dpi, timeout);
    if (result.success) return result;
  }

  // Fall back to ImageMagick (v6 convert or v7 magick)
  if (tools.convert || tools.magick) {
    return convertPdfToPngImageMagick(pdfPath, outputPath, dpi, timeout);
  }

  return {
    success: false,
    error: 'No PDF to PNG converter available',
  };
}

async function convertPdfToPngPdftoppm(
  pdfPath: string,
  outputPath: string,
  dpi: number,
  timeout: number
): Promise<ConversionResult> {
  // pdftoppm adds a suffix, so we need to handle that
  const outputBase = outputPath.replace(/\.png$/i, '');
  
  return new Promise((resolve) => {
    const pdftoppm = spawn('pdftoppm', [
      '-png',
      '-r', String(dpi),
      '-singlefile',
      pdfPath,
      outputBase,
    ], {
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    pdftoppm.stderr?.on('data', (data) => {
      // Security: Limit stderr size
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += data.toString().slice(0, MAX_OUTPUT_SIZE - stderr.length);
      }
    });

    pdftoppm.on('close', (code) => {
      // pdftoppm creates file with .png extension
      const actualOutput = `${outputBase}.png`;
      
      if (code === 0 && fs.existsSync(actualOutput)) {
        // Rename if needed
        if (actualOutput !== outputPath) {
          try {
            fs.renameSync(actualOutput, outputPath);
          } catch {
            // If rename fails, just use the actual output path
          }
        }
        resolve({ success: true, outputPath, tool: 'pdftoppm' });
      } else {
        resolve({
          success: false,
          error: `pdftoppm exited with code ${code}: ${stderr.slice(0, 200)}`,
          tool: 'pdftoppm',
        });
      }
    });

    pdftoppm.on('error', (err) => {
      resolve({
        success: false,
        error: `pdftoppm error: ${err.message}`,
        tool: 'pdftoppm',
      });
    });
  });
}

async function convertPdfToPngImageMagick(
  pdfPath: string,
  outputPath: string,
  dpi: number,
  timeout: number
): Promise<ConversionResult> {
  const tools = await checkToolAvailability();
  const imCmd = getImageMagickCommand(tools);
  if (!imCmd) {
    return {
      success: false,
      error: 'ImageMagick not available',
      tool: 'imagemagick',
    };
  }

  const toolName = imCmd.cmd === 'magick' ? 'magick' : 'convert';

  return new Promise((resolve) => {
    const convert = spawn(imCmd.cmd, [
      ...imCmd.args,
      '-density', String(dpi),
      `${pdfPath}[0]`,  // First page only
      '-flatten',
      outputPath,
    ], {
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    convert.stderr?.on('data', (data) => {
      // Security: Limit stderr size
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += data.toString().slice(0, MAX_OUTPUT_SIZE - stderr.length);
      }
    });

    convert.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ success: true, outputPath, tool: toolName });
      } else {
        resolve({
          success: false,
          error: `${toolName} exited with code ${code}: ${stderr.slice(0, 200)}`,
          tool: toolName,
        });
      }
    });

    convert.on('error', (err) => {
      resolve({
        success: false,
        error: `${toolName} error: ${err.message}`,
        tool: toolName,
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch Conversion Utilities
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchConversionResult {
  total: number;
  converted: number;
  skipped: number;
  failed: number;
  results: Array<{
    input: string;
    output?: string;
    success: boolean;
    error?: string;
    tool?: string;
  }>;
  toolsAvailable: ToolAvailability;
}

/**
 * Batch convert multiple EPS/PS files to PNG
 */
export async function batchConvertEpsToPng(
  files: Array<{ input: string; output: string }>,
  options: { dpi?: number; timeout?: number; concurrency?: number } = {}
): Promise<BatchConversionResult> {
  const { concurrency = 4 } = options;
  const toolsAvailable = await checkToolAvailability();
  
  const results: BatchConversionResult['results'] = [];
  let converted = 0;
  let skipped = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ input, output }) => {
        const result = await convertEpsToPngAuto(input, output, options);
        return { input, output: result.outputPath, ...result };
      })
    );

    for (const result of batchResults) {
      results.push(result);
      if (result.success) {
        converted++;
      } else if (result.error?.includes('not installed')) {
        skipped++;
      } else {
        failed++;
      }
    }
  }

  return {
    total: files.length,
    converted,
    skipped,
    failed,
    results,
    toolsAvailable,
  };
}
