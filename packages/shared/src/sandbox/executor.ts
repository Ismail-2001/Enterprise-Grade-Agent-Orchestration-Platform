import { spawn, SpawnOptions } from "child_process";
import { z } from "zod";

export interface SandboxRequest {
  tool: string;
  args: Record<string, unknown>;
  requestId?: string;
}

export interface SandboxResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const CODE_SCHEMA = z.object({
  code: z.string().min(1).max(10000),
}).strict();

const PATH_SCHEMA = z.object({
  path: z.string().min(1).max(4096).regex(/^[a-zA-Z0-9_\/\.\-]+$/).refine((p) => !p.includes(".."), "Path traversal blocked"),
}).strict();

const FILE_WRITE_SCHEMA = z.object({
  path: z.string().min(1).max(4096).regex(/^[a-zA-Z0-9_\/\.\-]+$/).refine((p) => !p.includes(".."), "Path traversal blocked"),
  content: z.string().max(1_000_000),
}).strict();

const QUERY_SCHEMA = z.object({
  query: z.string().min(1).max(10000),
}).strict();

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function runTool(args: string[], opts?: Partial<SpawnOptions>): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(args[0] ?? "", args.slice(1), {
      shell: false,
      timeout: 30000,
      killSignal: "SIGKILL",
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
    proc.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
  });
}

const TOOL_EXECUTORS: Record<string, (args: Record<string, unknown>) => Promise<ExecResult>> = {
  code_interpreter: async (args) => {
    const { code } = CODE_SCHEMA.parse(args);
    return runTool(["python3", "-c", code]);
  },
  file_read: async (args) => {
    const { path } = PATH_SCHEMA.parse(args);
    return runTool(["cat", path]);
  },
  file_write: async (args) => {
    const { path, content } = FILE_WRITE_SCHEMA.parse(args);
    const proc = spawn("tee", [path], { shell: false, timeout: 10000, killSignal: "SIGKILL" });
    proc.stdin?.write(content);
    proc.stdin?.end();
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    return new Promise((resolve) => {
      proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
      proc.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
    });
  },
  database_query: async (args) => {
    const { query } = QUERY_SCHEMA.parse(args);
    return runTool(["sqlite3", "/tmp/data.db", query]);
  },
};

const ALLOWED_TOOLS = new Set(Object.keys(TOOL_EXECUTORS));

export function isAllowedTool(tool: string): boolean {
  return ALLOWED_TOOLS.has(tool);
}

export async function executeSandboxTool(req: SandboxRequest): Promise<SandboxResponse> {
  if (!ALLOWED_TOOLS.has(req.tool)) {
    return { stdout: "", stderr: `Unknown tool: ${req.tool}`, exitCode: 1 };
  }
  try {
    const validator = TOOL_EXECUTORS[req.tool]!;
    const result = await validator(req.args);
    return { stdout: result.stdout.slice(0, 100_000), stderr: result.stderr.slice(0, 10_000), exitCode: result.exitCode };
  } catch (err: unknown) {
    const msg = err instanceof z.ZodError ? `Validation error: ${err.errors[0]?.message ?? "invalid input"}` : `Execution error: ${req.tool}`;
    return { stdout: "", stderr: msg, exitCode: 1 };
  }
}
