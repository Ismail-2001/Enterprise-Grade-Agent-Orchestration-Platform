export class AsyncSemaphore {
  private current: number;
  private waiters: Array<() => void> = [];

  constructor(private max: number) {
    if (max < 1) throw new Error("Semaphore max must be >= 1");
    this.current = 0;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
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
