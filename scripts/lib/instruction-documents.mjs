import fs from 'node:fs';
import path from 'node:path';

export const INSTRUCTION_ENTRIES = [
  'skills/research-harness/SKILL.md',
  'skills/research-team/SKILL.md',
  'skills/review-swarm/SKILL.md',
  'skills/research-integrity/SKILL.md',
  'packages/project-contracts/src/project_contracts/scaffold_templates/AGENTS.md',
];

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const MARKER = '"nullius-guidance"';

// Examples are not declarations. Inline links use the reserved exact title;
// only these links participate, never ordinary navigation or a directory scan.
function declarationText(text) {
  const lines = text.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let fence = null;
  return lines.map((line) => {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (fence === null) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
      return '';
    }
    if (fence !== null || /^(?: {4}|\t)/.test(line)) return '';
    return line.replace(/(`+)[\s\S]*?\1/g, '');
  }).join('\n');
}

export function instructionLinks(text) {
  let source = declarationText(text);
  const targets = [];
  const links = /(?<![\\!])\[(?:\\.|[^\]\\\n])+\]\(\s*(?:<([^<>\n]+)>|([^\s()]+))\s+"nullius-guidance"\s*\)/g;
  source = source.replace(links, (_all, angled, plain) => {
    targets.push(angled ?? plain);
    return '';
  });
  if (source.includes(MARKER)) throw new Error('invalid nullius-guidance declaration');
  return targets;
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function regularDocument(root, target) {
  if (!inside(root, target)) throw new Error(`instruction path escapes root: ${target}`);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Error(`instruction symlink refused: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`instruction root is not a directory: ${root}`);
  let cursor = root;
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part) cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`instruction symlink refused: ${cursor}`);
    const last = cursor === target;
    if (last ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`instruction path is not a ${last ? 'regular file' : 'directory'}: ${cursor}`);
    }
  }
  return strictUtf8.decode(fs.readFileSync(target));
}

/** Ordered original documents reachable through exact marked local links.
 * root defaults to the entry directory. References cannot escape it, traverse
 * symlinks, contain invalid UTF-8, or form a cycle; repeated DAG edges dedupe.
 */
export function collectInstructionDocuments(entry, { root = path.dirname(path.resolve(entry)) } = {}) {
  const boundary = path.resolve(root);
  const active = new Set();
  const visited = new Set();
  const documents = [];
  function visit(file) {
    if (active.has(file)) throw new Error(`instruction reference cycle: ${file}`);
    if (visited.has(file)) return;
    const text = regularDocument(boundary, file);
    active.add(file);
    documents.push({ path: file, text });
    for (const href of instructionLinks(text)) {
      let decoded;
      try { decoded = decodeURIComponent(href); } catch { throw new Error(`invalid instruction URL: ${href}`); }
      const [local, ...fragments] = decoded.split('#');
      if (!local || fragments.length > 1 || /[\\?\u0000-\u001f]/.test(decoded)
          || /^[a-z][a-z0-9+.-]*:/i.test(local) || path.isAbsolute(local)
          || path.extname(local).toLowerCase() !== '.md') {
        throw new Error(`invalid local instruction reference: ${href}`);
      }
      const target = path.resolve(path.dirname(file), local);
      if (!inside(boundary, target)) throw new Error(`instruction path escapes root: ${href}`);
      visit(target);
    }
    active.delete(file);
    visited.add(file);
  }
  visit(path.resolve(entry));
  return documents;
}

export function readInstructionDocuments(entry, options = {}) {
  return collectInstructionDocuments(entry, options).map(({ text }) => text).join('\n\n');
}

// Existing source/code locks keep reading their own files. Only the declared
// instruction entries switch from a single file to their explicit closure.
export function readRepositoryDocument(repoRoot, relativePath) {
  const file = path.join(repoRoot, relativePath);
  return INSTRUCTION_ENTRIES.includes(relativePath)
    ? readInstructionDocuments(file)
    : fs.readFileSync(file, 'utf8');
}
