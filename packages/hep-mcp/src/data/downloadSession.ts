import * as fs from 'fs';
import { isMarkedDirectory } from './markers.js';

const registeredDirs = new Set<string>();

export function registerDownloadDir(dirPath: string): void {
  registeredDirs.add(dirPath);
}

export function cleanupRegisteredDownloadDirs(): void {
  for (const dirPath of registeredDirs) {
    try {
      if (!fs.existsSync(dirPath)) continue;
      if (!isMarkedDirectory(dirPath, 'download_dir')) continue;
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

