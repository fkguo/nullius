/**
 * Lock Manager with TTL, heartbeat, and CAS-style cleanup
 *
 * Features:
 * - File-based locking with TTL
 * - Heartbeat mechanism to extend TTL
 * - CAS-style cleanup (double-read verification)
 * - Cross-platform file identity support
 * - ENOENT retry handling
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Stats } from 'fs';
import { atomicWrite } from './atomicWrite.js';
import {
  type TestableServices,
  defaultServices,
  sleep,
  sha256Short,
  isNodeError,
} from './testable.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Lock configuration
 */
export interface LockConfig {
  /** Lock TTL in milliseconds (default: 30000) */
  ttlMs: number;

  /** Heartbeat interval in milliseconds (default: ttlMs / 6 = 5000) */
  heartbeatMs: number;

  /** Max heartbeat failures before releasing lock (default: 3) */
  maxHeartbeatFailures: number;

  /** Backoff base for heartbeat retry (default: 1000) */
  heartbeatBackoffMs: number;

  /** Retry interval for lock acquisition (default: 100) */
  retryMs: number;

  /** Max retries for lock acquisition (default: 300 = 30 seconds) */
  maxRetries: number;

  /** Retry attempts for reading lock file (default: 3) */
  maxReadRetries: number;

  /** Delay between read retries (default: 20) */
  readRetryDelayMs: number;
}

/**
 * Default lock configuration
 */
const DEFAULT_CONFIG: LockConfig = {
  ttlMs: 30000,
  heartbeatMs: 5000,  // ttlMs / 6
  maxHeartbeatFailures: 3,
  heartbeatBackoffMs: 1000,
  retryMs: 100,
  maxRetries: 300,
  maxReadRetries: 3,
  readRetryDelayMs: 20,
};

/**
 * Lock file content structure
 */
export interface LockFileContent {
  nonce: string;
  holder: string;       // host:pid
  acquired_at: string;  // ISO timestamp
  heartbeat_at: string; // ISO timestamp
  expires_at: string;   // ISO timestamp
  purpose?: string;     // optional description
}

/**
 * Active lock handle
 */
export interface Lock {
  lockPath: string;
  nonce: string;
  holder: string;
  acquiredAt: Date;
  expiresAt: Date;
  purpose?: string;
  heartbeatInterval?: ReturnType<typeof setInterval>;
  heartbeatFailures: number;
}

/**
 * File identity for CAS comparison (cross-platform)
 */
interface FileIdentity {
  // Primary (Unix)
  ino?: number;
  dev?: number;

  // Fallback (Windows)
  size: number;
  mtimeMs: number;
  ctimeMs: number;

  // Content-based (most reliable)
  nonce?: string;
  contentHash?: string;
}

/**
 * Lock acquisition result
 */
export type LockResult =
  | { success: true; lock: Lock }
  | { success: false; reason: 'timeout' | 'error'; message: string };

// =============================================================================
// File Identity Functions (Cross-platform CAS)
// =============================================================================

/**
 * Extract file identity from stats and content
 */
function getFileIdentity(
  stat: Stats,
  content?: string,
  nonce?: string
): FileIdentity {
  const identity: FileIdentity = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };

  // Unix systems use inode
  if (stat.ino && stat.ino !== 0) {
    identity.ino = stat.ino;
    identity.dev = stat.dev;
  }

  // Content hash if available
  if (content) {
    identity.contentHash = sha256Short(content);
  }

  if (nonce) {
    identity.nonce = nonce;
  }

  return identity;
}

/**
 * Compare file identities for CAS verification
 *
 * Priority:
 * 1. nonce (most reliable)
 * 2. contentHash
 * 3. inode (Unix)
 * 4. stat combination (Windows fallback)
 */
function identitiesMatch(a: FileIdentity, b: FileIdentity): boolean {
  // Priority 1: nonce
  if (a.nonce && b.nonce) {
    return a.nonce === b.nonce;
  }

  // Priority 2: contentHash
  if (a.contentHash && b.contentHash) {
    return a.contentHash === b.contentHash;
  }

  // Priority 3: inode (Unix)
  if (a.ino && b.ino && a.ino !== 0 && b.ino !== 0) {
    return a.ino === b.ino && a.dev === b.dev;
  }

  // Priority 4: stat combination (Windows)
  return a.size === b.size &&
         a.mtimeMs === b.mtimeMs &&
         a.ctimeMs === b.ctimeMs;
}

// =============================================================================
// Lock Manager
// =============================================================================

/**
 * Lock Manager for file-based distributed locking
 */
export class LockManager {
  private readonly config: LockConfig;
  private readonly services: TestableServices;
  private readonly activeLocks = new Map<string, Lock>();

  constructor(
    config: Partial<LockConfig> = {},
    services: TestableServices = defaultServices
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.services = services;
  }

  /**
   * Acquire a lock on a resource
   *
   * @param resourcePath - Path to the resource to lock
   * @param options - Optional settings
   * @returns Lock result
   */
  async acquire(
    resourcePath: string,
    options?: {
      purpose?: string;
      timeout?: number;  // Override maxRetries with timeout in ms
    }
  ): Promise<LockResult> {
    const lockPath = this.getLockPath(resourcePath);
    const maxRetries = options?.timeout
      ? Math.ceil(options.timeout / this.config.retryMs)
      : this.config.maxRetries;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Try to clean expired lock
      await this.tryCleanExpiredLock(lockPath);

      // Try to acquire
      const result = await this.tryAcquire(lockPath, options?.purpose);

      if (result.success) {
        return result;
      }

      // Wait before retry
      await sleep(this.config.retryMs);
    }

    return {
      success: false,
      reason: 'timeout',
      message: `Failed to acquire lock after ${maxRetries} attempts: ${lockPath}`,
    };
  }

  /**
   * Release a lock
   */
  async release(lock: Lock): Promise<void> {
    // Stop heartbeat
    this.stopHeartbeat(lock);

    // Remove from active locks
    this.activeLocks.delete(lock.lockPath);

    // Delete lock file
    try {
      // Verify we still own the lock before deleting
      const content = await fs.readFile(lock.lockPath, 'utf-8');
      const lockInfo = JSON.parse(content) as LockFileContent;

      if (lockInfo.nonce === lock.nonce) {
        await fs.unlink(lock.lockPath);
      }
    } catch (error: unknown) {
      // Ignore ENOENT - lock already released
      if (!isNodeError(error, 'ENOENT')) {
        console.warn(`Error releasing lock: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Release all active locks (cleanup on shutdown)
   */
  async releaseAll(): Promise<void> {
    const locks = Array.from(this.activeLocks.values());
    await Promise.all(locks.map(lock => this.release(lock)));
  }

  /**
   * Check if a resource is currently locked
   */
  async isLocked(resourcePath: string): Promise<boolean> {
    const lockPath = this.getLockPath(resourcePath);

    try {
      const content = await fs.readFile(lockPath, 'utf-8');
      const lockInfo = JSON.parse(content) as LockFileContent;
      const expiresAt = new Date(lockInfo.expires_at);

      return this.services.clock.nowMs() < expiresAt.getTime();
    } catch {
      return false;
    }
  }

  /**
   * Get lock info for a resource
   */
  async getLockInfo(resourcePath: string): Promise<LockFileContent | null> {
    const lockPath = this.getLockPath(resourcePath);

    try {
      const content = await fs.readFile(lockPath, 'utf-8');
      return JSON.parse(content) as LockFileContent;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private getLockPath(resourcePath: string): string {
    return `${resourcePath}.lock`;
  }

  /**
   * Try to acquire lock (single attempt)
   */
  private async tryAcquire(
    lockPath: string,
    purpose?: string
  ): Promise<LockResult> {
    const nonce = this.services.random.nonce();
    const holder = this.services.host.identity();
    const now = this.services.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.ttlMs);

    const lockContent: LockFileContent = {
      nonce,
      holder,
      acquired_at: now.toISOString(),
      heartbeat_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      purpose,
    };

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(lockPath), { recursive: true });

      // Try exclusive create
      await fs.writeFile(lockPath, JSON.stringify(lockContent, null, 2), {
        flag: 'wx',  // Exclusive create
      });

      // Success - create lock handle
      const lock: Lock = {
        lockPath,
        nonce,
        holder,
        acquiredAt: now,
        expiresAt,
        purpose,
        heartbeatFailures: 0,
      };

      // Start heartbeat
      this.startHeartbeat(lock);

      // Track active lock
      this.activeLocks.set(lockPath, lock);

      return { success: true, lock };

    } catch (error: unknown) {
      if (isNodeError(error, 'EEXIST')) {
        // Lock exists - not an error, just couldn't acquire
        return {
          success: false,
          reason: 'timeout',
          message: 'Lock held by another process',
        };
      }

      return {
        success: false,
        reason: 'error',
        message: `Failed to acquire lock: ${(error as Error).message}`,
      };
    }
  }

  /**
   * CAS-style expired lock cleanup
   *
   * Conservative strategy:
   * - Double-read verification
   * - Parse errors trigger retry, not delete
   * - Uses FileIdentity for cross-platform comparison
   */
  private async tryCleanExpiredLock(lockPath: string): Promise<boolean> {
    const { maxReadRetries, readRetryDelayMs } = this.config;

    for (let attempt = 0; attempt < maxReadRetries; attempt++) {
      try {
        // First read
        const stat1 = await fs.stat(lockPath);
        const content1 = await fs.readFile(lockPath, 'utf-8');

        // Handle empty file
        if (content1.trim() === '') {
          await sleep(100);
          const stat2 = await fs.stat(lockPath);
          if (stat2.size === 0) {
            // Confirmed empty - safe to delete
            await fs.unlink(lockPath);
            return true;
          }
          return false;  // Being written
        }

        // Parse lock info
        let lockInfo: LockFileContent;
        try {
          lockInfo = JSON.parse(content1);
        } catch {
          // Parse error - retry instead of delete
          if (attempt < maxReadRetries - 1) {
            await sleep(readRetryDelayMs);
            continue;
          }
          console.warn(`Lock file ${lockPath} parse failed, skipping cleanup`);
          return false;
        }

        // Check expiration
        const expiresAt = new Date(lockInfo.expires_at);
        if (this.services.clock.nowMs() <= expiresAt.getTime()) {
          return false;  // Not expired
        }

        // CAS verification: second read
        await sleep(50);
        const stat2 = await fs.stat(lockPath);
        const content2 = await fs.readFile(lockPath, 'utf-8');

        let lockInfo2: LockFileContent;
        try {
          lockInfo2 = JSON.parse(content2);
        } catch {
          return false;  // Changed, don't delete
        }

        // Compare identities
        const identity1 = getFileIdentity(stat1, content1, lockInfo.nonce);
        const identity2 = getFileIdentity(stat2, content2, lockInfo2.nonce);

        if (!identitiesMatch(identity1, identity2)) {
          return false;  // File changed
        }

        // Safe to delete
        await fs.unlink(lockPath);
        return true;

      } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT')) {
          return true;  // Already gone
        }

        // Access errors - don't delete
        if (isNodeError(error, 'EBUSY') ||
            isNodeError(error, 'EPERM') ||
            isNodeError(error, 'EACCES')) {
          console.warn(`Lock file ${lockPath} access error, skipping cleanup`);
          return false;
        }

        // Unknown error - don't delete
        console.warn(`Lock cleanup error: ${(error as Error).message}`);
        return false;
      }
    }

    return false;
  }

  /**
   * Start heartbeat for a lock
   */
  private startHeartbeat(lock: Lock): void {
    lock.heartbeatInterval = setInterval(
      () => this.heartbeat(lock),
      this.config.heartbeatMs
    );

    // Don't keep process alive just for heartbeat
    if (lock.heartbeatInterval.unref) {
      lock.heartbeatInterval.unref();
    }
  }

  /**
   * Stop heartbeat for a lock
   */
  private stopHeartbeat(lock: Lock): void {
    if (lock.heartbeatInterval) {
      clearInterval(lock.heartbeatInterval);
      lock.heartbeatInterval = undefined;
    }
  }

  /**
   * Heartbeat with retry and failure tracking
   */
  private async heartbeat(lock: Lock): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.doHeartbeat(lock);
        lock.heartbeatFailures = 0;
        return;
      } catch (error) {
        lastError = error as Error;
        const backoff = this.config.heartbeatBackoffMs * Math.pow(2, attempt);
        await sleep(Math.min(backoff, 5000));
      }
    }

    // Track failure
    lock.heartbeatFailures++;

    if (lock.heartbeatFailures >= this.config.maxHeartbeatFailures) {
      console.warn(
        `Lock heartbeat failed ${lock.heartbeatFailures} times: ${lock.lockPath}. ` +
        `Last error: ${lastError?.message}`
      );
      this.stopHeartbeat(lock);
      this.activeLocks.delete(lock.lockPath);
    }
  }

  /**
   * Single heartbeat attempt
   *
   * Uses atomicWrite to avoid concurrent read issues
   */
  private async doHeartbeat(lock: Lock): Promise<void> {
    const maxRetries = Math.max(1, this.config.maxReadRetries);
    const { readRetryDelayMs } = this.config;

    // Read with retry (handles concurrent write race)
    let content: string | undefined;
    for (let i = 0; i < maxRetries; i++) {
      try {
        content = await fs.readFile(lock.lockPath, 'utf-8');
        JSON.parse(content);  // Validate JSON
        break;
      } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT')) {
          throw new Error('Lock file deleted');
        }
        if (i === maxRetries - 1) {
          throw error;
        }
        await sleep(readRetryDelayMs);
      }
    }

    // Safety check (should not happen with maxRetries >= 1)
    if (content === undefined) {
      throw new Error('Failed to read lock file');
    }

    const lockInfo = JSON.parse(content) as LockFileContent;

    // Verify ownership
    if (lockInfo.nonce !== lock.nonce) {
      throw new Error('Lock stolen');
    }

    // Update timestamps
    const now = this.services.clock.now();
    lockInfo.heartbeat_at = now.toISOString();
    lockInfo.expires_at = new Date(now.getTime() + this.config.ttlMs).toISOString();
    lock.expiresAt = new Date(lockInfo.expires_at);

    // Atomic write to avoid truncate+write race
    await atomicWrite(lock.lockPath, JSON.stringify(lockInfo, null, 2));
  }
}

/**
 * Execute a function with an exclusive lock
 *
 * @param resourcePath - Resource to lock
 * @param fn - Function to execute while holding lock
 * @param options - Lock options
 */
export async function withLock<T>(
  resourcePath: string,
  fn: () => Promise<T>,
  options?: {
    lockManager?: LockManager;
    purpose?: string;
    timeout?: number;
  }
): Promise<T> {
  const manager = options?.lockManager ?? new LockManager();
  const result = await manager.acquire(resourcePath, {
    purpose: options?.purpose,
    timeout: options?.timeout,
  });

  if (!result.success) {
    throw new Error(result.message);
  }

  try {
    return await fn();
  } finally {
    await manager.release(result.lock);
  }
}
