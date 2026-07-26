interface Waiter {
  resolve: (value: boolean) => void;
  timer?: NodeJS.Timeout;
}

export class AsyncSemaphore {
  private current: number;
  private waiters: Waiter[] = [];

  constructor(private max: number) {
    if (max < 1) throw new Error("Semaphore max must be >= 1");
    this.current = 0;
  }

  /**
   * Acquire a semaphore slot. Returns `true` if acquired, `false` if
   * `timeoutMs` elapsed before a slot became available.
   * When `timeoutMs` is omitted, waits indefinitely.
   */
  async acquire(timeoutMs?: number): Promise<boolean> {
    if (this.current < this.max) {
      this.current++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { resolve };
      if (timeoutMs && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            resolve(false);
          }
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve(true);
      // current stays the same — the waiter becomes the runner
    } else if (this.current > 0) {
      this.current--;
    }
  }

  get pending(): number {
    return this.waiters.length;
  }

  get running(): number {
    return this.current;
  }
}
