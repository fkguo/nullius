import * as fs from 'fs';
import * as path from 'path';

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
  fs.writeFileSync(getMarkerPath(dirPath), JSON.stringify(marker, null, 2), 'utf-8');
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

