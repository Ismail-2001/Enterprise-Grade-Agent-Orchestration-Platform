import Docker from "dockerode";

const mockContainer = {
  id: "abc123def456",
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  inspect: jest.fn().mockResolvedValue({
    State: { Status: "running", Running: true, StartedAt: "2025-01-01T00:00:00Z" },
    HostConfig: { NanoCpus: 1000000000 },
    NetworkSettings: { Networks: { "egaop-sandbox": { IPAddress: "10.0.0.42" } } },
  }),
  wait: jest.fn().mockResolvedValue({ StatusCode: 0 }),
  exec: jest.fn().mockResolvedValue({
    start: jest.fn().mockResolvedValue({
      on: jest.fn((event: string, cb: any) => {
        if (event === "data") cb(Buffer.from("init-output"));
        if (event === "end") cb();
      }),
    }),
  }),
};

const mockDocker = {
  createContainer: jest.fn().mockResolvedValue(mockContainer),
  getContainer: jest.fn().mockReturnValue(mockContainer),
  listContainers: jest.fn().mockResolvedValue([]),
  ping: jest.fn().mockResolvedValue("PONG"),
};

jest.mock("dockerode", () => {
  return jest.fn().mockImplementation(() => mockDocker);
});

import { DockerSandboxDriver } from "../docker-driver";

describe("DockerSandboxDriver", () => {
  let driver: DockerSandboxDriver;

  beforeEach(() => {
    jest.clearAllMocks();
    driver = new DockerSandboxDriver(mockDocker as any);
  });

  describe("createSandbox", () => {
    it("should create container with correct settings", async () => {
      const result = await driver.createSandbox({
        executionId: "exec-1",
        agentId: "agent-1",
        namespace: "egaop",
        image: "egaop-base-runtime:latest",
        isolationLevel: "Standard",
        cpu: "0.5",
        memory: "256",
        envVars: { FOO: "bar" },
      });

      expect(result.sandboxId).toBe("abc123def456");
      expect(result.status).toBe("Running");
      expect(result.ipAddress).toBe("10.0.0.42");

      expect(mockDocker.createContainer).toHaveBeenCalledTimes(1);
      const opts = mockDocker.createContainer.mock.calls[0][0];
      expect(opts.HostConfig.NanoCpus).toBe(500_000_000);
      expect(opts.HostConfig.SecurityOpt).toContain("no-new-privileges");
      expect(opts.Env).toContain("FOO=bar");
    });

    it("should set gVisor runtime for Enhanced isolation", async () => {
      await driver.createSandbox({
        executionId: "exec-2",
        agentId: "agent-2",
        namespace: "egaop",
        image: "egaop-base-runtime:latest",
        isolationLevel: "Enhanced",
      });

      const opts = mockDocker.createContainer.mock.calls[0][0];
      expect(opts.HostConfig.Runtime).toBe("runsc");
    });

    it("should reject disallowed images", async () => {
      await expect(driver.createSandbox({
        executionId: "exec-3",
        agentId: "agent-3",
        namespace: "egaop",
        image: "ubuntu:latest",
      })).rejects.toThrow("Image not in allowlist");
    });
  });

  describe("terminateSandbox", () => {
    it("should remove container with force", async () => {
      const result = await driver.terminateSandbox("abc123def456");
      expect(result).toBe(true);
      expect(mockDocker.getContainer).toHaveBeenCalledWith("abc123def456");
      expect(mockContainer.remove).toHaveBeenCalledWith({ force: true });
    });

    it("should return false on error", async () => {
      mockContainer.remove.mockRejectedValueOnce(new Error("not found"));
      const result = await driver.terminateSandbox("abc123def456");
      expect(result).toBe(false);
    });
  });

  describe("getSandboxStatus", () => {
    it("should return status from inspect", async () => {
      const status = await driver.getSandboxStatus("abc123def456");
      expect(status.status).toBe("running");
      expect(status.startedAt).toEqual(new Date("2025-01-01T00:00:00Z"));
    });
  });

  describe("health", () => {
    it("should return true when Docker responds", async () => {
      const ok = await driver.health();
      expect(ok).toBe(true);
    });

    it("should return false when Docker fails", async () => {
      mockDocker.ping.mockRejectedValueOnce(new Error("timeout"));
      const ok = await driver.health();
      expect(ok).toBe(false);
    });
  });
});
