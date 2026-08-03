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
});
