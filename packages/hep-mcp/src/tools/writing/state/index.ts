/**
 * State management module exports
 *
 * This module provides the foundational infrastructure for Phase 11
 * streaming output implementation:
 *
 * - atomicWrite: Atomic file operations with fsync
 * - normalizeText: LaTeX text normalization
 * - testable: Dependency injection interfaces for testing
 * - lockManager: File-based locking with TTL and heartbeat
 */

// Atomic file operations
export {
  atomicWrite,
  atomicWriteJson,
  atomicReadJson,
  type AtomicWriteOptions,
} from './atomicWrite.js';

// LaTeX text normalization
export {
  normalizeText,
  normalizeTextWithHash,
  hasContentChanged,
} from './normalizeText.js';

// Testable interfaces and utilities
export {
  // Interfaces
  type Clock,
  type Random,
  type Host,
  type TestableServices,

  // Mock implementations
  MockClock,
  MockRandom,
  MockHost,
  createMockServices,

  // Default implementations
  systemClock,
  cryptoRandom,
  systemHost,
  defaultServices,

  // Utilities
  sleep,
  sha256,
  sha256Short,
  isNodeError,
} from './testable.js';

// Lock manager
export {
  LockManager,
  withLock,
  type LockConfig,
  type LockFileContent,
  type Lock,
  type LockResult,
} from './lockManager.js';
