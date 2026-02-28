import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const HEPDATA_DATA_DIR_ENV = 'HEPDATA_DATA_DIR';
const HEP_DATA_DIR_ENV = 'HEP_DATA_DIR';

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.hep-mcp', 'hepdata');

function expandTilde(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export function getDataDir(): string {
  const explicit = process.env[HEPDATA_DATA_DIR_ENV];
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(expandTilde(explicit));
  }

  // Convenience: when hep-mcp is configured with HEP_DATA_DIR, default to a
  // subdirectory within it so all autoresearch data stays co-located.
  const hepDataDir = process.env[HEP_DATA_DIR_ENV];
  if (hepDataDir && hepDataDir.trim().length > 0) {
    return path.resolve(path.join(expandTilde(hepDataDir), 'hepdata'));
  }

  return path.resolve(DEFAULT_DATA_DIR);
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return;
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
}

export function getArtifactsDir(): string {
  return path.join(getDataDir(), 'artifacts');
}
