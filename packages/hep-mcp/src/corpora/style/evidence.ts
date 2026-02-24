import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import pLimit from 'p-limit';
import { latexParser } from 'latex-utensils';

import * as api from '../../api/client.js';
import { ensureDir } from '../../data/dataDir.js';
import { resolvePathWithinParent } from '../../data/pathGuard.js';
import {
  checkToolAvailability,
  convertEpsToPngAuto,
  renderLatexToPng,
} from '../../utils/imageConverter.js';
import {
  extractBibliography,
  extractCitations,
  extractEquations,
  extractFigures,
  extractTables,
  extractText,
  stringifyLatexNodes,
  buildMacroWrappedEnvironmentPairsFromRegistry,
  matchMacroWrappedEnvironmentAt,
  mapLocatorToSource,
  mergeProjectContentWithSourceMap,
  nodeToLocator,
  parseLatex,
  type FileContentProvider,
  type LatexAst,
  type LatexNode,
  type Locator,
  type SourceMap,
} from '../../tools/research/latex/index.js';
import { mapBibEntryToInspire } from '../../tools/research/latex/citekeyMapper.js';
import { scanPreambleForMacros } from '../../tools/research/latex/parserHarness.js';

import type { StyleCorpusManifestEntry } from './schemas.js';
import { getCorpusDir, getCorpusEvidenceDir } from './paths.js';
import { paperKeyForRecid } from './paperKey.js';
import { splitSentences, stripLatexPreserveHEP } from '../../tools/writing/rag/hepTokenizer.js';
import { normalizeTextPreserveUnits } from '../../utils/textNormalization.js';
import { UNIT_CONVERSIONS } from '../../tools/research/config.js';
import { matchIntents } from './intentSignals.js';

export type CorpusEvidenceType =
  | 'title'
  | 'abstract'
  | 'section'
  | 'paragraph'
  | 'sentence'
  | 'equation'
  | 'figure'
  | 'table'
  | 'citation_context';

export interface CorpusLatexLocatorV1 {
  kind: 'latex';
  file: string;
  offset: number;
  line: number;
  column: number;
  endOffset?: number;
  endLine?: number;
  endColumn?: number;
  anchor?: {
    before: string;
    after: string;
  };
}

export interface CorpusEvidenceItemV1 {
  version: 1;
  style_id: string;
  recid: string;
  paper_key: string;
  type: CorpusEvidenceType;
  evidence_id: string;
  locator: CorpusLatexLocatorV1;
  text: string;
  normalized_text?: string;
  citations?: string[];
  meta?: Record<string, unknown>;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeText(text: string): string {
  return normalizeTextPreserveUnits(text);
}

function normalizePathForCatalog(relPath: string): string {
  const normalized = relPath.split(path.sep).join('/');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function buildEvidenceId(paperKey: string, type: CorpusEvidenceType, locator: CorpusLatexLocatorV1, text: string): string {
  const material = JSON.stringify({
    paper_key: paperKey,
    type,
    locator: {
      file: locator.file,
      offset: locator.offset,
      endOffset: locator.endOffset,
      anchor: locator.anchor,
    },
    text_preview: text.slice(0, 200),
  });
  return `sev_${paperKey}_${type}_${sha256Hex(material).slice(0, 16)}`;
}

function mergeSpanLocator(start: Locator, end: Locator): Locator {
  const endOffset = end.endOffset ?? end.offset;
  const endLine = end.endLine ?? end.line;
  const endColumn = end.endColumn ?? end.column;
  return { ...start, endOffset, endLine, endColumn };
}

function mapLocatorToCorpusLocator(
  locator: Locator,
  sourceMap: SourceMap,
  getFileContent: FileContentProvider,
  extractedRoot: string
): CorpusLatexLocatorV1 {
  const mapped = mapLocatorToSource(locator, sourceMap, getFileContent);
  const rel = path.relative(extractedRoot, mapped.file);
  if (rel.startsWith('..')) {
    throw new Error(`Mapped locator points outside extracted root: ${mapped.file}`);
  }
  return {
    kind: 'latex',
    file: normalizePathForCatalog(rel),
    offset: mapped.offset,
    line: mapped.line,
    column: mapped.column,
    endOffset: mapped.endOffset,
    endLine: mapped.endLine,
    endColumn: mapped.endColumn,
    anchor: mapped.anchor,
  };
}

function hasLocation(node: LatexNode): boolean {
  return Boolean((node as { location?: { start?: { offset?: number } } }).location?.start?.offset !== undefined);
}

function firstLocated(nodes: LatexNode[]): LatexNode | null {
  for (const node of nodes) {
    if (hasLocation(node)) return node;
  }
  return null;
}

function lastLocated(nodes: LatexNode[]): LatexNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node && hasLocation(node)) return node;
  }
  return null;
}

function getDocumentContent(ast: LatexAst): LatexNode[] {
  if (ast.kind !== 'ast.root') return [];
  for (const node of ast.content) {
    if (latexParser.isEnvironment(node) && node.name === 'document') {
      return node.content;
    }
  }
  // Scorched-earth: if we cannot locate the document environment, do not fall back
  // to scanning the preamble (this is a common source of macro/metadata leakage).
  return [];
}

function findFirstCommandRecursive(nodes: LatexNode[], name: string): LatexNode | null {
  for (const node of nodes) {
    if (latexParser.isCommand(node) && node.name === name) return node;
    if (latexParser.isEnvironment(node)) {
      const found = findFirstCommandRecursive(node.content, name);
      if (found) return found;
    }
    if (latexParser.isGroup(node)) {
      const found = findFirstCommandRecursive(node.content, name);
      if (found) return found;
    }
  }
  return null;
}

function findFirstEnvironmentRecursive(nodes: LatexNode[], name: string): LatexNode | null {
  for (const node of nodes) {
    if (latexParser.isEnvironment(node) && node.name === name) return node;
    if (latexParser.isEnvironment(node)) {
      const found = findFirstEnvironmentRecursive(node.content, name);
      if (found) return found;
    }
    if (latexParser.isGroup(node)) {
      const found = findFirstEnvironmentRecursive(node.content, name);
      if (found) return found;
    }
  }
  return null;
}

function canonicalizeMath(latex: string): string {
  return latex
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\tag\*?\{[^}]*\}/g, '')
    .replace(/\\(nonumber|notag)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMathSignals(canonical: string): { symbols: string[]; operators: string[] } {
  const commands = canonical.match(/\\[A-Za-z]+/g) ?? [];
  const letters = canonical.match(/\b[A-Za-z]\b/g) ?? [];
  const rawSymbols = [...commands.map(s => s.slice(1)), ...letters];
  const blacklist = new Set<string>([
    'left',
    'right',
    'big',
    'bigg',
    'text',
    'mbox',
    'mathrm',
    'mathbf',
    'mathcal',
    'cal',
    'it',
    'begin',
    'end',
    'label',
    'nonumber',
    'notag',
    'tag',
    'vspace',
    'hspace',
    'quad',
    'qquad',
  ]);

  const symbols = Array.from(new Set(rawSymbols))
    .filter((s) => !blacklist.has(s.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const ops: string[] = [];
  const opPatterns: Array<[RegExp, string]> = [
    [/\\to\b/g, '->'],
    [/\\rightarrow\b/g, '->'],
    [/\\leftrightarrow\b/g, '<->'],
    [/\\approx\b/g, '~'],
    [/\\sim\b/g, '~'],
    [/\\pm\b/g, '±'],
    [/<=|>=|!=|===/g, 'cmp'],
    [/=+/g, '='],
    [/\+/g, '+'],
    [/-/g, '-'],
    [/</g, '<'],
    [/>/g, '>'],
  ];

  for (const [re, token] of opPatterns) {
    if (re.test(canonical)) ops.push(token);
  }

  const operators = Array.from(new Set(ops)).sort((a, b) => a.localeCompare(b));
  return { symbols, operators };
}

function normalizeLatexCommandName(name: string): string {
  // latex-utensils may encode starred commands as e.g. "section*".
  return name.replace(/\*+$/, '').toLowerCase();
}

const MACRO_DEFINITION_COMMANDS = new Set<string>([
  'newcommand',
  'renewcommand',
  'providecommand',
  'declarerobustcommand',
  'declaremathoperator',
  'def',
  'edef',
  'gdef',
  'xdef',
  'let',
  'futurelet',
  'newenvironment',
  'renewenvironment',
  'newtheorem',
  'newif',
  'usepackage',
  'requirepackage',
  'documentclass',
  'input',
  'include',
]);

const METADATA_COMMANDS = new Set<string>([
  'title',
  'abstract',
  'author',
  'affiliation',
  'affil',
  'address',
  'institute',
  'collaboration',
  'correspondingauthor',
  'email',
  'thanks',
  'preprint',
  'date',
  'maketitle',
  'keywords',
  'keyword',
  'pacs',
  'subjclass',
]);

const METADATA_DROP_COMMANDS = new Set<string>([
  ...Array.from(METADATA_COMMANDS.values()),
  'and',
]);

const PARAGRAPH_BOUNDARY_COMMANDS = new Set<string>([
  ...MACRO_DEFINITION_COMMANDS,
  ...METADATA_COMMANDS,
  // Label-like fragments are never useful as paragraph evidence.
  'label',
  'tag',
  // Bibliography footer commands (not useful as prose evidence)
  'bibliographystyle',
  'bibliography',
]);

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDelimitedTokenRegex(tokens: string[]): RegExp {
  const escaped = Array.from(new Set(tokens))
    .filter(Boolean)
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![A-Za-z0-9μ])(?:${escaped.join('|')})(?![A-Za-z0-9μ])`, 'i');
}

const HEP_BASE_UNIT_TOKENS = [
  ...Object.keys(UNIT_CONVERSIONS.energy),
  ...Object.keys(UNIT_CONVERSIONS.mass),
  ...Object.keys(UNIT_CONVERSIONS.momentum),
  ...Object.keys(UNIT_CONVERSIONS.cross_section).filter(u => u !== 'b'),
];

const HEP_BARN_UNIT_TOKENS = Object.keys(UNIT_CONVERSIONS.cross_section).filter(u => u !== 'b');

const HEP_BASE_UNIT_DELIMITED_REGEX = buildDelimitedTokenRegex(HEP_BASE_UNIT_TOKENS);
const HEP_BASE_UNIT_GROUP = HEP_BASE_UNIT_TOKENS.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|');
const HEP_BARN_UNIT_GROUP = HEP_BARN_UNIT_TOKENS.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|');

const HEP_BASE_UNIT_AFTER_NUMBER_REGEX = new RegExp(`\\d\\s*(?:${HEP_BASE_UNIT_GROUP})`, 'i');
const HEP_INV_BARN_DELIMITED_REGEX = new RegExp(
  `(?<![A-Za-z0-9μ])(?:${HEP_BARN_UNIT_GROUP})\\^-1(?![A-Za-z0-9μ])`,
  'i'
);
const HEP_INV_BARN_AFTER_NUMBER_REGEX = new RegExp(`\\d\\s*(?:${HEP_BARN_UNIT_GROUP})\\^-1`, 'i');
const HEP_ONE_OVER_BARN_REGEX = new RegExp(`(?<![A-Za-z0-9μ])1\\/(?:${HEP_BARN_UNIT_GROUP})(?![A-Za-z0-9μ])`, 'i');

function hasHepUnitSignal(text: string): boolean {
  return (
    HEP_BASE_UNIT_DELIMITED_REGEX.test(text) ||
    HEP_BASE_UNIT_AFTER_NUMBER_REGEX.test(text) ||
    HEP_INV_BARN_DELIMITED_REGEX.test(text) ||
    HEP_INV_BARN_AFTER_NUMBER_REGEX.test(text) ||
    HEP_ONE_OVER_BARN_REGEX.test(text)
  );
}

function hasHepQuantSignal(rawLatex: string, text: string): boolean {
  const raw = rawLatex;
  const t = text;
  return (
    /\\(pm|sigma|alpha|Lambda)\b/.test(raw) ||
    /\\%/.test(raw) ||
    /\\(GeV|TeV|MeV|keV|eV|fb|pb|nb|mb|ub|mub|ab|barn)\b/.test(raw) ||
    /±/.test(t) ||
    hasHepUnitSignal(t) ||
    /\bsigma\b/i.test(t) ||
    /%/.test(t) ||
    /\balpha_s\b/i.test(t) ||
    /\blambda\b/i.test(t)
  );
}

function hasHepNarrativeSignal(text: string): boolean {
  const t = text;
  return /\b(however|in contrast|in this review|in this work|in this paper|the main challenge)\b/i.test(t);
}

function looksLikeEmailLine(text: string): boolean {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text);
}

function looksLikeLatexLabelKey(text: string): boolean {
  // Common LaTeX label patterns: "sec:intro", "fig:1", "eq:einstein", etc.
  return /^[A-Za-z]{2,}:[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text.trim());
}

type NoiseParagraphReason =
  | 'macro_definition'
  | 'email'
  | 'label_key'
  | 'draft_marker'
  | 'too_short'
  | 'symbol_heavy';

function getNoiseParagraphReason(rawLatex: string, text: string): NoiseParagraphReason | null {
  const trimmed = text.trim();
  if (!trimmed) return 'too_short';

  // Scorched-earth: any email-ish pattern is noise (even if stripping partially removed it).
  if (/@/.test(trimmed)) return 'email';

  const rawTrimmed = rawLatex.trim();
  if (/^\\(?:newcommand|renewcommand|providecommand|def|edef|gdef|xdef|let|usepackage|RequirePackage|documentclass)\b/i.test(rawTrimmed)) {
    return 'macro_definition';
  }

  // Macro definition residue in extracted text is always noise.
  if (/\\(?:newcommand|renewcommand|providecommand|def|edef|gdef|xdef|newenvironment|renewenvironment)\b/i.test(trimmed)) {
    return 'macro_definition';
  }
  if (/#\d/.test(trimmed)) return 'macro_definition';

  // PACS/Keywords blocks are metadata, never prose evidence.
  if (/^(PACS numbers:|PACS:|Keywords:)\b/i.test(trimmed)) return 'macro_definition';

  if (looksLikeEmailLine(trimmed)) return 'email';
  if (looksLikeLatexLabelKey(trimmed)) return 'label_key';
  // Isolated label-like tokens inside otherwise short text are noise as well.
  if (/\b(?:fig|eq|sec|tab|tbl|app|thm|lem|prop|cor):[A-Za-z0-9][A-Za-z0-9._:-]*\b/i.test(trimmed) && trimmed.length < 80) {
    return 'label_key';
  }
  // Editorial leftovers: if these survive stripping, drop the paragraph.
  if (/(^|\s)\[[A-Z]{2,4}:\s/.test(trimmed)) return 'draft_marker';
  if (/\bTODO\b/i.test(trimmed)) return 'draft_marker';
  if (/\bFIXME\b/i.test(trimmed)) return 'draft_marker';

  const hepSignal = hasHepQuantSignal(rawLatex, trimmed) || hasHepNarrativeSignal(trimmed);

  if (trimmed.length < 40 && !hepSignal) return 'too_short';

  // Symbol-heavy fragments are usually layout remnants.
  const special = (trimmed.match(/[^A-Za-z0-9\s]/g) ?? []).length;
  const specialRatio = special / Math.max(1, trimmed.length);
  if (specialRatio > 0.45 && !hepSignal) return 'symbol_heavy';

  return null;
}

function classifySentence(sentence: string): string[] {
  const s = sentence;
  const lower = s.toLowerCase();

  const tags = new Set<string>();

  // Quantitative: contains numerical measurements with uncertainty
  const hasNumber = /\d/.test(s);
  const hasUncertainty = /±|\\pm|\b(stat|syst|systematic|uncertainty|uncertainties)\b/i.test(s);
  const hasSigma = /(\d+(\.\d+)?)\s*σ|\b\d+\s*sigma\b|\b\d+sigma\b|\bsignificance\b/i.test(s);
  const hasCl = /\b(90|95|68)\s*%?\s*cl\b|\bconfidence level\b|\bconf(?:idence)?\b/i.test(s);
  if (hasNumber && (hasUncertainty || hasSigma || hasCl)) tags.add('quantitative');

  // Experiment: mentions experimental apparatus, collaborations, or data
  const hasExpUnits = hasHepUnitSignal(s);
  const hasExperimentWords = /\b(detector|luminosity|dataset|data set|events?|trigger|selection|collider|run\s*\d)\b/i.test(lower);
  const hasExperiments = /\b(atlas|cms|lhcb|alice|star|belle|babar|besiii|cdf|d0|cleo|focus|na\d+|e\d{3}|bes|kloe)\b/i.test(lower);
  if (hasExpUnits || hasExperimentWords || hasExperiments) tags.add('experiment');

  // Theory: mentions theoretical frameworks or calculations
  const hasTheoryWords = /\b(assume|assumption|approximation|effective field theory|eft|expansion|leading order|next-to-leading|nlo|nnlo|perturbative|renormal)\b/i.test(lower);
  const hasLattice = /\b(lattice|monte carlo|gauge theory)\b/i.test(lower);
  if (hasTheoryWords || hasLattice) tags.add('theory');

  // Phenomenology: connects theory to observables
  const hasPhenoWords = /\b(phenomenolog|model.?independent|observable|predict|extract|fit|constrain)\b/i.test(lower);
  const hasDecayModes = /\b(decay|branch|ratio|width|lifetime|amplitude)\b/i.test(lower);
  if (hasPhenoWords || (hasDecayModes && hasNumber)) tags.add('phenomenology');

  // Comparison: contrasts different results or approaches
  const hasComparisonWords = /\b(compar|versus|vs\.?|contrast|differ|agree|disagree|consistent|inconsistent|tension|discrepan)\b/i.test(lower);
  if (hasComparisonWords) tags.add('comparison');

  // Review: historical or summary statements
  const hasReviewWords = /\b(review|summar|overview|progress|development|history|early|pioneer|seminal|landmark)\b/i.test(lower);
  const hasYearRange = /\d{4}\s*[-–]\s*\d{4}|\bsince\s+\d{4}\b|\bfrom\s+\d{4}\b/i.test(s);
  if (hasReviewWords || hasYearRange) tags.add('review');

  // Limitation: discusses limitations or caveats
  const hasLimitationWords = /\b(limit|caveat|assumption|approximate|neglect|ignore|simplif|uncertai|error|bias|systematic)\b/i.test(lower);
  const hasLimitationContext = /\b(however|although|but|while|whereas|despite|nevertheless)\b/i.test(lower);
  if (hasLimitationWords && hasLimitationContext) tags.add('limitation');

  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

function classifyIntents(text: string): string[] {
  const s = text;
  const lower = s.toLowerCase();

  const intents = new Set<string>();

  // ═══════════════════════════════════════════════════════════════════════════════
  // Data-driven Intent Matching (75+ physics-specific intents)
  // ═══════════════════════════════════════════════════════════════════════════════
  const dataMatched = matchIntents(text);
  for (const intent of dataMatched) {
    intents.add(intent);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Legacy Intents with Special Handling (preserved for backwards compatibility)
  // ═══════════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // Measurement Intent (strict rules to avoid false positives)
  // ─────────────────────────────────────────────────────────────────────────────
  const hasQuantitativeNumber = /\d+(\.\d+)?\s*[±×]\s*\d/.test(s) || /\d+\.\d{2,}/.test(s);
  const hasUncertainty = /±|\\pm|\b(stat|syst)(\.|ematic)?\s*(error|uncert)/i.test(s);
  const hasSigma = /(\d+(\.\d+)?)\s*σ|\b\d+\s*sigma\b|\bsignificance\s*of\s*\d/i.test(s);
  const hasCl = /\b(90|95|68)\s*%\s*(c\.?l\.?|confidence)/i.test(s);
  const hasUnits = hasHepUnitSignal(s);
  const hasMeasurementVerb = /\b(measured?|observ(ed|ation)|extract(ed|ion)|yield(s|ed)?)\b/i.test(lower);
  const hasHistoricalPattern = /\(\s*\d{4}\s*\)|\b(proposed|conjecture|review|theory|suggest)\b/i.test(s);

  if (hasUnits && (hasUncertainty || hasSigma || hasCl) && hasQuantitativeNumber) {
    intents.add('measurement');
  } else if (hasMeasurementVerb && hasUnits && hasQuantitativeNumber && !hasHistoricalPattern) {
    intents.add('measurement');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Systematic Uncertainty Intent
  // ─────────────────────────────────────────────────────────────────────────────
  if (/\b(systematic|syst\.)\s*(error|uncert|effect)/i.test(lower)) {
    intents.add('systematic_uncertainty');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Theory Intro Intent
  // ─────────────────────────────────────────────────────────────────────────────
  const hasIntroPhrase = /\b(in this review|this review|we review|in this paper|in this work|we (present|discuss|study|investigate))\b/i.test(lower);
  const hasTheoryWords = /\b(effective field theory|eft|lagrangian|chiral|renormal|perturbative|nlo|nnlo|coupling|symmetry|unitar|dispersive)\b/i.test(lower);
  if (hasTheoryWords && (hasIntroPhrase || /\b(theory|theoretical)\b/i.test(lower))) {
    intents.add('theory_intro');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Comparison Intent: contrasts results from different sources
  // ─────────────────────────────────────────────────────────────────────────────
  const hasComparisonVerb = /\b(compar|contrast|versus|vs\.?)\b/i.test(lower);
  const hasAgreementWords = /\b(agree|consistent|compatible|confirm|support)\b/i.test(lower);
  const hasDisagreementWords = /\b(disagree|inconsistent|tension|discrepan|conflict|contradict)\b/i.test(lower);
  if (hasComparisonVerb || ((hasAgreementWords || hasDisagreementWords) && hasQuantitativeNumber)) {
    intents.add('comparison');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Historical Review Intent: discusses development of the field
  // ─────────────────────────────────────────────────────────────────────────────
  const hasHistoricalWords = /\b(history|historical|early|pioneer|seminal|landmark|first|original|discover|found)\b/i.test(lower);
  const hasYearPattern = /\b(19[0-9]{2}|20[0-2][0-9])\b/.test(s);
  const hasProgressWords = /\b(progress|development|evolution|advance|milestone)\b/i.test(lower);
  if ((hasHistoricalWords && hasYearPattern) || (hasProgressWords && hasYearPattern)) {
    intents.add('historical_review');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Methodology Intent: describes experimental or theoretical methods
  // ─────────────────────────────────────────────────────────────────────────────
  const hasMethodWords = /\b(method|technique|approach|procedure|algorithm|formalism|framework|scheme|prescription)\b/i.test(lower);
  const hasAnalysisWords = /\b(analys|fit|extract|determin|calculat|comput|evaluat|estimat)\b/i.test(lower);
  if (hasMethodWords || (hasAnalysisWords && /\b(using|based on|employ|apply)\b/i.test(lower))) {
    intents.add('methodology');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Limitation Intent: discusses caveats or limitations
  // ─────────────────────────────────────────────────────────────────────────────
  const hasLimitWords = /\b(limit|caveat|restrict|constrain|bound|assumption|approximat|neglect|ignore)\b/i.test(lower);
  const hasCautionContext = /\b(however|although|while|but|yet|nevertheless|note that|caution|care)\b/i.test(lower);
  if (hasLimitWords && hasCautionContext) {
    intents.add('limitation');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Future Direction Intent: discusses open questions or future work
  // ─────────────────────────────────────────────────────────────────────────────
  const hasFutureWords = /\b(future|remain|open|outstand|challeng|prospect|outlook|need|requir)\b/i.test(lower);
  const hasQuestionPattern = /\b(question|problem|puzzle|mystery|issue|unexplain)\b/i.test(lower);
  if (hasFutureWords || (hasQuestionPattern && /\b(still|yet|remain)\b/i.test(lower))) {
    intents.add('future_direction');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Definition Intent: provides definitions or explanations
  // ─────────────────────────────────────────────────────────────────────────────
  const hasDefinitionPattern = /\b(defin|refer to|denot|called|known as|termed|mean|represent)\b/i.test(lower);
  const hasEquationRef = /\b(eq\.|equation|formula|expression|relation)\s*\(?[\d\.]+\)?/i.test(lower);
  if (hasDefinitionPattern || hasEquationRef) {
    intents.add('definition');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // General Intent: if no specific intent matched
  // ─────────────────────────────────────────────────────────────────────────────
  if (intents.size === 0) {
    intents.add('general');
  }

  return Array.from(intents).sort((a, b) => a.localeCompare(b));
}

// ─────────────────────────────────────────────────────────────────────────────
// Author-Year Citation Extraction (for older papers without \cite{} macros)
// ─────────────────────────────────────────────────────────────────────────────

interface AuthorYearCitation {
  /** Matched author-year text (e.g., "Weinberg (1980)") */
  match: string;
  /** Extracted author names */
  authors: string[];
  /** Extracted year */
  year: string;
  /** Position in the source text */
  position: number;
  /** Context around the citation */
  context: string;
}

/**
 * Extract author-year style citations from text.
 * Matches patterns like:
 * - "Weinberg (1980)"
 * - "Salam and Weinberg (1980)"
 * - "Green, Schwarz, and Witten (1987)"
 * - "Polchinski et al. (2001)"
 * - "Manohar and Wise (2000)"
 */
function extractAuthorYearCitations(text: string, contextWindow = 150): AuthorYearCitation[] {
  const results: AuthorYearCitation[] = [];

  // Pattern 1: "Author (year)" - single author
  // Pattern 2: "Author and Author (year)" - two authors
  // Pattern 3: "Author, Author, and Author (year)" - multiple authors
  // Pattern 4: "Author et al. (year)" - abbreviated
  const patterns = [
    // Single author: "Weinberg (1980)"
    /\b([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\s*\(\s*(\d{4}[a-z]?)\s*\)/g,
    // Two authors: "Salam and Weinberg (1980)" or "Salam & Weinberg (1980)"
    /\b([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\s+(?:and|&)\s+([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\s*\(\s*(\d{4}[a-z]?)\s*\)/g,
    // et al.: "Polchinski et al. (2001)"
    /\b([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\s+et\s+al\.?\s*\(\s*(\d{4}[a-z]?)\s*\)/g,
    // Three+ authors: "Green, Schwarz, and Witten (1987)"
    /\b([A-Z][a-z]+(?:-[A-Z][a-z]+)?(?:\s*,\s*[A-Z][a-z]+(?:-[A-Z][a-z]+)?)+\s*,?\s*and\s+[A-Z][a-z]+(?:-[A-Z][a-z]+)?)\s*\(\s*(\d{4}[a-z]?)\s*\)/g,
  ];

  // Dedupe by position to avoid overlapping matches
  const seenPositions = new Set<number>();

  for (const pattern of patterns) {
    // Reset lastIndex since we reuse patterns
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const pos = m.index;
      // Skip if we already have a citation at this position
      if (seenPositions.has(pos)) continue;
      seenPositions.add(pos);

      // Extract authors and year based on which pattern matched
      let authors: string[];
      let year: string;

      if (m.length === 3) {
        // Single author or et al. pattern
        authors = [m[1]!];
        year = m[2]!;
      } else if (m.length === 4) {
        // Two-author pattern
        authors = [m[1]!, m[2]!];
        year = m[3]!;
      } else {
        // Multi-author comma pattern - parse authors from the full match
        const authorPart = m[1]!;
        authors = authorPart
          .split(/\s*,\s*|\s+and\s+/)
          .map(a => a.trim())
          .filter(a => /^[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/.test(a));
        year = m[2]!;
      }

      // Extract context
      const contextStart = Math.max(0, pos - contextWindow);
      const contextEnd = Math.min(text.length, pos + m[0].length + contextWindow);
      let context = text.slice(contextStart, contextEnd);
      // Try to align to sentence boundaries
      if (contextStart > 0) {
        const sentStart = context.indexOf('. ');
        if (sentStart > 0 && sentStart < contextWindow / 2) {
          context = context.slice(sentStart + 2);
        }
      }
      if (contextEnd < text.length) {
        const sentEnd = context.lastIndexOf('. ');
        if (sentEnd > contextWindow && sentEnd < context.length - 1) {
          context = context.slice(0, sentEnd + 1);
        }
      }

      results.push({
        match: m[0],
        authors,
        year,
        position: pos,
        context: context.replace(/\s+/g, ' ').trim(),
      });
    }
  }

  // Sort by position
  return results.sort((a, b) => a.position - b.position);
}

/**
 * Check if a citation context text significantly overlaps with any sentence text.
 * Returns true if >50% of words overlap.
 */
function checkTextOverlap(citationText: string, sentenceTexts: Set<string>): boolean {
  const normalizedCitation = citationText.toLowerCase().replace(/[^\w\s]/g, '');
  const citationWords = new Set(normalizedCitation.split(/\s+/).filter(w => w.length > 2));

  for (const sentenceText of sentenceTexts) {
    const normalizedSentence = sentenceText.toLowerCase().replace(/[^\w\s]/g, '');
    const sentenceWords = new Set(normalizedSentence.split(/\s+/).filter(w => w.length > 2));

    let overlap = 0;
    for (const w of citationWords) {
      if (sentenceWords.has(w)) overlap++;
    }

    // If >50% of citation words appear in the sentence, consider it overlapping
    if (citationWords.size > 0 && overlap / citationWords.size > 0.5) {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Citation Intent Classification
// ─────────────────────────────────────────────────────────────────────────────

export type CitationIntent =
  | 'support'       // Citation supports the current claim
  | 'contrast'      // Citation presents contrasting/opposing view
  | 'background'    // Citation provides background information
  | 'methodology'   // Citation describes method being used
  | 'extension'     // Citation extends or builds upon previous work
  | 'comparison'    // Citation used for comparison
  | 'definition';   // Citation provides definition or establishes terminology

/**
 * Classify the intent of a citation based on its surrounding context.
 * Returns the most likely intent(s) for the citation.
 */
function classifyCitationIntent(context: string): CitationIntent[] {
  const lower = context.toLowerCase();
  const intents: CitationIntent[] = [];

  // Support patterns: citation confirms or agrees with claim
  const supportPatterns = /\b(confirm|support|agree|consistent|accord|line with|showed|demonstrated|found|established|proved|verif)\b/i;
  const supportContext = /\b(as (shown|demonstrated|established|found|proved) (by|in)|in agreement with|consistent with|supported by)\b/i;
  if (supportPatterns.test(lower) || supportContext.test(lower)) {
    intents.push('support');
  }

  // Contrast patterns: citation presents opposing or different view
  const contrastPatterns = /\b(however|contrast|unlike|differ|disagree|inconsistent|tension|conflict|contradict|challeng|dispute|question|critic)\b/i;
  const contrastContext = /\b(in contrast (to|with)|different from|unlike|contrary to|at odds with|in tension with)\b/i;
  if (contrastPatterns.test(lower) || contrastContext.test(lower)) {
    intents.push('contrast');
  }

  // Background patterns: citation provides context or introduction
  const backgroundPatterns = /\b(review|overview|introduc|background|history|context|seminal|pioneer|early|original)\b/i;
  const backgroundContext = /\b(for (a|an) (review|overview|introduction)|see (also )?ref|following|according to)\b/i;
  if (backgroundPatterns.test(lower) || backgroundContext.test(lower)) {
    intents.push('background');
  }

  // Methodology patterns: citation describes technique or approach
  const methodPatterns = /\b(method|technique|approach|procedure|formalism|framework|algorithm|calculat|comput|follow|use|employ|apply|adopt)\b/i;
  const methodContext = /\b(using the (method|approach|technique|formalism)|based on|following (the method|approach)|as (described|outlined) in)\b/i;
  if (methodPatterns.test(lower) && methodContext.test(lower)) {
    intents.push('methodology');
  }

  // Extension patterns: citation builds upon or extends previous work
  const extensionPatterns = /\b(extend|generaliz|improv|refin|enhanc|develop|build upon|go beyond|modif)\b/i;
  const extensionContext = /\b(extend(ing|ed|s)? (the|this)|building on|generaliz(ing|ed|ation) of|improvement (on|over))\b/i;
  if (extensionPatterns.test(lower) || extensionContext.test(lower)) {
    intents.push('extension');
  }

  // Comparison patterns: citation used for explicit comparison
  const comparisonPatterns = /\b(compar|versus|vs\.?|relative to|ratio|benchmark)\b/i;
  const comparisonContext = /\b(compar(e|ed|ing|ison) (with|to)|versus|vs\.?|in comparison (to|with))\b/i;
  if (comparisonPatterns.test(lower) || comparisonContext.test(lower)) {
    intents.push('comparison');
  }

  // Definition patterns: citation establishes terminology or definitions
  const definitionPatterns = /\b(defin|call|term|refer to|denot|known as|nomenclature|convention)\b/i;
  const definitionContext = /\b(as defined (in|by)|following the (definition|convention|nomenclature)|we (use|adopt|follow) the (definition|convention))\b/i;
  if (definitionPatterns.test(lower) || definitionContext.test(lower)) {
    intents.push('definition');
  }

  // Default to background if no specific intent detected
  if (intents.length === 0) {
    intents.push('background');
  }

  return intents;
}

function listBibFilesRecursively(rootDir: string, maxFiles = 20): string[] {
  const out: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (out.length >= maxFiles) break;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (ent.isFile() && ent.name.toLowerCase().endsWith('.bib')) {
        out.push(abs);
      }
    }
  }

  return out.sort((a, b) => a.localeCompare(b));
}

async function buildCitekeyMap(params: {
  ast: LatexAst;
  extractedRoot: string;
  map_to_inspire: boolean;
  concurrency?: number;
}): Promise<{ bibKeyToCitekey: Map<string, string>; bibKeyToRecid: Map<string, string> }> {
  const bibFiles = listBibFilesRecursively(params.extractedRoot);
  const bibContent = bibFiles
    .map(p => {
      try {
        return fs.readFileSync(p, 'utf-8');
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n');

  const entries = extractBibliography(params.ast, bibContent || undefined, { parse_bib_file: true, file: 'merged.tex' });
  const bibKeyToRecid = new Map<string, string>();
  const bibKeyToCitekey = new Map<string, string>();

  if (!params.map_to_inspire) {
    return { bibKeyToCitekey, bibKeyToRecid };
  }

  const gate = pLimit(Math.max(1, Math.min(params.concurrency ?? 4, 8)));
  const mappings = await Promise.all(entries.map(e => gate(async () => {
    const res = await mapBibEntryToInspire(e);
    return { key: e.key, mapping: res };
  })));

  const recids = new Set<string>();
  for (const m of mappings) {
    if (m.mapping.status === 'matched' && m.mapping.recid) {
      bibKeyToRecid.set(m.key, m.mapping.recid);
      recids.add(m.mapping.recid);
    }
  }

  const recidToKey = new Map<string, string>();
  const recidList = Array.from(recids.values()).sort((a, b) => a.localeCompare(b));
  const papers = await Promise.all(recidList.map(r => gate(async () => api.getPaper(r))));
  for (const p of papers) {
    if (p && typeof p.recid === 'string' && typeof p.texkey === 'string' && p.texkey.trim()) {
      recidToKey.set(p.recid, p.texkey.trim());
    }
  }

  for (const [bibKey, recid] of bibKeyToRecid.entries()) {
    const citekey = recidToKey.get(recid) ?? `inspire:${recid}`;
    bibKeyToCitekey.set(bibKey, citekey);
  }

  return { bibKeyToCitekey, bibKeyToRecid };
}

type AssetResolutionResult =
  | { status: 'resolved'; path: string }
  | { status: 'skipped'; reason: 'empty' | 'url' | 'absolute' }
  | { status: 'not_found'; triedPaths: string[] };

/**
 * Collect all directories under extractedRoot that might contain figures.
 * Limits depth to avoid excessive searching.
 */
function collectFigureSearchDirs(extractedRoot: string, maxDepth = 3): string[] {
  const dirs: string[] = [extractedRoot];
  const commonNames = new Set(['figures', 'figs', 'fig', 'images', 'img', 'graphics', 'pics', 'plots', 'artwork']);

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('.')) continue;
        const subdir = path.join(dir, ent.name);
        dirs.push(subdir);
        // Prioritize figure-related directories for deeper search
        if (commonNames.has(ent.name.toLowerCase()) || depth < 2) {
          walk(subdir, depth + 1);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(extractedRoot, 0);
  return dirs;
}

// Image file extensions for arXiv-style sequenced images
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.eps', '.ps', '.pdf']);

/**
 * Detect sequentially numbered image files in directory for arXiv-style submissions.
 * These papers have figure environments with only captions, and images are separate files
 * named like fig1.eps, fig2.eps, f1_rmp.eps, author_fig1.eps, etc.
 * 
 * Returns array of { index: number, path: string } sorted by index.
 */
function detectSequencedImages(extractedRoot: string): Array<{ index: number; path: string; filename: string }> {
  const results: Array<{ index: number; path: string; filename: string }> = [];
  
  // Multiple patterns for different naming conventions:
  // Pattern 1: fig1.eps, figure1.eps, rmpfigure1.ps, fig1-1.png, figure5a.ps, figure11b.ps
  // Pattern 2: f1_rmp.eps, f2_rmp.eps (f<number>_<suffix>)
  // Pattern 3: author_fig1.eps, xxx_fig1.eps (<prefix>_fig<number>)
  const patterns = [
    /^(fig|figure|rmpfig|rmpfigure|image|img|plot)(\d+)([a-z])?(?:-(\d+))?\.(\w+)$/i,
    /^f(\d+)[_-](\w+)\.(\w+)$/i,  // f1_rmp.eps
    /^(\w+)[_-]fig(\d+)\.(\w+)$/i,  // author_fig1.eps
  ];
  
  try {
    const entries = fs.readdirSync(extractedRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      
      let index: number | null = null;
      
      // Try pattern 1: fig1.eps, figure1.eps, figure5a.ps, fig1-1.png, etc.
      let match = ent.name.match(patterns[0]);
      if (match) {
        const mainNum = parseInt(match[2], 10);
        const letterSuffix = match[3] ? match[3].toLowerCase().charCodeAt(0) - 96 : 0; // a=1, b=2, etc.
        const subNum = match[4] ? parseInt(match[4], 10) : 0;
        // figure5a -> 5.001, figure5b -> 5.002, fig1-1 -> 1.01
        index = mainNum + (letterSuffix > 0 ? letterSuffix / 1000 : 0) + (subNum > 0 ? subNum / 100 : 0);
      }
      
      // Try pattern 2: f1_rmp.eps, f2_rmp.eps
      if (index === null) {
        match = ent.name.match(patterns[1]);
        if (match) {
          index = parseInt(match[1], 10);
        }
      }
      
      // Try pattern 3: author_fig1.eps, xxx_fig1.eps
      if (index === null) {
        match = ent.name.match(patterns[2]);
        if (match) {
          index = parseInt(match[2], 10);
        }
      }
      
      if (index !== null) {
        results.push({
          index,
          path: path.join(extractedRoot, ent.name),
          filename: ent.name,
        });
      }
    }
  } catch {
    // Ignore errors
  }
  
  // Sort by index
  results.sort((a, b) => a.index - b.index);
  return results;
}

function resolveIncludeGraphicsPath(params: {
  extractedRoot: string;
  baseDir: string;
  rawPath: string;
  graphicsPaths?: string[];
  allSearchDirs?: string[];
}): AssetResolutionResult {
  let raw = params.rawPath.trim();
  if (!raw) return { status: 'skipped', reason: 'empty' };
  if (raw.startsWith('http://') || raw.startsWith('https://')) return { status: 'skipped', reason: 'url' };
  if (path.isAbsolute(raw)) return { status: 'skipped', reason: 'absolute' };
  
  // Strip common LaTeX macro prefixes that expand to current directory
  // e.g., \fig/filename.eps -> filename.eps (when \def\fig{.})
  raw = raw.replace(/^\\[a-zA-Z]+\//, '');
  
  // Strip surrounding braces used for filenames with dots
  // e.g., {{filename.with.dots.eps}} -> filename.with.dots.eps
  raw = raw.replace(/^\{+/, '').replace(/\}+$/, '');
  
  // Strip surrounding quotes
  // e.g., "filename.pdf" -> filename.pdf
  raw = raw.replace(/^"+/, '').replace(/"+$/, '');

  // Build extension candidates - try both with and without extension
  const candidates: string[] = [];
  const ext = path.extname(raw).toLowerCase();
  if (ext) {
    candidates.push(raw);
    // Also try with different case extensions
    if (ext === '.pdf') candidates.push(raw.replace(/\.pdf$/i, '.PDF'));
    if (ext === '.png') candidates.push(raw.replace(/\.png$/i, '.PNG'));
    if (ext === '.jpg') candidates.push(raw.replace(/\.jpg$/i, '.JPG'), raw.replace(/\.jpg$/i, '.jpeg'), raw.replace(/\.jpg$/i, '.JPEG'));
  } else {
    // Try common image extensions in order of preference (both cases)
    const exts = ['.pdf', '.PDF', '.png', '.PNG', '.jpg', '.JPG', '.jpeg', '.JPEG', '.eps', '.EPS', '.epsi', '.EPSI', '.ps', '.PS', '.svg', '.SVG'];
    for (const e of exts) {
      candidates.push(`${raw}${e}`);
    }
  }

  // Build search directories in priority order
  const baseDirs: string[] = [];

  // 1. Base directory of the source file
  baseDirs.push(params.baseDir);

  // 2. Paths from \graphicspath{} command if available
  if (params.graphicsPaths) {
    for (const gp of params.graphicsPaths) {
      const resolved = path.resolve(params.extractedRoot, gp);
      if (!baseDirs.includes(resolved)) baseDirs.push(resolved);
    }
  }

  // 3. Parent directory and common subdirectories
  const parentDir = path.dirname(params.baseDir);
  if (parentDir !== params.baseDir) {
    baseDirs.push(parentDir);
    for (const subName of ['figures', 'figs', 'fig', 'images', 'img', 'graphics', 'plots']) {
      baseDirs.push(path.join(parentDir, subName));
      baseDirs.push(path.join(params.baseDir, subName));
    }
  }

  // 4. Extracted root and common subdirectories
  baseDirs.push(params.extractedRoot);
  for (const subName of ['figures', 'figs', 'fig', 'images', 'img']) {
    baseDirs.push(path.join(params.extractedRoot, subName));
  }

  // 5. Fall back to all discovered directories (expensive but comprehensive)
  if (params.allSearchDirs) {
    for (const dir of params.allSearchDirs) {
      if (!baseDirs.includes(dir)) baseDirs.push(dir);
    }
  }

  const triedPaths: string[] = [];

  for (const dir of baseDirs) {
    for (const rel of candidates) {
      const abs = path.resolve(dir, rel);
      triedPaths.push(abs);
      let safeAbs: string;
      try {
        safeAbs = resolvePathWithinParent(params.extractedRoot, abs, 'includegraphics');
      } catch {
        continue;
      }

      if (!fs.existsSync(safeAbs)) continue;
      try {
        const st = fs.lstatSync(safeAbs);
        if (st.isSymbolicLink()) continue;
        if (!st.isFile()) continue;
      } catch {
        continue;
      }

      return { status: 'resolved', path: safeAbs };
    }
  }

  return { status: 'not_found', triedPaths: triedPaths.slice(0, 10) };
}

function copyAsset(params: { corpusDir: string; extractedRoot: string; destAssetsDir: string; sourceAbs: string }): string | null {
  const relFromExtracted = path.relative(params.extractedRoot, params.sourceAbs);
  if (!relFromExtracted || relFromExtracted.startsWith('..')) return null;

  const destAbs = resolvePathWithinParent(params.destAssetsDir, path.join(params.destAssetsDir, relFromExtracted), 'evidence_asset_dest');
  ensureDir(path.dirname(destAbs));
  fs.copyFileSync(params.sourceAbs, destAbs);
  return normalizePathForCatalog(path.relative(params.corpusDir, destAbs));
}

export async function buildCorpusEvidenceCatalog(params: {
  style_id: string;
  entry: StyleCorpusManifestEntry;
  include_inline_math?: boolean;
  max_paragraph_length?: number;
  map_citations_to_inspire?: boolean;
}): Promise<{
  updated_entry: StyleCorpusManifestEntry;
  catalog_path: string;
  catalog_relpath: string;
  summary: {
    total: number;
    by_type: Record<string, number>;
    figures_copied: number;
    figures_converted?: number;
    tikz_rendered?: number;
  };
}> {
  const styleId = params.style_id;
  const corpusDir = getCorpusDir(styleId);

  const entry = params.entry;
  const paperKey = paperKeyForRecid(entry.recid);

  if (entry.source?.source_type !== 'latex' || !entry.source.main_tex || !entry.source.source_dir) {
    return {
      updated_entry: {
        ...entry,
        status: 'error',
        error: entry.error ?? 'evidence:no_latex_source',
      },
      catalog_path: '',
      catalog_relpath: '',
      summary: { total: 0, by_type: {}, figures_copied: 0 },
    };
  }

  const extractedRoot = resolvePathWithinParent(corpusDir, path.join(corpusDir, entry.source.source_dir), 'corpus_source_dir');
  const mainTexAbs = resolvePathWithinParent(corpusDir, path.join(corpusDir, entry.source.main_tex), 'corpus_main_tex');

  const { merged, sourceMap } = mergeProjectContentWithSourceMap(mainTexAbs);
  const ast = parseLatex(merged);

  const getFileContent: FileContentProvider = (file) => fs.readFileSync(file, 'utf-8');

  const { bibKeyToCitekey } = await buildCitekeyMap({
    ast,
    extractedRoot,
    map_to_inspire: params.map_citations_to_inspire ?? true,
  });

  const items: CorpusEvidenceItemV1[] = [];

  const sectionCmdLevels: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 1,
    subsection: 2,
    subsubsection: 3,
    paragraph: 4,
    subparagraph: 5,
  };

  const sectionCmds = new Set(Object.keys(sectionCmdLevels));
  const majorEnvNames = new Set<string>([
    'equation', 'equation*',
    'align', 'align*',
    'gather', 'gather*',
    'multline', 'multline*',
    'eqnarray', 'eqnarray*',
    'flalign', 'flalign*',
    'figure', 'figure*',
    'table', 'table*',
    'abstract',
    'thebibliography', 'thebibliography*',
    'theorem', 'lemma', 'proposition', 'corollary',
    'definition', 'remark', 'example', 'proof',
    'conjecture', 'claim',
  ]);

  const maxParagraphLength = Math.max(0, Math.trunc(params.max_paragraph_length ?? 0));
  const preambleMacros = scanPreambleForMacros(merged);
  const paragraphBoundaryCommands = new Set(PARAGRAPH_BOUNDARY_COMMANDS);
  const metadataWrapperPattern =
    /\\(affiliation|affil|email|address|institute|collaboration|correspondingauthor)\b/i;
  for (const [macroName, definition] of preambleMacros.commandMacros.entries()) {
    if (metadataWrapperPattern.test(definition)) {
      paragraphBoundaryCommands.add(normalizeLatexCommandName(macroName));
    }
  }

  const macroWrappedMathPairs = buildMacroWrappedEnvironmentPairsFromRegistry(preambleMacros, {
    allowedEnvNames: new Set(
      [
        'equation', 'equation*',
        'align', 'align*',
        'gather', 'gather*',
        'multline', 'multline*',
        'eqnarray', 'eqnarray*',
        'flalign', 'flalign*',
      ].map((n) => n.toLowerCase())
    ),
  });

  // Identify custom graphics macros from preamble
  // These are macros that wrap \epsfbox, \epsfig, \includegraphics, etc.
  const customGraphicsMacros = new Map<string, number>();
  const graphicsPattern = /\\(?:epsfbox|epsfig|epsffile|includegraphics|psfig)\s*(?:\[[^\]]*\])?\s*\{/i;
  for (const [macroName, definition] of preambleMacros.commandMacros.entries()) {
    if (graphicsPattern.test(definition)) {
      // Determine which argument contains the file path
      // Most common patterns:
      // \newcommand{\inclfig}[3]{\epsfxsize=#1\epsfbox{#2}} -> arg index 1 (0-based: 1)
      // \newcommand{\hefig}[2]{\epsfbox{#1}} -> arg index 0
      const argMatch = definition.match(/\\(?:epsfbox|epsfig|epsffile|includegraphics|psfig)\s*(?:\[[^\]]*\])?\s*\{#(\d+)\}/i);
      if (argMatch) {
        const argIndex = parseInt(argMatch[1], 10) - 1; // Convert to 0-based
        customGraphicsMacros.set(macroName, argIndex >= 0 ? argIndex : 0);
      } else {
        // Default to first argument
        customGraphicsMacros.set(macroName, 0);
      }
    }
  }

  // Title
  const titleCmd = findFirstCommandRecursive(ast.kind === 'ast.root' ? ast.content : [], 'title');
  if (titleCmd && latexParser.isCommand(titleCmd)) {
    const titleText = extractText(titleCmd.args.flatMap(arg => (latexParser.isGroup(arg) ? arg.content : []))).trim();
    if (titleText) {
      const loc = mapLocatorToCorpusLocator(
        nodeToLocator(titleCmd, 'merged.tex', merged),
        sourceMap,
        getFileContent,
        extractedRoot
      );
      items.push({
        version: 1,
        style_id: styleId,
        recid: entry.recid,
        paper_key: paperKey,
        type: 'title',
        evidence_id: buildEvidenceId(paperKey, 'title', loc, titleText),
        locator: loc,
        text: titleText,
        normalized_text: normalizeText(titleText),
      });
    }
  }

  // Abstract
  let abstractAdded = false;
  const abstractEnv = findFirstEnvironmentRecursive(ast.kind === 'ast.root' ? ast.content : [], 'abstract');
  if (abstractEnv && latexParser.isEnvironment(abstractEnv)) {
    const abstractText = extractText(abstractEnv.content).trim();
    if (abstractText) {
      const loc = mapLocatorToCorpusLocator(
        nodeToLocator(abstractEnv, 'merged.tex', merged),
        sourceMap,
        getFileContent,
        extractedRoot
      );
      items.push({
        version: 1,
        style_id: styleId,
        recid: entry.recid,
        paper_key: paperKey,
        type: 'abstract',
        evidence_id: buildEvidenceId(paperKey, 'abstract', loc, abstractText),
        locator: loc,
        text: abstractText,
        normalized_text: normalizeText(abstractText),
      });
      abstractAdded = true;
    }
  }

  if (!abstractAdded) {
    const abstractCmd = findFirstCommandRecursive(ast.kind === 'ast.root' ? ast.content : [], 'abstract');
    if (abstractCmd && latexParser.isCommand(abstractCmd)) {
      const abstractText = extractText(abstractCmd.args.flatMap(arg => (latexParser.isGroup(arg) ? arg.content : []))).trim();
      if (abstractText) {
        const loc = mapLocatorToCorpusLocator(
          nodeToLocator(abstractCmd, 'merged.tex', merged),
          sourceMap,
          getFileContent,
          extractedRoot
        );
        items.push({
          version: 1,
          style_id: styleId,
          recid: entry.recid,
          paper_key: paperKey,
          type: 'abstract',
          evidence_id: buildEvidenceId(paperKey, 'abstract', loc, abstractText),
          locator: loc,
          text: abstractText,
          normalized_text: normalizeText(abstractText),
        });
      }
    }
  }

  // Sections + paragraphs + sentences
  const docContent = getDocumentContent(ast);
  const sectionStack: Array<{ level: number; title: string }> = [];
  let paraNodes: LatexNode[] = [];
  const processedDocumentOffsetRanges: Array<{ start: number; end: number }> = [];
  const evidenceQuality = {
    paragraphs_dropped: {
      too_short: 0,
      symbol_heavy: 0,
      draft_marker: 0,
      other: 0,
    },
    blocks_skipped: {
      bibliography: 0,
      macro_wrapped_equations: 0,
    },
    citation_overlap: {
      latex_citations_overlapping_sentences: 0,
      author_year_citations_extracted: 0,
    },
  };

  // Collect sentence texts for deduplication with citation_context
  const sentenceTexts = new Set<string>();

  const markProcessed = (node: LatexNode) => {
    if (!hasLocation(node)) return;
    const loc = nodeToLocator(node, 'merged.tex', merged);
    const start = loc.offset;
    const end = loc.endOffset ?? loc.offset;
    if (end > start) processedDocumentOffsetRanges.push({ start, end });
  };

  if (abstractEnv) markProcessed(abstractEnv);
  if (titleCmd) markProcessed(titleCmd);

  const flushParagraph = () => {
    if (paraNodes.length === 0) return;

    const paraLatex = stringifyLatexNodes(paraNodes);
    const text = stripLatexPreserveHEP(paraLatex).trim();
    const noiseReason = getNoiseParagraphReason(paraLatex, text);
    if (noiseReason) {
      if (noiseReason === 'too_short') evidenceQuality.paragraphs_dropped.too_short += 1;
      else if (noiseReason === 'symbol_heavy') evidenceQuality.paragraphs_dropped.symbol_heavy += 1;
      else if (noiseReason === 'draft_marker') evidenceQuality.paragraphs_dropped.draft_marker += 1;
      else evidenceQuality.paragraphs_dropped.other += 1;
      paraNodes = [];
      return;
    }

    const hepQuant = hasHepQuantSignal(paraLatex, text);
    const hepNarr = hasHepNarrativeSignal(text);
    const hepSemantic = hepQuant || hepNarr;
    const paragraphText =
      maxParagraphLength > 0 && text.length > maxParagraphLength && !hepSemantic ? `${text.slice(0, maxParagraphLength)}...` : text;

    const startNode = firstLocated(paraNodes);
    const endNode = lastLocated(paraNodes);
    if (!startNode || !endNode) {
      paraNodes = [];
      return;
    }

    const spanLoc = mergeSpanLocator(nodeToLocator(startNode, 'merged.tex', merged), nodeToLocator(endNode, 'merged.tex', merged));
    const loc = mapLocatorToCorpusLocator(spanLoc, sourceMap, getFileContent, extractedRoot);

    const sectionPath = sectionStack.map(s => s.title).filter(Boolean);
    const intents = classifyIntents(text);
    const paragraphMeta: Record<string, unknown> = {};
    if (sectionPath.length > 0) paragraphMeta.section_path = sectionPath;
    if (intents.length > 0) {
      paragraphMeta.intents = intents;
      paragraphMeta.intent = intents[0];
    }
    if (hepSemantic) {
      paragraphMeta.hep_signals = { quantitative: hepQuant || undefined, narrative: hepNarr || undefined };
    }
    items.push({
      version: 1,
      style_id: styleId,
      recid: entry.recid,
      paper_key: paperKey,
      type: 'paragraph',
      evidence_id: buildEvidenceId(paperKey, 'paragraph', loc, paragraphText),
      locator: loc,
      text: paragraphText,
      normalized_text: normalizeText(paragraphText),
      meta: Object.keys(paragraphMeta).length > 0 ? paragraphMeta : undefined,
    });

    // Sentence-level evidence (discussion-oriented tags)
    const sentences = splitSentences(paragraphText);
    for (const sentence of sentences) {
      const tags = classifySentence(sentence);
      if (tags.length === 0) continue;
      const sentenceIntents = classifyIntents(sentence);
      items.push({
        version: 1,
        style_id: styleId,
        recid: entry.recid,
        paper_key: paperKey,
        type: 'sentence',
        evidence_id: buildEvidenceId(paperKey, 'sentence', loc, sentence),
        locator: loc,
        text: sentence,
        normalized_text: normalizeText(sentence),
        meta: {
          tags,
          intents: sentenceIntents.length > 0 ? sentenceIntents : undefined,
          intent: sentenceIntents[0] ?? undefined,
          section_path: sectionPath.length ? sectionPath : undefined,
        },
      });
      // Track sentence text for overlap detection with citation_context
      sentenceTexts.add(sentence);
    }

    paraNodes = [];
  };

  for (let nodeIndex = 0; nodeIndex < docContent.length; nodeIndex++) {
    const node = docContent[nodeIndex];
    const nodeLoc = hasLocation(node) ? nodeToLocator(node, 'merged.tex', merged) : null;
    if (nodeLoc) {
      const off = nodeLoc.offset;
      if (processedDocumentOffsetRanges.some(r => off >= r.start && off < r.end)) {
        continue;
      }
    }

    const wrapped = matchMacroWrappedEnvironmentAt(docContent, nodeIndex, macroWrappedMathPairs);
    if (wrapped) {
      evidenceQuality.blocks_skipped.macro_wrapped_equations += 1;
      flushParagraph();
      nodeIndex = wrapped.endIndex;
      continue;
    }
    if (latexParser.isParbreak(node)) {
      flushParagraph();
      continue;
    }

    if (latexParser.isCommand(node) && sectionCmds.has(normalizeLatexCommandName(node.name))) {
      flushParagraph();

      const baseName = normalizeLatexCommandName(node.name);
      const level = sectionCmdLevels[baseName]!;
      const title = extractText(node.args.flatMap(arg => (latexParser.isGroup(arg) ? arg.content : []))).trim();
      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1]!.level >= level) {
        sectionStack.pop();
      }
      sectionStack.push({ level, title });

      const loc = mapLocatorToCorpusLocator(nodeToLocator(node, 'merged.tex', merged), sourceMap, getFileContent, extractedRoot);
      items.push({
        version: 1,
        style_id: styleId,
        recid: entry.recid,
        paper_key: paperKey,
        type: 'section',
        evidence_id: buildEvidenceId(paperKey, 'section', loc, title || node.name),
        locator: loc,
        text: title || node.name,
        normalized_text: normalizeText(title || node.name),
        meta: {
          level,
          section_path: sectionStack.map(s => s.title).filter(Boolean),
          command: node.name,
        },
      });
      continue;
    }

    // Scorched-earth metadata drop: skip the command and any adjacent arg groups.
    if (latexParser.isCommand(node) && METADATA_DROP_COMMANDS.has(normalizeLatexCommandName(node.name))) {
      flushParagraph();
      const endOffset = (nodeLoc?.endOffset ?? nodeLoc?.offset ?? null);
      if (endOffset !== null) {
        while (nodeIndex + 1 < docContent.length) {
          const next = docContent[nodeIndex + 1]!;
          if (!hasLocation(next)) break;
          const nextLoc = nodeToLocator(next, 'merged.tex', merged);
          if (nextLoc.offset <= endOffset) {
            nodeIndex += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    // Hard paragraph boundaries / noise commands
    if (latexParser.isCommand(node) && paragraphBoundaryCommands.has(normalizeLatexCommandName(node.name))) {
      flushParagraph();
      continue;
    }

    // Major blocks: flush paragraph boundary and skip the environment node itself.
    if (latexParser.isMathEnv(node) || latexParser.isDisplayMath(node)) {
      flushParagraph();
      continue;
    }

    if (latexParser.isEnvironment(node)) {
      const envName = node.name.toLowerCase();
      if (envName === 'thebibliography' || envName === 'thebibliography*') {
        evidenceQuality.blocks_skipped.bibliography += 1;
      }
      if (majorEnvNames.has(envName)) {
        flushParagraph();
        continue;
      }
    }

    paraNodes.push(node);
  }
  flushParagraph();

  // Equations
  const equations = extractEquations(ast, {
    file: 'merged.tex',
    includeInline: params.include_inline_math ?? false,
    content: merged,
  });
  for (const eq of equations) {
    if (!eq.location) continue;
    const loc = mapLocatorToCorpusLocator(eq.location, sourceMap, getFileContent, extractedRoot);
    const canonical = canonicalizeMath(eq.latex);
    if (!canonical) continue;
    const equationId = `eq_${sha256Hex(canonical).slice(0, 16)}`;
    const signals = extractMathSignals(canonical);
    items.push({
      version: 1,
      style_id: styleId,
      recid: entry.recid,
      paper_key: paperKey,
      type: 'equation',
      evidence_id: buildEvidenceId(paperKey, 'equation', loc, canonical),
      locator: loc,
      text: canonical,
      meta: {
        equation_id: equationId,
        canonical_hash: sha256Hex(canonical),
        symbols: signals.symbols,
        operators: signals.operators,
        equation_type: eq.type,
        env_name: eq.envName,
        label: eq.label,
      },
    });
  }

  // Figures (+ safe copy of includegraphics assets)
  let figuresCopied = 0;
  const assetResolutionStats = { resolved: 0, skipped: 0, not_found: 0, sequenced_matched: 0 };
  const assetConversionStats = { converted: 0, skipped: 0, failed: 0, tikz_rendered: 0 };
  const evidenceDir = getCorpusEvidenceDir(styleId);
  const paperEvidenceDir = resolvePathWithinParent(evidenceDir, path.join(evidenceDir, paperKey), 'paper_evidence_dir');
  ensureDir(paperEvidenceDir);
  const assetsDir = resolvePathWithinParent(paperEvidenceDir, path.join(paperEvidenceDir, 'assets'), 'paper_evidence_assets_dir');
  ensureDir(assetsDir);

  // Check available image conversion tools (cached)
  const imageConversionTools = await checkToolAvailability();

  // Collect all potential figure directories for comprehensive search
  const allFigureSearchDirs = collectFigureSearchDirs(extractedRoot);
  
  // Detect sequentially numbered images for arXiv-style submissions
  const sequencedImages = detectSequencedImages(extractedRoot);
  let sequencedImageIndex = 0;

  const figures = extractFigures(ast, { 
    file: 'merged.tex',
    custom_graphics_macros: customGraphicsMacros.size > 0 ? customGraphicsMacros : undefined,
  });
  for (const fig of figures) {
    if (!fig.location) continue;
    const loc = mapLocatorToCorpusLocator(fig.location, sourceMap, getFileContent, extractedRoot);

    const sourceFileAbs = resolvePathWithinParent(extractedRoot, path.join(extractedRoot, loc.file), 'figure_locator_file');
    const baseDir = path.dirname(sourceFileAbs);

    const copiedAssets: string[] = [];
    const missingAssets: string[] = [];
    let matchedFromSequence = false;
    
    // Handle \include{file} or \input{file} references - resolve to actual file content
    let resolvedDrawingType = fig.drawing_type;
    let resolvedDrawingSource = fig.drawing_source;
    if (fig.drawing_type === 'include' && fig.drawing_source) {
      // Extract filename from \include{filename} or \input{filename}
      const includeMatch = fig.drawing_source.match(/\\(?:include|input)\{([^}]+)\}/);
      if (includeMatch) {
        const includedFileName = includeMatch[1];
        // Try to find the file with .tex extension
        const candidates = [
          path.join(baseDir, includedFileName),
          path.join(baseDir, `${includedFileName}.tex`),
          path.join(extractedRoot, includedFileName),
          path.join(extractedRoot, `${includedFileName}.tex`),
        ];
        for (const candidate of candidates) {
          try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              const content = fs.readFileSync(candidate, 'utf-8');
              // Determine the type based on content
              if (content.includes('\\begin{picture}') || content.includes('GNUPLOT')) {
                resolvedDrawingType = 'picture';
              } else if (content.includes('\\begin{tabular}')) {
                resolvedDrawingType = 'tabular';
              } else if (content.includes('\\begin{tikzpicture}')) {
                resolvedDrawingType = 'tikz';
              } else {
                resolvedDrawingType = 'latex';
              }
              resolvedDrawingSource = content;
              break;
            }
          } catch {
            // Ignore read errors
          }
        }
      }
    }
    
    // If figure has explicit image_paths, use them
    if (fig.image_paths && fig.image_paths.length > 0) {
      for (const rawPath of fig.image_paths) {
        const resolution = resolveIncludeGraphicsPath({
          extractedRoot,
          baseDir,
          rawPath,
          allSearchDirs: allFigureSearchDirs,
        });
        if (resolution.status === 'resolved') {
          assetResolutionStats.resolved++;
          const copied = copyAsset({ corpusDir, extractedRoot, destAssetsDir: assetsDir, sourceAbs: resolution.path });
          if (copied) copiedAssets.push(copied);
        } else if (resolution.status === 'skipped') {
          assetResolutionStats.skipped++;
        } else {
          assetResolutionStats.not_found++;
          missingAssets.push(rawPath);
        }
      }
    } 
    // If no image_paths AND no drawing_source, try to match from sequenced images
    else if (!resolvedDrawingType && sequencedImageIndex < sequencedImages.length) {
      const seqImg = sequencedImages[sequencedImageIndex];
      // Copy the sequenced image as asset
      const copied = copyAsset({ corpusDir, extractedRoot, destAssetsDir: assetsDir, sourceAbs: seqImg.path });
      if (copied) {
        copiedAssets.push(copied);
        assetResolutionStats.sequenced_matched++;
        matchedFromSequence = true;
      }
      sequencedImageIndex++;
    }
    
    if (copiedAssets.length > 0) figuresCopied += copiedAssets.length;

    const caption = (fig.caption ?? '').trim();
    if (!caption) continue;

    const figureMeta: Record<string, unknown> = {
      label: fig.label,
      placement: fig.placement,
      image_paths: fig.image_paths,
      copied_assets: copiedAssets.length > 0 ? copiedAssets : undefined,
      missing_assets: missingAssets.length > 0 ? missingAssets : undefined,
      matched_from_sequence: matchedFromSequence || undefined,  // arXiv-style sequenced image match
      is_subfigure: fig.is_subfigure,
      section: fig.section,
      section_path: fig.section_path,
      subfigures: fig.subfigures,
      drawing_type: resolvedDrawingType,
      drawing_source: resolvedDrawingSource,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Image Conversion: EPS/PS → PNG (if tools available)
    // ─────────────────────────────────────────────────────────────────────────
    const convertedAssets: string[] = [];
    const conversionWarnings: string[] = [];

    // Convert EPS/PS assets to PNG
    for (const assetPath of copiedAssets) {
      if (/\.(eps|ps)$/i.test(assetPath)) {
        const assetFullPath = path.join(assetsDir, assetPath);
        const pngPath = assetPath.replace(/\.(eps|ps)$/i, '.png');
        const pngFullPath = path.join(assetsDir, pngPath);
        
        const result = await convertEpsToPngAuto(assetFullPath, pngFullPath, {
          dpi: 300,
          timeout: 30000,
        });
        
        if (result.success) {
          convertedAssets.push(pngPath);
          assetConversionStats.converted++;
        } else if (result.error?.includes('not installed')) {
          assetConversionStats.skipped++;
          // Only warn once per tool
          if (!conversionWarnings.some(w => w.includes(result.tool || ''))) {
            conversionWarnings.push(result.error);
          }
        } else {
          assetConversionStats.failed++;
          conversionWarnings.push(`${assetPath}: ${result.error}`);
        }
      }
    }

    // Render TikZ/Feynman diagrams to PNG (if tools available and drawing_source present)
    if (resolvedDrawingType && resolvedDrawingSource) {
      const renderableTypes = ['tikz', 'feynman', 'pstricks', 'picture'];
      if (renderableTypes.includes(resolvedDrawingType)) {
        const label = fig.label || `fig_${items.length}`;
        const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_');
        const renderedPath = `${safeName}_rendered.png`;
        const renderedFullPath = path.join(assetsDir, renderedPath);
        
        const result = await renderLatexToPng(resolvedDrawingSource, renderedFullPath, {
          drawingType: resolvedDrawingType as 'tikz' | 'feynman' | 'pstricks' | 'picture',
          dpi: 300,
          timeout: 60000,
        });
        
        if (result.success) {
          figureMeta.rendered_drawing = renderedPath;
          assetConversionStats.tikz_rendered++;
        } else if (result.error?.includes('not installed')) {
          assetConversionStats.skipped++;
          if (!conversionWarnings.some(w => w.includes(result.tool || ''))) {
            conversionWarnings.push(result.error);
          }
        } else {
          assetConversionStats.failed++;
          conversionWarnings.push(`TikZ render: ${result.error}`);
        }
      }
    }

    // Add conversion metadata to figureMeta
    if (convertedAssets.length > 0) {
      figureMeta.converted_assets = convertedAssets;
    }
    if (conversionWarnings.length > 0) {
      figureMeta.conversion_warnings = conversionWarnings;
    }

    items.push({
      version: 1,
      style_id: styleId,
      recid: entry.recid,
      paper_key: paperKey,
      type: 'figure',
      evidence_id: buildEvidenceId(paperKey, 'figure', loc, caption),
      locator: loc,
      text: caption,
      normalized_text: caption ? normalizeText(caption) : undefined,
      meta: figureMeta,
    });
  }

  // Tables - enable parse_data to extract table content
  const tables = extractTables(ast, { file: 'merged.tex', parse_data: true, max_rows: 200 });
  for (const table of tables) {
    if (!table.location) continue;
    const loc = mapLocatorToCorpusLocator(table.location, sourceMap, getFileContent, extractedRoot);
    const caption = (table.caption ?? '').trim();
    if (!caption) continue;

    // Build table meta with data if available
    const tableMeta: Record<string, unknown> = {
      label: table.label,
      column_spec: table.column_spec,
      row_count: table.row_count,
      column_count: table.column_count,
      section: table.section,
      section_path: table.section_path,
    };

    // Include parsed data as plain text rows if available
    if (table.data && table.data.length > 0) {
      tableMeta.headers = table.headers;
      // Convert data rows to plain text representation for RAG
      tableMeta.data_rows = table.data.map(row => row.join(' | ')).slice(0, 50);
    }

    items.push({
      version: 1,
      style_id: styleId,
      recid: entry.recid,
      paper_key: paperKey,
      type: 'table',
      evidence_id: buildEvidenceId(paperKey, 'table', loc, caption),
      locator: loc,
      text: caption,
      normalized_text: caption ? normalizeText(caption) : undefined,
      meta: tableMeta,
    });
  }

  // Citation contexts (LaTeX \cite{} commands)
  const citations = extractCitations(ast, merged, { file: 'merged.tex', include_cross_refs: false });
  for (const cit of citations) {
    if (!cit.location) continue;
    const loc = mapLocatorToCorpusLocator(cit.location, sourceMap, getFileContent, extractedRoot);

    const mapped = (cit.keys || []).map(k => bibKeyToCitekey.get(k) ?? k).filter(Boolean);
    const text = stripLatexPreserveHEP(cit.context).trim();
    if (!text) continue;

    // Check for overlap with already-extracted sentences
    const overlapsSentence = checkTextOverlap(text, sentenceTexts);
    if (overlapsSentence) {
      evidenceQuality.citation_overlap.latex_citations_overlapping_sentences += 1;
    }

    // Classify citation intent based on context
    const citationIntents = classifyCitationIntent(text);

    const citMeta: Record<string, unknown> = {
      raw_cite_keys: cit.keys,
      command_type: cit.type,
      section: cit.section,
      optional_arg: cit.optional_arg,
      citation_context_id: `cc_${sha256Hex(JSON.stringify({ loc, keys: cit.keys, ctx: text.slice(0, 200) })).slice(0, 16)}`,
      citation_intents: citationIntents,
      citation_intent: citationIntents[0],
    };
    if (overlapsSentence) {
      citMeta.overlaps_sentence = true;
    }

    items.push({
      version: 1,
      style_id: styleId,
      recid: entry.recid,
      paper_key: paperKey,
      type: 'citation_context',
      evidence_id: buildEvidenceId(paperKey, 'citation_context', loc, text),
      locator: loc,
      text,
      normalized_text: normalizeText(text),
      citations: mapped.length > 0 ? mapped : undefined,
      meta: citMeta,
    });
  }

  // Author-Year citation contexts (for older papers without \cite{} macros)
  // Extract "Weinberg (1980)", "Salam and Weinberg (1979)", "Green et al. (1987)" patterns
  const strippedMerged = stripLatexPreserveHEP(merged);
  const authorYearCitations = extractAuthorYearCitations(strippedMerged);
  for (const ayc of authorYearCitations) {
    // Create a synthetic locator based on character position in stripped text
    // Note: This is approximate since stripping changes positions
    const syntheticLoc: CorpusLatexLocatorV1 = {
      kind: 'latex',
      file: 'merged.tex',
      offset: ayc.position,
      line: 0,
      column: 0,
      anchor: {
        before: ayc.context.slice(0, 30),
        after: ayc.context.slice(-30),
      },
    };

    const text = ayc.context;
    if (!text || text.length < 20) continue;

    // Check for overlap with LaTeX citations (skip if already covered)
    const overlapsSentence = checkTextOverlap(text, sentenceTexts);

    // Classify citation intent based on context
    const citationIntents = classifyCitationIntent(text);

    evidenceQuality.citation_overlap.author_year_citations_extracted += 1;

    items.push({
      version: 1,
      style_id: styleId,
      recid: entry.recid,
      paper_key: paperKey,
      type: 'citation_context',
      evidence_id: buildEvidenceId(paperKey, 'citation_context', syntheticLoc, `${ayc.match}:${text.slice(0, 100)}`),
      locator: syntheticLoc,
      text,
      normalized_text: normalizeText(text),
      meta: {
        citation_style: 'author_year',
        matched_text: ayc.match,
        authors: ayc.authors,
        year: ayc.year,
        citation_intents: citationIntents,
        citation_intent: citationIntents[0],
        overlaps_sentence: overlapsSentence || undefined,
        citation_context_id: `cc_ay_${sha256Hex(JSON.stringify({ match: ayc.match, ctx: text.slice(0, 200) })).slice(0, 16)}`,
      },
    });
  }

  // Stable ordering
  items.sort((a, b) => {
    const fileCmp = a.locator.file.localeCompare(b.locator.file);
    if (fileCmp !== 0) return fileCmp;
    const offCmp = a.locator.offset - b.locator.offset;
    if (offCmp !== 0) return offCmp;
    return a.evidence_id.localeCompare(b.evidence_id);
  });

  const byType: Record<string, number> = {};
  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
  }

  const catalogPath = resolvePathWithinParent(paperEvidenceDir, path.join(paperEvidenceDir, 'catalog.jsonl'), 'paper_evidence_catalog');
  const out = fs.createWriteStream(catalogPath, { encoding: 'utf-8' });
  for (const item of items) out.write(`${JSON.stringify(item)}\n`);
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', resolve);
    out.end();
  });

  const relCatalog = normalizePathForCatalog(path.relative(corpusDir, catalogPath));

  // Add asset resolution stats to evidence quality
  const extendedEvidenceQuality = {
    ...evidenceQuality,
    asset_resolution: assetResolutionStats,
    asset_conversion: assetConversionStats,
    image_tools_available: imageConversionTools,
  };

  return {
    updated_entry: {
      ...entry,
      status: 'evidence_built',
      error: undefined,
      assets: {
        ...(entry.assets ?? {}),
        evidence_items: items.length,
        by_type: byType,
        figures_copied: figuresCopied,
        figures_converted: assetConversionStats.converted,
        tikz_rendered: assetConversionStats.tikz_rendered,
        equations: byType.equation ?? 0,
      },
      evidence_quality: extendedEvidenceQuality,
    },
    catalog_path: catalogPath,
    catalog_relpath: relCatalog,
    summary: {
      total: items.length,
      by_type: byType,
      figures_copied: figuresCopied,
      figures_converted: assetConversionStats.converted,
      tikz_rendered: assetConversionStats.tikz_rendered,
    },
  };
}
