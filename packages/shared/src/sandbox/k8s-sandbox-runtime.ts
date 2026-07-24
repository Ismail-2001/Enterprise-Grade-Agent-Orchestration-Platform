import * as k8s from "@kubernetes/client-node";

export interface SandboxSpec {
  executionId: string;
  agentId: string;
  namespace: string;
  image: string;
  isolationLevel?: string;
  cpu?: string;
  memory?: string;
  envVars?: Record<string, string>;
  initCommands?: string[];
}

export interface Sandbox {
  podName: string;
  status: string;
  ip: string;
  initOutputs: string[];
}

const BLOCKED_CMD_RE = /[;&|`$(){}!<>]/;

function isCommandSafe(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0 || cmd.length > 4096) return false;
  return !BLOCKED_CMD_RE.test(cmd);
}

export class K8sSandboxRuntime {
  private k8sApi: k8s.CoreV1Api;
  private namespace: string;
  private kc: k8s.KubeConfig;

  constructor(kubeConfig?: k8s.KubeConfig) {
    this.kc = kubeConfig ?? new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.namespace = process.env.K8S_NAMESPACE || "egaop";
  }

  async createSandbox(spec: SandboxSpec): Promise<Sandbox> {
    const initOutputs: string[] = [];

    const securityContext: k8s.V1PodSecurityContext = {
      runAsNonRoot: true,
      runAsUser: 65534,
      seccompProfile: { type: "RuntimeDefault" },
    };

    const containerSecurityContext: k8s.V1SecurityContext = {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      runAsNonRoot: true,
      runAsUser: 65534,
    };

    const env: k8s.V1EnvVar[] = Object.entries(spec.envVars ?? {}).map(([k, v]) => ({ name: k, value: v }));

    const resourceLimits: Record<string, string> = {};
    if (spec.cpu) resourceLimits.cpu = spec.cpu;
    if (spec.memory) resourceLimits.memory = spec.memory;
    resourceLimits["ephemeral-storage"] = "1Gi";

    const resourceRequests: Record<string, string> = {};
    if (spec.cpu) resourceRequests.cpu = spec.cpu;
    if (spec.memory) resourceRequests.memory = spec.memory;

    const pod: k8s.V1Pod = {
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
        securityContext,
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        containers: [{
          name: "runtime",
          image: spec.image || "egaop-base-runtime:latest",
          imagePullPolicy: "IfNotPresent",
          env,
          resources: {
            limits: resourceLimits,
            requests: resourceRequests,
          },
          securityContext: containerSecurityContext,
        }],
      },
    };

    const result = await this.k8sApi.createNamespacedPod({ namespace: this.namespace, body: pod });
    const podName = result.metadata?.name ?? "";

    let ip = "unknown";
    let attempts = 0;
    while (attempts < 30) {
      const read = await this.k8sApi.readNamespacedPod({ namespace: this.namespace, name: podName });
      const phase = read.status?.phase;
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
        initOutputs.push(`BLOCKED: command rejected by security policy`);
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
    try {
      await this.k8sApi.deleteNamespacedPod({
        namespace: this.namespace,
        name: podName,
        gracePeriodSeconds: 5,
      });
    } catch {
      // Pod may already be gone
    }
  }

  private async execInPod(podName: string, command: string[]): Promise<string> {
    const exec = new k8s.Exec(this.kc);
    return new Promise((resolve, reject) => {
      let output = "";
      exec.exec(
        this.namespace,
        podName,
        "runtime",
        command,
        process.stdout as any,
        process.stderr as any,
        process.stdin as any,
        false,
        ((status: k8s.V1Status | null) => {
          if (status?.status === "Success") resolve(output);
          else reject(new Error(`exec returned ${status?.status ?? "Failure"}`));
        }) as any,
      );
    });
  }
}
