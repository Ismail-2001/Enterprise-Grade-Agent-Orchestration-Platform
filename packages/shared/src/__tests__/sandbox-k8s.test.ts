import { K8sSandboxRuntime } from "../sandbox/k8s-sandbox-runtime.js";
import { K8sSandboxDriver } from "../sandbox/sandbox-driver-k8s.js";
import type { K8sApi, K8sKubeConfig } from "../sandbox/k8s-sandbox-runtime.js";
import type { SandboxSpec } from "../sandbox/sandbox-driver.js";

jest.mock("@kubernetes/client-node", () => {
  const CoreV1Api = class {};
  return {
    CoreV1Api,
    KubeConfig: class {
      kc: any;
      constructor() {
        this.kc = null;
      }
      loadFromDefault() {}
      makeApiClient() {
        return this.kc;
      }
    },
    Exec: class {
      constructor(_kc: any) {}
      exec(
        _ns: string,
        _pod: string,
        _container: string,
        _command: string[],
        stdout: any,
        _stderr: any,
        _stdin: any,
        _tty: boolean,
        cb: (status: { status: string } | null) => void,
      ) {
        cb({ status: "Success" });
      }
    },
  };
});

const spec: SandboxSpec = {
  executionId: "exec-1",
  agentId: "agent-1",
  namespace: "default",
  image: "my-image:1.0",
};

const createFakeApi = (overrides: Partial<K8sApi> = {}): K8sApi => {
  const base: K8sApi = {
    createNamespacedPod: jest.fn().mockResolvedValue({
      metadata: { name: "egaop-agent-exec-1" },
      status: { phase: "Running", podIP: "10.0.0.5" },
    }),
    readNamespacedPod: jest.fn().mockResolvedValue({
      status: { phase: "Running", podIP: "10.0.0.5" },
    }),
    deleteNamespacedPod: jest.fn().mockResolvedValue(undefined),
    listNamespacedPod: jest.fn().mockResolvedValue({ items: [] }),
  };
  return { ...base, ...overrides };
};

const makeRuntime = (api: K8sApi): K8sSandboxRuntime => {
  const kc = {
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn().mockReturnValue(api),
  } as unknown as K8sKubeConfig;
  return new K8sSandboxRuntime(kc);
};

beforeEach(() => {
  delete process.env.K8S_NAMESPACE;
});

describe("K8sSandboxRuntime", () => {
  it("throws when getApi is called before initialization", () => {
    const runtime = new K8sSandboxRuntime();
    expect(() => runtime.getApi()).toThrow(/not initialized/);
  });

  it("creates a sandbox pod and returns its details", async () => {
    const api = createFakeApi();
    const runtime = makeRuntime(api);
    const result = await runtime.createSandbox(spec);

    expect(api.createNamespacedPod).toHaveBeenCalled();
    const createCall = (api.createNamespacedPod as jest.Mock).mock.calls[0][0];
    expect(createCall.namespace).toBe("egaop");
    expect(createCall.body.metadata.name).toBe("egaop-agent-exec-1");
    expect(createCall.body.metadata.labels["egaop.agent.id"]).toBe("agent-1");
    expect(createCall.body.spec.containers[0].image).toBe("my-image:1.0");
    expect(createCall.body.spec.restartPolicy).toBe("Never");
    expect(createCall.body.spec.securityContext.runAsNonRoot).toBe(true);

    expect(result.podName).toBe("egaop-agent-exec-1");
    expect(result.status).toBe("Running");
    expect(result.ip).toBe("10.0.0.5");
    expect(result.initOutputs).toEqual([]);
  });

  it("uses the K8S_NAMESPACE env var when set", async () => {
    process.env.K8S_NAMESPACE = "team-a";
    const api = createFakeApi();
    const runtime = makeRuntime(api);
    await runtime.createSandbox(spec);
    const createCall = (api.createNamespacedPod as jest.Mock).mock.calls[0][0];
    expect(createCall.namespace).toBe("team-a");
  });

  it("uses enhanced isolation -> gvisor runtimeClassName", async () => {
    const api = createFakeApi();
    const runtime = makeRuntime(api);
    await runtime.createSandbox({ ...spec, isolationLevel: "enhanced" });
    const createCall = (api.createNamespacedPod as jest.Mock).mock.calls[0][0];
    expect(createCall.body.spec.runtimeClassName).toBe("gvisor");
  });

  it("omits runtimeClassName for standard isolation", async () => {
    const api = createFakeApi();
    const runtime = makeRuntime(api);
    await runtime.createSandbox({ ...spec, isolationLevel: "standard" });
    const createCall = (api.createNamespacedPod as jest.Mock).mock.calls[0][0];
    expect(createCall.body.spec.runtimeClassName).toBeUndefined();
  });

  it("sets cpu/memory limits when provided", async () => {
    const api = createFakeApi();
    const runtime = makeRuntime(api);
    await runtime.createSandbox({ ...spec, cpu: "1", memory: "512Mi" });
    const createCall = (api.createNamespacedPod as jest.Mock).mock.calls[0][0];
    expect(createCall.body.spec.containers[0].resources.limits.cpu).toBe("1");
    expect(createCall.body.spec.containers[0].resources.limits.memory).toBe("512Mi");
    expect(createCall.body.spec.containers[0].resources.limits["ephemeral-storage"]).toBe("1Gi");
  });

  it("passes env vars to the pod", async () => {
    const api = createFakeApi();
    const runtime = makeRuntime(api);
    await runtime.createSandbox({ ...spec, envVars: { FOO: "bar", BAZ: "qux" } });
    const createCall = (api.createNamespacedPod as jest.Mock).mock.calls[0][0];
    expect(createCall.body.spec.containers[0].env).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
  });

  it("throws when the pod enters a Failed phase", async () => {
    const api = createFakeApi({
      createNamespacedPod: jest.fn().mockResolvedValue({
        metadata: { name: "egaop-agent-exec-1" },
      }),
      readNamespacedPod: jest.fn().mockResolvedValue({ status: { phase: "Failed" } }),
    });
    const runtime = makeRuntime(api);
    await expect(runtime.createSandbox(spec)).rejects.toThrow(/Failed/);
  });

  it("runs init commands and blocks unsafe ones", async () => {
    const api = createFakeApi();
    const runtime = makeRuntime(api);
    const result = await runtime.createSandbox({
      ...spec,
      initCommands: ["whoami", "rm -rf /; echo pwned"],
    });
    expect(result.initOutputs[0]).toBe("");
    expect(result.initOutputs[1]).toContain("BLOCKED");
  });

  it("captures exec results in initOutputs", async () => {
    const api = createFakeApi();
    const runtime = makeRuntime(api);
    const result = await runtime.createSandbox({
      ...spec,
      initCommands: ["safe"],
    });
    expect(result.initOutputs[0]).toBe("");
    expect(result.initOutputs).toHaveLength(1);
  });

  it("terminates a sandbox", async () => {
    const api = createFakeApi();
    const runtime = makeRuntime(api);
    await runtime.terminateSandbox("egaop-agent-exec-1");
    expect(api.deleteNamespacedPod).toHaveBeenCalledWith({
      namespace: "egaop",
      name: "egaop-agent-exec-1",
      gracePeriodSeconds: 5,
    });
  });

  it("tolerates delete failures", async () => {
    const api = createFakeApi({
      deleteNamespacedPod: jest.fn().mockRejectedValue(new Error("gone")),
    });
    const runtime = makeRuntime(api);
    await expect(runtime.terminateSandbox("x")).resolves.toBeUndefined();
  });

  it("uses default namespace when env is unset", async () => {
    const api = createFakeApi();
    const runtime = makeRuntime(api);
    await runtime.terminateSandbox("x");
    expect(api.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "egaop" }),
    );
  });
});

describe("K8sSandboxDriver", () => {
  it("creates a sandbox through the runtime", async () => {
    const api = createFakeApi();
    const driver = new K8sSandboxDriver();
    (driver as any).runtime = makeRuntime(api);
    (driver as any).initialized = true;

    const result = await driver.createSandbox(spec);
    expect(result.sandboxId).toBe("egaop-agent-exec-1");
    expect(result.ipAddress).toBe("10.0.0.5");
    expect(result.initOutputs).toEqual([]);
  });

  it("terminateSandbox returns true on success", async () => {
    const api = createFakeApi();
    const driver = new K8sSandboxDriver();
    (driver as any).runtime = makeRuntime(api);
    (driver as any).initialized = true;
    await expect(driver.terminateSandbox("egaop-agent-exec-1")).resolves.toBe(true);
  });

  it("terminateSandbox returns true even when the pod is already gone", async () => {
    const api = createFakeApi({
      deleteNamespacedPod: jest.fn().mockRejectedValue(new Error("gone")),
    });
    const driver = new K8sSandboxDriver();
    const runtime = makeRuntime(api);
    await (runtime as any).ensureInit();
    (driver as any).runtime = runtime;
    (driver as any).initialized = true;
    await expect(driver.terminateSandbox("x")).resolves.toBe(true);
  });

  it("getSandboxStatus reports the pod phase", async () => {
    const api = createFakeApi({
      readNamespacedPod: jest.fn().mockResolvedValue({ status: { phase: "Running" } }),
    });
    const driver = new K8sSandboxDriver();
    const runtime = makeRuntime(api);
    await (runtime as any).ensureInit();
    (driver as any).runtime = runtime;
    (driver as any).initialized = true;
    const status = await driver.getSandboxStatus("egaop-agent-exec-1");
    expect(status.status).toBe("Running");
  });

  it("getSandboxStatus reports NotFound on error", async () => {
    const api = createFakeApi({
      readNamespacedPod: jest.fn().mockRejectedValue(new Error("no pod")),
    });
    const driver = new K8sSandboxDriver();
    const runtime = makeRuntime(api);
    await (runtime as any).ensureInit();
    (driver as any).runtime = runtime;
    (driver as any).initialized = true;
    const status = await driver.getSandboxStatus("x");
    expect(status.status).toBe("NotFound");
  });

  it("health returns true when pods list succeeds", async () => {
    const api = createFakeApi();
    const driver = new K8sSandboxDriver();
    const runtime = makeRuntime(api);
    await (runtime as any).ensureInit();
    (driver as any).runtime = runtime;
    (driver as any).initialized = true;
    await expect(driver.health()).resolves.toBe(true);
  });

  it("health returns false when pods list fails", async () => {
    const api = createFakeApi({
      listNamespacedPod: jest.fn().mockRejectedValue(new Error("down")),
    });
    const driver = new K8sSandboxDriver();
    const runtime = makeRuntime(api);
    await (runtime as any).ensureInit();
    (driver as any).runtime = runtime;
    (driver as any).initialized = true;
    await expect(driver.health()).resolves.toBe(false);
  });
});
