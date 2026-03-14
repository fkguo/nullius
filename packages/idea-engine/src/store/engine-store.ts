import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { appendJsonLine, readJsonFile, writeJsonFileAtomic } from './file-io.js';
import { withLock } from './file-lock.js';

export class IdeaEngineStore {
  readonly rootDir: string;
  readonly campaignsRoot: string;
  readonly globalRoot: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
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

  appendNodeLog(campaignId: string, node: Record<string, unknown>, mutation: string): void {
    appendJsonLine(this.nodesLogPath(campaignId), {
      mutation,
      node_id: node.node_id,
      revision: node.revision,
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

  loadArtifactFromRef<T extends Record<string, unknown>>(artifactRef: string): T {
    const url = new URL(artifactRef);
    if (url.protocol !== 'file:') {
      throw new Error(`unsupported artifact ref: ${artifactRef}`);
    }

    const path = resolve(fileURLToPath(url));
    if (!path.startsWith(`${this.rootDir}/`)) {
      throw new Error(`artifact ref outside store root: ${artifactRef}`);
    }
    if (!existsSync(path)) {
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }

    return readJsonFile<T>(path, {} as T);
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
