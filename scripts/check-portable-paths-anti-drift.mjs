#!/usr/bin/env node

// Scan the Git-visible surface, including tests, this script, and unignored new
// files. This bounded guard cannot identify every personal detail in prose.
// Diagnostics contain locations and rule names, never matched contents.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Regex machinery and marked placeholders such as /Users/<user>/ do not match.
// Accept native Windows paths and backslash-escaped source literals alike.
const MACHINE_PATH = /(?:\/(?:Users|home)\/|[A-Za-z]:[\\/]+Users[\\/]+)([\p{L}\p{N}._@-]+)(?=[/\\]|["'`\s.,:;)\]]|$)/gu;
const PLACEHOLDER_SEGMENTS = new Set([
  'me', 'you', 'user', 'users', 'username', 'name', 'example', 'someone', 'foo', 'bar', '.', '..', '...',
]);
// Conventional fixture identities, permitted only in test surfaces. Tests are
// never exempt from scanning arbitrary machine accounts or secrets.
const TEST_PLACEHOLDER_SEGMENTS = new Set([
  'alice', 'bob', 'john', 'ubuntu', 'nobody', 'old-machine', 'test-researcher', 'researcher',
]);
const SECRET_RULES = [
  ['private-key', /-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ['cloud-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['provider-api-key', /\bsk-(?:proj-|ant-)[A-Za-z0-9_-]{40,}\b/g],
  ['stripe-secret-key', /\bsk_live_[A-Za-z0-9]{24,}\b/g],
];

export function isTestSurface(file) {
  return /(^|\/)(__tests__|tests|fixtures)\//.test(file)
    || /(?:\.test\.[cm]?[tj]sx?$|(^|\/)test_[^/]*\.[^/]+$|(^|\/)run_[^/]*tests?\.sh$)/.test(file);
}

export function sensitiveFileName(file) {
  const basename = path.posix.basename(file).toLowerCase();
  // Explicit templates are allowed as filenames; their contents are scanned.
  if (/\.(?:example|sample|template)(?:\.[a-z0-9]+)?$/.test(basename)) return false;
  return /^\.env(?:rc|\..+)?$/.test(basename)
    || /^(?:\.?(?:oauth|auth|credentials?|secrets?|tokens?)\.(?:json|jsonl|ya?ml|toml)|oauth[-_]?(?:tokens?|creds|credentials)\.json|google_accounts\.json|service[-_]account\.json|client_secret[^/]*\.json)$/.test(basename)
    || /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.netrc|\.npmrc|\.pypirc)$/.test(basename)
    || /\.(?:pem|key|p12|pfx|keystore|jks)$/.test(basename)
    || /(?:^|\/)\.(?:aws\/credentials|docker\/config\.json|ssh\/config|kube\/config)$/.test(file.toLowerCase());
}

function decodedLine(line) {
  return line.replace(/(?:%[0-9a-f]{2})+/gi, value => {
    try { return decodeURIComponent(value); } catch { return value; }
  });
}

export function scanContent(file, content) {
  const violations = [];
  const fixture = isTestSurface(file);
  for (const [index, raw] of content.split('\n').entries()) {
    const line = decodedLine(raw);
    MACHINE_PATH.lastIndex = 0;
    for (const match of line.matchAll(MACHINE_PATH)) {
      // An HTTP route named /Users/ is not a filesystem reference. A file URI is.
      if (/https?:\/\/[^\s"'`<>]*$/i.test(line.slice(0, match.index))) continue;
      const segment = match[1].toLowerCase();
      if (PLACEHOLDER_SEGMENTS.has(segment) || (fixture && TEST_PLACEHOLDER_SEGMENTS.has(segment))) continue;
      violations.push({ file, line: index + 1, rule: 'machine-home-path' });
    }
    for (const [rule, expression] of SECRET_RULES) {
      expression.lastIndex = 0;
      if (expression.test(line)) violations.push({ file, line: index + 1, rule });
    }
  }
  return violations;
}

export function visibleFiles(root) {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).split('\0').filter(Boolean))].sort();
}

export function scanRepository(root) {
  const violations = [];
  const files = visibleFiles(root);
  for (const file of files) {
    const target = path.join(root, file);
    let stat;
    try { stat = lstatSync(target); }
    catch (error) {
      if (error.code === 'ENOENT') continue; // A tracked deletion has no working-tree bytes to publish.
      violations.push({ file, line: 1, rule: 'unreadable-file' });
      continue;
    }
    if (sensitiveFileName(file)) violations.push({ file, line: 1, rule: 'sensitive-file-name' });
    try {
      // Check symlink targets literally, never read external files through them.
      if (stat.isSymbolicLink()) violations.push(...scanContent(file, readlinkSync(target)));
      else if (stat.isFile()) {
        const bytes = readFileSync(target);
        const content = bytes[0] === 0xff && bytes[1] === 0xfe
          ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
        violations.push(...scanContent(file, content));
      } else violations.push({ file, line: 1, rule: 'unsupported-file-type' });
    } catch { violations.push({ file, line: 1, rule: 'unreadable-file' }); }
  }
  return { files: files.length, violations };
}

function safeLocation(file) {
  let result = file;
  for (const [, expression] of SECRET_RULES) {
    expression.lastIndex = 0;
    result = result.replace(expression, '<redacted>');
  }
  return JSON.stringify(result);
}

export function formatReport(result) {
  if (result.violations.length === 0) return `OK: ${result.files} tracked or unignored new files checked, including tests and scripts.\n`;
  return 'DRIFT: private machine paths, sensitive filenames, or high-confidence secret material:\n'
    + result.violations.map(item => `  ${safeLocation(item.file)}:${item.line} [${item.rule}]`).join('\n')
    + '\nUse portable paths and explicit test placeholders; keep real environment/auth files out of Git.\n'
    + 'Matched contents are redacted. Public author metadata and repository URLs are not rejected.\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = scanRepository(repoRoot);
    const report = formatReport(result);
    if (result.violations.length) process.stderr.write(report);
    else process.stdout.write(report);
    process.exitCode = result.violations.length ? 1 : 0;
  } catch {
    // Git/filesystem errors may contain private paths or credential-bearing URLs.
    process.stderr.write('ERROR: could not enumerate the Git-visible source surface.\n');
    process.exitCode = 2;
  }
}
