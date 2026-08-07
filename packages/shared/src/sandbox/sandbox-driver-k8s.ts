import type { SandboxDriver, SandboxResult, SandboxSpec } from "./sandbox-driver.js";
import type { K8sSandboxRuntime } from "./k8s-sandbox-runtime.js";

export class K8sSandboxDriver implements SandboxDriver {
  private runtime: K8sSandboxRuntime | null = null;
  private initialized = false;

  async ensure(): Promise<void> {
    if (this.initialized) return;
    const { K8sSandboxRuntime } = await import("./k8s-sandbox-runtime.js");
    this.runtime = new K8sSandboxRuntime();
    this.initialized = true;
  }

  async createSandbox(spec: SandboxSpec): Promise<SandboxResult> {
    await this.ensure();
    const sandbox = await this.runtime!.createSandbox(spec);
    return {
      sandboxId: sandbox.podName,
      status: sandbox.status,
      ipAddress: sandbox.ip,
      initOutputs: sandbox.initOutputs,
    };
  }

  async terminateSandbox(sandboxId: string): Promise<boolean> {
    await this.ensure();
    try {
      await this.runtime!.terminateSandbox(sandboxId);
      return true;
    } catch {
      return false;
    }
  }

  async getSandboxStatus(sandboxId: string): Promise<{ status: string; cpu: number; memory: number; startedAt: Date | null }> {
    await this.ensure();
    try {
      const read = await this.runtime!.getApi().readNamespacedPod({
        namespace: process.env.K8S_NAMESPACE || "egaop",
        name: sandboxId,
      });
      const phase: string = read.status?.phase ?? "Unknown";
      return { status: phase, cpu: 0, memory: 0, startedAt: null };
    } catch {
      return { status: "NotFound", cpu: 0, memory: 0, startedAt: null };
    }
  }

  async health(): Promise<boolean> {
    await this.ensure();
    try {
      await this.runtime!.getApi().listNamespacedPod({ namespace: process.env.K8S_NAMESPACE || "egaop", limit: 1 });
      return true;
    } catch {
      return false;
    }
  }
}
