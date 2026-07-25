export interface SandboxResult {
  sandboxId: string;
  status: string;
  ipAddress: string;
  initOutputs: string[];
}

export interface SandboxDriver {
  createSandbox(spec: SandboxSpec): Promise<SandboxResult>;
  terminateSandbox(sandboxId: string): Promise<boolean>;
  getSandboxStatus(sandboxId: string): Promise<{ status: string; cpu: number; memory: number; startedAt: Date | null }>;
  health(): Promise<boolean>;
}

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
