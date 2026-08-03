import type { MemoryPlaneRepository } from "./repository";

export interface MemoryWriteOp {
  namespace: string;
  agentId: string;
  key: string;
  value: Record<string, unknown>;
  ttlSeconds?: number;
  attempts: number;
}

export class MemoryWriteQueue {
  private readonly repo: MemoryPlaneRepository;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxQueueSize: number;
  private queue: MemoryWriteOp[] = [];
  private flushPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(
    repo: MemoryPlaneRepository,
    opts: { maxAttempts?: number; backoffBaseMs?: number; maxQueueSize?: number } = {}
  ) {
    this.repo = repo;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.maxQueueSize = opts.maxQueueSize ?? 10_000;
  }

  enqueue(op: Omit<MemoryWriteOp, "attempts">): boolean {
    if (this.disposed) return false;
    if (this.queue.length >= this.maxQueueSize) {
      this.dropOldest();
    }
    this.queue.push({ ...op, attempts: 0 });
    this.flushPromise ??= this.flush();
    return true;
  }

  get pending(): number {
    return this.queue.length;
  }

  async flushAll(): Promise<void> {
    if (this.flushPromise) await this.flushPromise;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.flushAll();
  }

  private dropOldest(): void {
    const dropped = this.queue.shift();
    if (dropped) {
      process.stderr.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          message: `Memory write queue full; dropped oldest write for ${dropped.agentId}/${dropped.key}`,
        }) + "\n"
      );
    }
  }

  private async flush(): Promise<void> {
    while (!this.disposed || this.queue.length > 0) {
      const op = this.queue[0];
      if (!op) break;

      try {
        await this.repo.set(op.namespace, op.agentId, op.key, op.value, op.ttlSeconds);
        this.queue.shift();
      } catch {
        op.attempts += 1;
        if (op.attempts >= this.maxAttempts) {
          this.queue.shift();
          process.stderr.write(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "error",
              message: `Memory durable write permanently failed after ${op.attempts} attempts for ${op.agentId}/${op.key}`,
            }) + "\n"
          );
        } else {
          await this.delay(this.backoffBaseMs * 2 ** (op.attempts - 1));
        }
      }
    }
    this.flushPromise = null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
