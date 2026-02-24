/**
 * State module tests
 *
 * Tests for Phase 11.0 infrastructure:
 * - atomicWrite: atomic file operations
 * - normalizeText: LaTeX text normalization
 * - testable: dependency injection
 * - lockManager: file-based locking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  atomicWrite,
  atomicWriteJson,
  atomicReadJson,
} from '../../src/tools/writing/state/atomicWrite.js';

import {
  normalizeText,
  normalizeTextWithHash,
  hasContentChanged,
} from '../../src/tools/writing/state/normalizeText.js';

import {
  MockClock,
  MockRandom,
  MockHost,
  createMockServices,
  sha256,
  sha256Short,
  sleep,
} from '../../src/tools/writing/state/testable.js';

import {
  LockManager,
  withLock,
} from '../../src/tools/writing/state/lockManager.js';

// =============================================================================
// atomicWrite Tests
// =============================================================================

describe('atomicWrite', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should write file atomically', async () => {
    const filePath = path.join(testDir, 'test.txt');
    await atomicWrite(filePath, 'Hello, World!');

    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toBe('Hello, World!');
  });

  it('should create parent directories', async () => {
    const filePath = path.join(testDir, 'deep', 'nested', 'file.txt');
    await atomicWrite(filePath, 'nested content');

    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toBe('nested content');
  });

  it('should overwrite existing file', async () => {
    const filePath = path.join(testDir, 'test.txt');
    await atomicWrite(filePath, 'first');
    await atomicWrite(filePath, 'second');

    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toBe('second');
  });

  it('should not leave temp files on success', async () => {
    const filePath = path.join(testDir, 'test.txt');
    await atomicWrite(filePath, 'content');

    const files = await fsp.readdir(testDir);
    expect(files).toEqual(['test.txt']);
  });

  describe('atomicWriteJson', () => {
    it('should write JSON with pretty print', async () => {
      const filePath = path.join(testDir, 'data.json');
      await atomicWriteJson(filePath, { key: 'value', num: 42 });

      const content = await fsp.readFile(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual({ key: 'value', num: 42 });
      expect(content).toContain('\n');  // Pretty printed
    });
  });

  describe('atomicReadJson', () => {
    it('should read JSON file', async () => {
      const filePath = path.join(testDir, 'data.json');
      await atomicWriteJson(filePath, { foo: 'bar' });

      const result = await atomicReadJson<{ foo: string }>(filePath);
      expect(result).toEqual({ foo: 'bar' });
    });

    it('should throw on missing file after retries', async () => {
      const filePath = path.join(testDir, 'nonexistent.json');
      await expect(atomicReadJson(filePath, 2, 10)).rejects.toThrow();
    });
  });
});

// =============================================================================
// normalizeText Tests
// =============================================================================

describe('normalizeText', () => {
  it('should normalize line endings', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('should remove % comments', () => {
    const input = 'text % this is a comment';
    expect(normalizeText(input)).toBe('text');
  });

  it('should preserve escaped percent \\%', () => {
    const input = '90\\% efficiency';
    expect(normalizeText(input)).toBe('90\\% efficiency');
  });

  it('should handle \\\\% correctly (double backslash + comment)', () => {
    // \\% means: line ends with \\ (newline in LaTeX) followed by % comment
    const input = 'line end \\\\% comment';
    const result = normalizeText(input);
    expect(result).toBe('line end \\\\');
    expect(result).not.toContain('comment');
  });

  it('should handle mixed \\% and % correctly', () => {
    // "90\% with 5% comment" - the \% is protected, but 5% starts a comment
    // Result: "90\% with 5" (5 is kept, % and after removed)
    const input = '90\\% with 5% comment';
    const result = normalizeText(input);
    expect(result).toContain('90\\%');
    expect(result).toContain('with');
    expect(result).not.toContain('comment');
    expect(result).toBe('90\\% with 5');
  });

  it('should normalize whitespace', () => {
    expect(normalizeText('a   b\t\tc')).toBe('a b c');
  });

  it('should remove trailing spaces on lines', () => {
    expect(normalizeText('line1   \nline2')).toBe('line1\nline2');
  });

  it('should normalize LaTeX spacing commands', () => {
    expect(normalizeText('a\\,b')).toBe('a b');
    expect(normalizeText('a\\ b')).toBe('a b');
    expect(normalizeText('a~b')).toBe('a b');
  });

  it('should trim result', () => {
    expect(normalizeText('  text  ')).toBe('text');
  });

  describe('normalizeTextWithHash', () => {
    it('should return normalized text and hash', () => {
      const result = normalizeTextWithHash('some text');
      expect(result.normalized).toBe('some text');
      expect(result.hash).toBeDefined();
      expect(typeof result.hash).toBe('string');
    });

    it('should produce same hash for equivalent texts', () => {
      const result1 = normalizeTextWithHash('text % comment');
      const result2 = normalizeTextWithHash('text');
      expect(result1.hash).toBe(result2.hash);
    });
  });

  describe('hasContentChanged', () => {
    it('should detect real changes', () => {
      expect(hasContentChanged('old', 'new')).toBe(true);
    });

    it('should ignore cosmetic changes', () => {
      expect(hasContentChanged('text % comment1', 'text % comment2')).toBe(false);
      expect(hasContentChanged('a  b', 'a b')).toBe(false);
    });
  });
});

// =============================================================================
// testable Tests
// =============================================================================

describe('testable', () => {
  describe('MockClock', () => {
    it('should return initial time', () => {
      const clock = new MockClock(1000);
      expect(clock.nowMs()).toBe(1000);
    });

    it('should advance time', () => {
      const clock = new MockClock(1000);
      clock.advance(500);
      expect(clock.nowMs()).toBe(1500);
    });

    it('should set absolute time', () => {
      const clock = new MockClock(1000);
      clock.setTime(5000);
      expect(clock.nowMs()).toBe(5000);
    });

    it('should return ISO string', () => {
      const clock = new MockClock(new Date('2025-01-01T00:00:00Z'));
      expect(clock.nowIso()).toBe('2025-01-01T00:00:00.000Z');
    });
  });

  describe('MockRandom', () => {
    it('should generate sequential UUIDs', () => {
      const random = new MockRandom('test');
      const uuid1 = random.uuid();
      const uuid2 = random.uuid();

      expect(uuid1).not.toBe(uuid2);
      expect(uuid1).toContain('test');
    });

    it('should generate hex strings', () => {
      const random = new MockRandom();
      const hex = random.hex(8);
      expect(hex).toHaveLength(16);
    });

    it('should generate nonces', () => {
      const random = new MockRandom('test');
      const nonce = random.nonce();
      expect(nonce).toContain('test-nonce-');
    });

    it('should reset counters', () => {
      const random = new MockRandom('test');
      const first = random.uuid();  // 0000
      random.uuid();                // 0001
      random.reset();
      const afterReset = random.uuid();  // Back to 0000
      expect(afterReset).toBe(first);  // Same as first
    });
  });

  describe('MockHost', () => {
    it('should return configured values', () => {
      const host = new MockHost('myhost', 9999);
      expect(host.hostname()).toBe('myhost');
      expect(host.pid()).toBe(9999);
      expect(host.identity()).toBe('myhost:9999');
    });
  });

  describe('createMockServices', () => {
    it('should create services with defaults', () => {
      const services = createMockServices();
      expect(services.clock).toBeDefined();
      expect(services.random).toBeDefined();
      expect(services.host).toBeDefined();
    });

    it('should accept custom options', () => {
      const services = createMockServices({
        clockTime: 12345,
        hostname: 'custom-host',
        pid: 1234,
      });
      expect(services.clock.nowMs()).toBe(12345);
      expect(services.host.hostname()).toBe('custom-host');
    });
  });

  describe('sha256 utilities', () => {
    it('sha256 should return full hash', () => {
      const hash = sha256('test');
      expect(hash).toHaveLength(64);
    });

    it('sha256Short should return short hash', () => {
      const hash = sha256Short('test');
      expect(hash).toHaveLength(16);
    });

    it('same input should produce same hash', () => {
      expect(sha256('test')).toBe(sha256('test'));
    });
  });
});

// =============================================================================
// LockManager Tests
// =============================================================================

describe('LockManager', () => {
  let testDir: string;
  let lockManager: LockManager;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    lockManager = new LockManager({
      ttlMs: 5000,
      heartbeatMs: 1000,
      retryMs: 50,
      maxRetries: 10,
    });
  });

  afterEach(async () => {
    await lockManager.releaseAll();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('acquire and release', () => {
    it('should acquire lock successfully', async () => {
      const resourcePath = path.join(testDir, 'resource');
      const result = await lockManager.acquire(resourcePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.lock.lockPath).toBe(`${resourcePath}.lock`);
        expect(result.lock.nonce).toBeDefined();
      }
    });

    it('should create lock file', async () => {
      const resourcePath = path.join(testDir, 'resource');
      const result = await lockManager.acquire(resourcePath);

      expect(result.success).toBe(true);
      expect(fs.existsSync(`${resourcePath}.lock`)).toBe(true);
    });

    it('should release lock and delete file', async () => {
      const resourcePath = path.join(testDir, 'resource');
      const result = await lockManager.acquire(resourcePath);

      expect(result.success).toBe(true);
      if (result.success) {
        await lockManager.release(result.lock);
        expect(fs.existsSync(`${resourcePath}.lock`)).toBe(false);
      }
    });

    it('should fail to acquire already held lock', async () => {
      const resourcePath = path.join(testDir, 'resource');

      // First acquisition
      const result1 = await lockManager.acquire(resourcePath);
      expect(result1.success).toBe(true);

      // Second acquisition should fail (with short timeout)
      const manager2 = new LockManager({ retryMs: 10, maxRetries: 3 });
      const result2 = await manager2.acquire(resourcePath);
      expect(result2.success).toBe(false);
    });
  });

  describe('isLocked', () => {
    it('should return true for locked resource', async () => {
      const resourcePath = path.join(testDir, 'resource');
      await lockManager.acquire(resourcePath);

      expect(await lockManager.isLocked(resourcePath)).toBe(true);
    });

    it('should return false for unlocked resource', async () => {
      const resourcePath = path.join(testDir, 'resource');
      expect(await lockManager.isLocked(resourcePath)).toBe(false);
    });
  });

  describe('getLockInfo', () => {
    it('should return lock info', async () => {
      const resourcePath = path.join(testDir, 'resource');
      const result = await lockManager.acquire(resourcePath, { purpose: 'test' });

      expect(result.success).toBe(true);
      const info = await lockManager.getLockInfo(resourcePath);
      expect(info).not.toBeNull();
      expect(info?.purpose).toBe('test');
      expect(info?.nonce).toBeDefined();
    });

    it('should return null for unlocked resource', async () => {
      const resourcePath = path.join(testDir, 'resource');
      const info = await lockManager.getLockInfo(resourcePath);
      expect(info).toBeNull();
    });
  });

  describe('withLock helper', () => {
    it('should execute function with lock', async () => {
      const resourcePath = path.join(testDir, 'resource');
      let executed = false;

      await withLock(resourcePath, async () => {
        executed = true;
        expect(fs.existsSync(`${resourcePath}.lock`)).toBe(true);
      });

      expect(executed).toBe(true);
      expect(fs.existsSync(`${resourcePath}.lock`)).toBe(false);
    });

    it('should release lock on error', async () => {
      const resourcePath = path.join(testDir, 'resource');

      await expect(withLock(resourcePath, async () => {
        throw new Error('test error');
      })).rejects.toThrow('test error');

      expect(fs.existsSync(`${resourcePath}.lock`)).toBe(false);
    });

    it('should return function result', async () => {
      const resourcePath = path.join(testDir, 'resource');
      const result = await withLock(resourcePath, async () => 42);
      expect(result).toBe(42);
    });
  });

  describe('expired lock cleanup', () => {
    it('should clean up expired lock', async () => {
      const resourcePath = path.join(testDir, 'resource');

      // Create a mock expired lock
      const expiredLock = {
        nonce: 'expired-nonce',
        holder: 'old-host:1234',
        acquired_at: '2020-01-01T00:00:00.000Z',
        heartbeat_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-01T00:00:01.000Z',  // Expired
      };

      await fsp.mkdir(testDir, { recursive: true });
      await fsp.writeFile(
        `${resourcePath}.lock`,
        JSON.stringify(expiredLock, null, 2)
      );

      // Should acquire after cleaning expired lock
      const result = await lockManager.acquire(resourcePath);
      expect(result.success).toBe(true);
    });
  });

  describe('mock services integration', () => {
    it('should use injected clock for expiration', async () => {
      const mockServices = createMockServices({
        clockTime: new Date('2025-01-01T00:00:00Z'),
      });

      const manager = new LockManager({ ttlMs: 5000 }, mockServices);
      const resourcePath = path.join(testDir, 'resource');
      const result = await manager.acquire(resourcePath);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.lock.acquiredAt.toISOString()).toBe('2025-01-01T00:00:00.000Z');
        expect(result.lock.expiresAt.toISOString()).toBe('2025-01-01T00:00:05.000Z');
      }
    });
  });
});
