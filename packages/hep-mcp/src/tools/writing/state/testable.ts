/**
 * Testable interfaces for dependency injection
 *
 * These interfaces allow mocking time, random values, and host info
 * in tests, enabling deterministic and reproducible test scenarios.
 */

import * as crypto from 'crypto';
import * as os from 'os';

/**
 * Clock interface for time-related operations
 *
 * Allows injecting a mock clock for tests
 */
export interface Clock {
  /** Current time in milliseconds since epoch */
  nowMs(): number;

  /** Current time as ISO 8601 string */
  nowIso(): string;

  /** Create a Date object for current time */
  now(): Date;
}

/**
 * Random interface for random value generation
 *
 * Allows injecting deterministic values for tests
 */
export interface Random {
  /** Generate a UUID v4 */
  uuid(): string;

  /** Generate random bytes as hex string */
  hex(bytes: number): string;

  /** Generate a nonce for lock files */
  nonce(): string;
}

/**
 * Host interface for host/process information
 *
 * Allows injecting mock host info for tests
 */
export interface Host {
  /** Current process ID */
  pid(): number;

  /** Hostname of the machine */
  hostname(): string;

  /** Unique identifier for this host+process */
  identity(): string;
}

/**
 * Combined testable services interface
 */
export interface TestableServices {
  clock: Clock;
  random: Random;
  host: Host;
}

// =============================================================================
// Default Implementations
// =============================================================================

/**
 * Default clock implementation using system time
 */
class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  now(): Date {
    return new Date();
  }
}

/**
 * Default random implementation using crypto
 */
class CryptoRandom implements Random {
  uuid(): string {
    return crypto.randomUUID();
  }

  hex(bytes: number): string {
    return crypto.randomBytes(bytes).toString('hex');
  }

  nonce(): string {
    // Format: timestamp-random for debugging
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(8).toString('hex');
    return `${timestamp}-${random}`;
  }
}

/**
 * Default host implementation using OS module
 */
class SystemHost implements Host {
  private readonly _hostname: string;
  private readonly _pid: number;
  private readonly _identity: string;

  constructor() {
    this._hostname = os.hostname();
    this._pid = process.pid;
    this._identity = `${this._hostname}:${this._pid}`;
  }

  pid(): number {
    return this._pid;
  }

  hostname(): string {
    return this._hostname;
  }

  identity(): string {
    return this._identity;
  }
}

// =============================================================================
// Mock Implementations (for tests)
// =============================================================================

/**
 * Mock clock that can be controlled in tests
 */
export class MockClock implements Clock {
  private currentTime: number;

  constructor(initialTime: Date | number = Date.now()) {
    this.currentTime = typeof initialTime === 'number'
      ? initialTime
      : initialTime.getTime();
  }

  nowMs(): number {
    return this.currentTime;
  }

  nowIso(): string {
    return new Date(this.currentTime).toISOString();
  }

  now(): Date {
    return new Date(this.currentTime);
  }

  /** Advance time by specified milliseconds */
  advance(ms: number): void {
    this.currentTime += ms;
  }

  /** Set time to specific value */
  setTime(time: Date | number): void {
    this.currentTime = typeof time === 'number' ? time : time.getTime();
  }
}

/**
 * Mock random that returns deterministic values
 */
export class MockRandom implements Random {
  private uuidCounter = 0;
  private hexCounter = 0;
  private nonceCounter = 0;

  private readonly prefix: string;

  constructor(prefix = 'test') {
    this.prefix = prefix;
  }

  uuid(): string {
    const seq = (this.uuidCounter++).toString().padStart(4, '0');
    return `${this.prefix}-uuid-0000-0000-${seq.padStart(12, '0')}`;
  }

  hex(bytes: number): string {
    const seq = (this.hexCounter++).toString(16).padStart(bytes * 2, '0');
    return seq.slice(0, bytes * 2);
  }

  nonce(): string {
    const seq = this.nonceCounter++;
    return `${this.prefix}-nonce-${seq}`;
  }

  /** Reset all counters */
  reset(): void {
    this.uuidCounter = 0;
    this.hexCounter = 0;
    this.nonceCounter = 0;
  }
}

/**
 * Mock host for tests
 */
export class MockHost implements Host {
  private readonly _hostname: string;
  private readonly _pid: number;

  constructor(hostname = 'test-host', pid = 12345) {
    this._hostname = hostname;
    this._pid = pid;
  }

  pid(): number {
    return this._pid;
  }

  hostname(): string {
    return this._hostname;
  }

  identity(): string {
    return `${this._hostname}:${this._pid}`;
  }
}

// =============================================================================
// Singleton Default Services
// =============================================================================

/** Default system clock */
export const systemClock: Clock = new SystemClock();

/** Default crypto random */
export const cryptoRandom: Random = new CryptoRandom();

/** Default system host */
export const systemHost: Host = new SystemHost();

/** Default testable services using system implementations */
export const defaultServices: TestableServices = {
  clock: systemClock,
  random: cryptoRandom,
  host: systemHost,
};

/**
 * Create a mock services object for testing
 */
export function createMockServices(options?: {
  clock?: Clock;
  random?: Random;
  host?: Host;
  clockTime?: Date | number;
  randomPrefix?: string;
  hostname?: string;
  pid?: number;
}): TestableServices {
  return {
    clock: options?.clock ?? new MockClock(options?.clockTime),
    random: options?.random ?? new MockRandom(options?.randomPrefix),
    host: options?.host ?? new MockHost(options?.hostname, options?.pid),
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Sleep helper function
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Simple SHA256 hash (first 16 hex chars)
 */
export function sha256Short(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
}

/**
 * Full SHA256 hash
 */
export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Type guard for Node.js errors with error code
 *
 * @example
 * try { ... } catch (error) {
 *   if (isNodeError(error, 'ENOENT')) { ... }
 * }
 */
export function isNodeError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: string }).code === code
  );
}
