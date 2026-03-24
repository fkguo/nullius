import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RepEnvelope } from '../model/rep-envelope.js';
import { parseEnvelope, serializeEnvelope } from '../protocol/envelope.js';
import { formatValidationIssues } from '../validation/result.js';
import { validateEnvelope } from '../validation/envelope-validation.js';
import type { RepTransport } from './rep-transport.js';

export interface FileTransportOptions {
  filePath: string;
}

export class FileTransport implements RepTransport {
  readonly filePath: string;

  constructor(options: FileTransportOptions) {
    this.filePath = options.filePath;
  }

  async append(envelope: RepEnvelope): Promise<void> {
    const validation = validateEnvelope(envelope);
    if (!validation.ok || !validation.data) {
      throw new Error(`Invalid REP envelope: ${formatValidationIssues(validation.issues)}`);
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    // Local JSONL append keeps the v1 transport minimal, but it is not crash-atomic.
    await appendFile(this.filePath, `${serializeEnvelope(validation.data)}\n`, 'utf8');
  }

  async readAll(): Promise<RepEnvelope[]> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      return content
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => {
          const validation = validateEnvelope(parseEnvelope(line));
          if (!validation.ok || !validation.data) {
            throw new Error(`Invalid REP envelope on disk: ${formatValidationIssues(validation.issues)}`);
          }
          return validation.data;
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
