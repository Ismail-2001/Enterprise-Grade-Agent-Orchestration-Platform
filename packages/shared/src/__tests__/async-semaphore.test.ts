import { AsyncSemaphore } from "../grpc/async-semaphore";

describe("AsyncSemaphore", () => {
  it("acquires immediately when under capacity", async () => {
    const sem = new AsyncSemaphore(3);
    const ok = await sem.acquire();
    expect(ok).toBe(true);
    expect(sem.running).toBe(1);
  });

  it("waits when at capacity", async () => {
    const sem = new AsyncSemaphore(1);
    await sem.acquire();
    const p = sem.acquire(100);
    expect(sem.pending).toBe(1);
    sem.release();
    const ok = await p;
    expect(ok).toBe(true);
  });

  it("returns false on timeout", async () => {
    const sem = new AsyncSemaphore(1);
    await sem.acquire();
    const ok = await sem.acquire(50);
    expect(ok).toBe(false);
    expect(sem.pending).toBe(0);
    expect(sem.running).toBe(1);
  });

  it("rejects when max < 1", () => {
    expect(() => new AsyncSemaphore(0)).toThrow();
    expect(() => new AsyncSemaphore(-1)).toThrow();
  });

  it("tracks running and pending correctly under load", async () => {
    const sem = new AsyncSemaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.running).toBe(2);
    expect(sem.pending).toBe(0);

    const p3 = sem.acquire(200);
    expect(sem.pending).toBe(1);

    sem.release();
    const ok3 = await p3;
    expect(ok3).toBe(true);
    expect(sem.running).toBe(2);
    expect(sem.pending).toBe(0);

    sem.release();
    sem.release();
    expect(sem.running).toBe(0);
  });
});
