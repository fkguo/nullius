export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (headerValue == null) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === '') return undefined;

  const parsedSeconds = Number(trimmed);
  if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) {
    return parsedSeconds * 1000;
  }

  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isNaN(parsedDateMs)) {
    return Math.max(parsedDateMs - nowMs, 0);
  }

  return undefined;
}

export async function sleepWithAbort(
  delayMs: number,
  signal: AbortSignal,
  onAbort: () => Error,
): Promise<void> {
  if (signal.aborted) {
    throw onAbort();
  }

  await new Promise<void>((resolve, reject) => {
    const onAbortSignal = () => {
      clearTimeout(timer);
      reject(onAbort());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbortSignal);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbortSignal, { once: true });
  });
}

export class SerialTaskQueue {
  private slot = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let releaseSlot!: () => void;
    const previousSlot = this.slot;
    this.slot = new Promise<void>(resolve => {
      releaseSlot = resolve;
    });
    await previousSlot;
    try {
      return await fn();
    } finally {
      releaseSlot();
    }
  }
}

export class SerialIntervalGate {
  private readonly queue = new SerialTaskQueue();
  private lastAcquireMs = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly shouldBypass: () => boolean = () => false,
  ) {}

  async acquire(): Promise<void> {
    if (this.shouldBypass() || this.minIntervalMs <= 0) return;

    await this.queue.run(async () => {
      const elapsed = Date.now() - this.lastAcquireMs;
      if (elapsed < this.minIntervalMs) {
        await new Promise<void>(resolve => setTimeout(resolve, this.minIntervalMs - elapsed));
      }
      this.lastAcquireMs = Date.now();
    });
  }
}
