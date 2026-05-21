import * as fs from 'fs';
import * as path from 'path';
import { writeJsonAtomicDurable } from '@autoresearch/shared';

export type MarkerKind = 'download_dir';

export interface DirectoryMarker {
  created_by: 'hep-mcp';
  kind: MarkerKind;
  created_at: string;
  version: 1;
}

const MARKER_FILE_NAME = '.hep-mcp.marker.json';

export function getMarkerPath(dirPath: string): string {
  return path.join(dirPath, MARKER_FILE_NAME);
}

export function writeDirectoryMarker(dirPath: string, kind: MarkerKind): void {
  const marker: DirectoryMarker = {
    created_by: 'hep-mcp',
    kind,
    created_at: new Date().toISOString(),
    version: 1,
  };
  // Explicit stringify (no trailing newline) preserves byte parity with
  // the prior `fs.writeFileSync(..., JSON.stringify(marker, null, 2))`.
  writeJsonAtomicDurable(
    getMarkerPath(dirPath),
    marker,
    (p) => JSON.stringify(p, null, 2),
  );
}

export function isMarkedDirectory(dirPath: string, kind?: MarkerKind): boolean {
  const markerPath = getMarkerPath(dirPath);
  if (!fs.existsSync(markerPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Partial<DirectoryMarker>;
    if (parsed.created_by !== 'hep-mcp') return false;
    if (parsed.version !== 1) return false;
    if (kind && parsed.kind !== kind) return false;
    return true;
  } catch {
    return false;
  }
}

