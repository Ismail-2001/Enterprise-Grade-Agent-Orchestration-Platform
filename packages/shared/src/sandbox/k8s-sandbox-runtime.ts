import { Writable } from "stream";
import type { SandboxSpec } from "./sandbox-driver.js";

export interface Sandbox {
  podName: string;
  status: string;
  ip: string;
  initOutputs: string[];
}

const BLOCKED_CMD_RE = /[;&|`$(){}!<>\\n\\r]/;

function isCommandSafe(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0 || cmd.length > 4096) return false;
  return !BLOCKED_CMD_RE.test(cmd);
}

type K8sModule = typeof import("@kubernetes/client-node");

let _k8sCache: K8sModule | null = null;
async function getK8s(): Promise<K8sModule> {
  if (!_k8sCache) {
    _k8sCache = await import("@kubernetes/client-node");
  }
  return _k8sCache;
}

interface K8sPodMetadata {
  name?: string;
}

interface K8sPodStatus {
  phase?: string;
  podIP?: string;
}

interface K8sPodResult {
  metadata?: K8sPodMetadata;
  status?: K8sPodStatus;
}

interface K8sExecStatus {
  status?: string;
}

interface K8sApi {
  createNamespacedPod(params: { namespace: string; body: unknown }): Promise<K8sPodResult>;
  readNamespacedPod(params: { namespace: string; name: string }): Promise<K8sPodResult>;
  deleteNamespacedPod(params: { namespace: string; name: string; gracePeriodSeconds: number }): Promise<void>;
  listNamespacedPod(params: { namespace: string; limit: number }): Promise<{ items: unknown[] }>;
}

interface K8sKubeConfig {
  loadFromDefault(): void;
  makeApiClient(ApiClient: unknown): K8sApi;
}

export class K8sSandboxRuntime {
  private k8sApi: K8sApi | null = null;
  private namespace: string;
  private kc: K8sKubeConfig | null;

  constructor(kubeConfig?: K8sKubeConfig) {
    this.namespace = process.env.K8S_NAMESPACE || "egaop";
    this.kc = kubeConfig ?? null;
  }

  private async ensureInit(): Promise<void> {
    if (this.k8sApi) return;
    const k8s = await getK8s();
    if (!this.kc) {
      this.kc = new k8s.KubeConfig() as unknown as K8sKubeConfig;
      this.kc.loadFromDefault();
    }
    this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api as unknown);
  }

  async createSandbox(spec: SandboxSpec): Promise<Sandbox> {
    await this.ensureInit();
    const initOutputs: string[] = [];

    const pod = {
      metadata: {
        name: `egaop-agent-${spec.executionId}`,
        namespace: this.namespace,
        labels: {
          "egaop.agent.id": spec.agentId,
          "egaop.execution.id": spec.executionId,
          "egaop.plane": "execution",
          "app.kubernetes.io/name": "sandbox-agent",
        },
        annotations: {
          "seccomp.security.alpha.kubernetes.io/pod": "runtime/default",
        },
      },
      spec: {
        runtimeClassName: spec.isolationLevel === "enhanced" || spec.isolationLevel === "Maximum" ? "gvisor" : undefined,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 65534,
          seccompProfile: { type: "RuntimeDefault" },
        },
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        containers: [{
          name: "runtime",
          image: spec.image || "egaop-base-runtime:latest",
          imagePullPolicy: "IfNotPresent",
          env: Object.entries(spec.envVars ?? {}).map(([k, v]) => ({ name: k, value: v })),
          resources: {
            limits: Object.assign(
              {},
              spec.cpu ? { cpu: spec.cpu } : {},
              spec.memory ? { memory: spec.memory } : {},
              { "ephemeral-storage": "1Gi" },
            ),
            requests: Object.assign(
              {},
              spec.cpu ? { cpu: spec.cpu } : {},
              spec.memory ? { memory: spec.memory } : {},
            ),
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
            runAsNonRoot: true,
            runAsUser: 65534,
          },
        }],
      },
    };

    const result = await this.k8sApi!.createNamespacedPod({ namespace: this.namespace, body: pod });
    const podName: string = result.metadata?.name ?? "";

    let ip = "unknown";
    let attempts = 0;
    while (attempts < 30) {
      const read = await this.k8sApi!.readNamespacedPod({ namespace: this.namespace, name: podName });
      const phase: string | undefined = read.status?.phase;
      ip = read.status?.podIP ?? ip;
      if (phase === "Running" || phase === "Succeeded") break;
      if (phase === "Failed" || phase === "Unknown") {
        throw new Error(`Sandbox pod entered phase: ${phase}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
      attempts++;
    }

    const initCmds = spec.initCommands ?? [];
    for (const cmd of initCmds) {
      if (!isCommandSafe(cmd)) {
        initOutputs.push("BLOCKED: command rejected by security policy");
        continue;
      }
      try {
        const execResult = await this.execInPod(podName, ["sh", "-c", cmd]);
        initOutputs.push(execResult);
      } catch (e: unknown) {
        initOutputs.push(`ERROR: ${e instanceof Error ? e.message : "exec failed"}`);
      }
    }

    return { podName, status: "Running", ip, initOutputs };
  }

  async terminateSandbox(podName: string): Promise<void> {
    await this.ensureInit();
    try {
      await this.k8sApi!.deleteNamespacedPod({
        namespace: this.namespace,
        name: podName,
        gracePeriodSeconds: 5,
      });
    } catch {
      // Pod may already be gone
    }
  }

  private async execInPod(podName: string, command: string[]): Promise<string> {
    const k8s = await getK8s();
    const exec = new k8s.Exec(this.kc as unknown as k8s.KubeConfig);
    return new Promise((resolve, reject) => {
      let output = "";
      const stdout = new Writable({
        write(chunk: Buffer, _encoding: BufferEncoding, cb: () => void) {
          output += chunk.toString();
          cb();
        },
      });
      exec.exec(
        this.namespace,
        podName,
        "runtime",
        command,
        stdout,
        stdout,
        null,
        false,
        (status: K8sExecStatus | null) => {
          if (status?.status === "Success") resolve(output);
          else reject(new Error(`exec returned ${status?.status ?? "Failure"}`));
        },
      );
    });
  }
}
