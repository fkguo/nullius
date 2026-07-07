import { existsSync, mkdirSync } from 'fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { appendJsonLine, readJsonFile, writeJsonFileAtomic } from './file-io.js';
import { withLock } from './file-lock.js';

const SHA256_HASH_RE = /^sha256:[0-9a-f]{64}$/;

function defaultProjectRoot(rootDir: string): string {
  let current = rootDir;
  while (true) {
    if (existsSync(resolve(current, '.nullius'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return basename(rootDir) === 'idea-store' ? dirname(rootDir) : rootDir;
}

function insideOrEqual(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function encodeProjectPath(path: string): string {
  return path.split(sep).join('/').split('/').map(encodeURIComponent).join('/');
}

export class IdeaEngineStore {
  readonly rootDir: string;
  readonly projectRoot: string;
  readonly campaignsRoot: string;
  readonly globalRoot: string;

  constructor(rootDir: string, options: { projectRoot?: string } = {}) {
    this.rootDir = resolve(rootDir);
    this.projectRoot = resolve(options.projectRoot ?? defaultProjectRoot(this.rootDir));
    if (!insideOrEqual(this.rootDir, this.projectRoot)) {
      throw new Error(`store root must be inside project root: ${this.rootDir}`);
    }
    this.campaignsRoot = resolve(this.rootDir, 'campaigns');
    this.globalRoot = resolve(this.rootDir, 'global');
    mkdirSync(this.campaignsRoot, { recursive: true });
    mkdirSync(this.globalRoot, { recursive: true });
  }

  campaignDir(campaignId: string): string {
    return resolve(this.campaignsRoot, campaignId);
  }

  campaignManifestPath(campaignId: string): string {
    return resolve(this.campaignDir(campaignId), 'campaign.json');
  }

  nodesLatestPath(campaignId: string): string {
    return resolve(this.campaignDir(campaignId), 'nodes_latest.json');
  }

  nodesLogPath(campaignId: string): string {
    return resolve(this.campaignDir(campaignId), 'nodes_log.jsonl');
  }

  artifactPath(campaignId: string, artifactType: string, artifactName: string): string {
    return resolve(this.campaignDir(campaignId), 'artifacts', artifactType, artifactName);
  }

  globalIdempotencyPath(): string {
    return resolve(this.globalRoot, 'idempotency_store.json');
  }

  campaignIdempotencyPath(campaignId: string): string {
    return resolve(this.campaignDir(campaignId), 'idempotency_store.json');
  }

  mutationLockPath(campaignId: string | null): string {
    return resolve(campaignId === null ? this.globalRoot : this.campaignDir(campaignId), '.lock.lck');
  }

  loadCampaign<T extends Record<string, unknown>>(campaignId: string): T | null {
    return readJsonFile<T | null>(this.campaignManifestPath(campaignId), null);
  }

  saveCampaign(campaign: Record<string, unknown> & { campaign_id: string }): void {
    writeJsonFileAtomic(this.campaignManifestPath(campaign.campaign_id), campaign);
  }

  loadNodes<T extends Record<string, unknown>>(campaignId: string): Record<string, T> {
    return readJsonFile<Record<string, T>>(this.nodesLatestPath(campaignId), {});
  }

  saveNodes(campaignId: string, nodes: Record<string, unknown>): void {
    writeJsonFileAtomic(this.nodesLatestPath(campaignId), nodes);
  }

  appendNodeLog(
    campaignId: string,
    node: Record<string, unknown>,
    mutation: string,
    extra?: Record<string, unknown>,
  ): void {
    appendJsonLine(this.nodesLogPath(campaignId), {
      mutation,
      node_id: node.node_id,
      revision: node.revision,
      ...(extra ?? {}),
      node,
    });
  }

  writeArtifact(
    campaignId: string,
    artifactType: string,
    artifactName: string,
    payload: Record<string, unknown>,
  ): string {
    const path = this.artifactPath(campaignId, artifactType, artifactName);
    writeJsonFileAtomic(path, payload);
    return pathToFileURL(path).href;
  }

  portableArtifactRef(path: string, contentHash: string): string {
    if (!SHA256_HASH_RE.test(contentHash)) {
      throw new Error(`artifact hash must be sha256:<64 lowercase hex>, got ${contentHash}`);
    }
    const absolutePath = resolve(path);
    if (!insideOrEqual(absolutePath, this.projectRoot)) {
      throw new Error(`artifact path outside project root: ${path}`);
    }
    if (!insideOrEqual(absolutePath, this.rootDir)) {
      throw new Error(`artifact path outside store root: ${path}`);
    }
    const rel = relative(this.projectRoot, absolutePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`artifact path is not project-relative: ${path}`);
    }
    return `project://${encodeProjectPath(rel)}#${contentHash}`;
  }

  artifactHashFromRef(artifactRef: string): string | null {
    if (!artifactRef.startsWith('project://')) {
      return null;
    }
    return this.parseProjectArtifactRef(artifactRef).hash;
  }

  artifactPathFromRef(artifactRef: string): string {
    if (artifactRef.startsWith('file://')) {
      const url = new URL(artifactRef);
      const path = resolve(fileURLToPath(url));
      if (!insideOrEqual(path, this.rootDir)) {
        throw new Error(`artifact ref outside store root: ${artifactRef}`);
      }
      return path;
    }

    if (artifactRef.startsWith('project://')) {
      return this.parseProjectArtifactRef(artifactRef).path;
    }

    throw new Error(`unsupported artifact ref: ${artifactRef}`);
  }

  loadArtifactFromRef<T extends Record<string, unknown>>(artifactRef: string): T {
    const path = this.artifactPathFromRef(artifactRef);
    if (!existsSync(path)) {
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }

    return readJsonFile<T>(path, {} as T);
  }

  private parseProjectArtifactRef(artifactRef: string): { hash: string | null; path: string } {
    const body = artifactRef.slice('project://'.length);
    const hashStart = body.indexOf('#');
    if (hashStart === -1) {
      throw new Error(`project artifact ref must include a sha256 fragment: ${artifactRef}`);
    }
    const encodedPath = body.slice(0, hashStart);
    const hash = body.slice(hashStart + 1);
    if (!encodedPath || encodedPath.startsWith('/')) {
      throw new Error(`project artifact ref must contain a relative path: ${artifactRef}`);
    }
    if (!SHA256_HASH_RE.test(hash)) {
      throw new Error(`project artifact ref hash must be sha256:<64 lowercase hex>: ${artifactRef}`);
    }

    const segments = encodedPath.split('/');
    if (segments.some(segment => segment.length === 0)) {
      throw new Error(`project artifact ref path has an empty segment: ${artifactRef}`);
    }
    let decodedSegments: string[];
    try {
      decodedSegments = segments.map(segment => decodeURIComponent(segment));
    } catch {
      throw new Error(`project artifact ref path has invalid percent encoding: ${artifactRef}`);
    }
    if (decodedSegments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('/'))) {
      throw new Error(`project artifact ref path has an unsafe segment: ${artifactRef}`);
    }

    const path = resolve(this.projectRoot, ...decodedSegments);
    if (!insideOrEqual(path, this.projectRoot)) {
      throw new Error(`project artifact ref outside project root: ${artifactRef}`);
    }
    if (!insideOrEqual(path, this.rootDir)) {
      throw new Error(`project artifact ref outside store root: ${artifactRef}`);
    }

    return { hash, path };
  }

  loadIdempotency<T extends Record<string, unknown>>(campaignId: string | null): Record<string, T> {
    const path = campaignId === null
      ? this.globalIdempotencyPath()
      : this.campaignIdempotencyPath(campaignId);
    return readJsonFile<Record<string, T>>(path, {});
  }

  saveIdempotency(campaignId: string | null, payload: Record<string, unknown>): void {
    const path = campaignId === null
      ? this.globalIdempotencyPath()
      : this.campaignIdempotencyPath(campaignId);
    writeJsonFileAtomic(path, payload);
  }

  withMutationLock<T>(campaignId: string | null, fn: () => T): T {
    return withLock(this.mutationLockPath(campaignId), fn);
  }
}
