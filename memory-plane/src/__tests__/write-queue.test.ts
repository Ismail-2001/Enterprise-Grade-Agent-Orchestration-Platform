import { MemoryWriteQueue } from "../write-queue";

describe("MemoryWriteQueue (write-ahead log)", () => {
  it("should enqueue and flush writes to the repository", async () => {
    const repo = { set: jest.fn().mockResolvedValue(undefined) } as any;
    const wal = new MemoryWriteQueue(repo, { backoffBaseMs: 1, maxAttempts: 3 });

    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k1", value: { v: 1 } });
    expect(wal.pending).toBe(1);

    await wal.flushAll();
    expect(wal.pending).toBe(0);
    expect(repo.set).toHaveBeenCalledWith("ns", "a1", "k1", { v: 1 }, undefined);
    wal.dispose();
  });

  it("should retry transient failures and eventually succeed", async () => {
    const repo = { set: jest.fn() } as any;
    repo.set.mockRejectedValueOnce(new Error("conn reset")).mockResolvedValueOnce(undefined);
    const wal = new MemoryWriteQueue(repo, { backoffBaseMs: 1, maxAttempts: 5 });

    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k1", value: { v: 1 } });
    await wal.flushAll();

    expect(repo.set).toHaveBeenCalledTimes(2);
    expect(wal.pending).toBe(0);
    wal.dispose();
  });

  it("should drop writes that exhaust all attempts", async () => {
    const repo = { set: jest.fn().mockRejectedValue(new Error("persistent")) } as any;
    const wal = new MemoryWriteQueue(repo, { backoffBaseMs: 1, maxAttempts: 2 });

    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k1", value: { v: 1 } });
    await wal.flushAll();

    expect(repo.set).toHaveBeenCalledTimes(2);
    expect(wal.pending).toBe(0);
    wal.dispose();
  });

  it("should flush multiple queued writes in order", async () => {
    const repo = { set: jest.fn().mockResolvedValue(undefined) } as any;
    const wal = new MemoryWriteQueue(repo, { backoffBaseMs: 1 });

    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k1", value: { v: 1 } });
    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k2", value: { v: 2 } });
    await wal.flushAll();

    expect(repo.set).toHaveBeenCalledTimes(2);
    expect(repo.set).toHaveBeenNthCalledWith(1, "ns", "a1", "k1", { v: 1 }, undefined);
    expect(repo.set).toHaveBeenNthCalledWith(2, "ns", "a1", "k2", { v: 2 }, undefined);
    expect(wal.pending).toBe(0);
    wal.dispose();
  });

  it("should drop the oldest write when the queue is full", async () => {
    jest.useFakeTimers();
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repo = { set: jest.fn() } as any;
    repo.set.mockRejectedValueOnce(new Error("conn reset")).mockResolvedValue(undefined);
    const wal = new MemoryWriteQueue(repo, { maxQueueSize: 2, backoffBaseMs: 1000, maxAttempts: 5 });

    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k1", value: { v: 1 } });
    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k2", value: { v: 2 } });
    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k3", value: { v: 3 } });

    expect(wal.pending).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls[0]?.[0] ?? "")).toContain("dropped oldest write");

    await jest.advanceTimersByTimeAsync(3000);
    expect(repo.set).toHaveBeenCalledWith("ns", "a1", "k2", { v: 2 }, undefined);
    expect(repo.set).toHaveBeenCalledWith("ns", "a1", "k3", { v: 3 }, undefined);
    expect(wal.pending).toBe(0);

    stderrSpy.mockRestore();
    jest.useRealTimers();
    wal.dispose();
  });

  it("should handle a zero-size queue without crashing", async () => {
    const repo = { set: jest.fn().mockResolvedValue(undefined) } as any;
    const wal = new MemoryWriteQueue(repo, { maxQueueSize: 0, backoffBaseMs: 1 });

    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k1", value: { v: 1 } });
    await wal.flushAll();

    expect(repo.set).toHaveBeenCalledTimes(1);
    expect(wal.pending).toBe(0);
    wal.dispose();
  });

  it("should reject enqueues after dispose", async () => {
    const repo = { set: jest.fn().mockResolvedValue(undefined) } as any;
    const wal = new MemoryWriteQueue(repo);

    await wal.dispose();
    expect(wal.enqueue({ namespace: "ns", agentId: "a1", key: "k1", value: { v: 1 } })).toBe(false);
  });

  it("should finish flushing pending writes when disposed", async () => {
    const repo = { set: jest.fn().mockResolvedValue(undefined) } as any;
    const wal = new MemoryWriteQueue(repo, { backoffBaseMs: 1 });

    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k1", value: { v: 1 } });
    wal.enqueue({ namespace: "ns", agentId: "a1", key: "k2", value: { v: 2 } });
    await wal.dispose();

    expect(repo.set).toHaveBeenCalledTimes(2);
    expect(wal.pending).toBe(0);
  });
});
