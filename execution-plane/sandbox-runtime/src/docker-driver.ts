import Docker from "dockerode";
import type { SandboxDriver, SandboxSpec, SandboxResult } from "@e-gaop/shared";

const BLOCKED_CMD_RE = /[;&|`$(){}!<>]/;
const DANGEROUS_CMD_RE = /\b(rm\s+-rf|mkfs|dd\s+if=|:()\s*\{\s*:\|:&\s*\};)\b/;
const ALLOWED_IMAGES = /^(egaop-[\w-]+|ghcr\.io\/ismael-2001\/the-kubernetes-of-ai-agents\/[\w-]+):[\w.-]+$/;

function isInitCommandSafe(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  if (cmd.length > 4096) return false;
  if (BLOCKED_CMD_RE.test(cmd)) return false;
  if (DANGEROUS_CMD_RE.test(cmd)) return false;
  return true;
}

export class DockerSandboxDriver implements SandboxDriver {
  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  async createSandbox(spec: SandboxSpec): Promise<SandboxResult> {
    const NanoCpus = spec.cpu ? Math.round(parseFloat(spec.cpu) * 1_000_000_000) : 500_000_000;
    const memoryBytes = spec.memory ? parseInt(spec.memory) * 1024 * 1024 : 512 * 1024 * 1024;

    const HostConfig: any = {
      Memory: memoryBytes,
      NanoCpus,
      NetworkMode: "egaop-sandbox",
      SecurityOpt: ["no-new-privileges"],
    };

    if (spec.isolationLevel === "Enhanced") {
      HostConfig.Runtime = "runsc";
    } else if (spec.isolationLevel === "Maximum") {
      HostConfig.Runtime = "firecracker";
    }

    const containerImage = spec.image || "egaop-base-runtime:latest";
    if (!ALLOWED_IMAGES.test(containerImage)) {
      throw Object.assign(new Error(`Image not in allowlist: ${containerImage}`), { code: "INVALID_ARGUMENT" });
    }

    const container = await this.docker.createContainer({
      Image: containerImage,
      name: `egaop-agent-${spec.executionId}`,
      Cmd: ["node", "/workspace/server.js"],
      Env: Object.entries(spec.envVars ?? {}).map(([k, v]) => `${k}=${v}`),
      HostConfig,
      Labels: {
        "egaop.agent.id": spec.agentId,
        "egaop.execution.id": spec.executionId,
        "egaop.plane": "execution",
      },
    });

    await container.start();

    let ipAddress = "unknown";
    try {
      const info = await container.inspect();
      const networks = info.NetworkSettings?.Networks || {};
      const sandboxNet = networks["egaop-sandbox"];
      if (sandboxNet?.IPAddress) ipAddress = sandboxNet.IPAddress;
    } catch {
      // non-fatal
    }

    const initOutputs: string[] = [];
    const initCmds = spec.initCommands ?? [];
    for (const cmd of initCmds) {
      if (!isInitCommandSafe(cmd)) {
        initOutputs.push("BLOCKED: command rejected by security policy");
        continue;
      }
      try {
        const execInstance = await container.exec({
          Cmd: ["sh", "-c", cmd],
          AttachStdout: true,
          AttachStderr: true,
        });
        const stream = await execInstance.start({ Detach: false, Tty: false });
        const output = await new Promise<string>((resolve) => {
          let data = "";
          stream.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          stream.on("end", () => resolve(data));
        });
        initOutputs.push(output);
      } catch (e: any) {
        initOutputs.push(`ERROR: ${e.message}`);
      }
    }

    return { sandboxId: container.id, status: "Running", ipAddress, initOutputs };
  }

  async terminateSandbox(sandboxId: string): Promise<boolean> {
    try {
      const container = this.docker.getContainer(sandboxId);
      await container.remove({ force: true });
      return true;
    } catch {
      return false;
    }
  }

  async getSandboxStatus(sandboxId: string): Promise<{ status: string; cpu: number; memory: number; startedAt: Date | null }> {
    try {
      const container = this.docker.getContainer(sandboxId);
      const info = await container.inspect();
      const state = info.State;
      return {
        status: state.Status || "unknown",
        cpu: 0,
        memory: 0,
        startedAt: state.StartedAt ? new Date(state.StartedAt) : null,
      };
    } catch (e: any) {
      if (e?.statusCode === 404) return { status: "NotFound", cpu: 0, memory: 0, startedAt: null };
      return { status: "Unknown", cpu: 0, memory: 0, startedAt: null };
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }
}
