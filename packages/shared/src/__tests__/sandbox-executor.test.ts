import { spawn } from "child_process";
import {
  executeSandboxTool,
  isAllowedTool,
} from "../sandbox/executor.js";
import { EventEmitter } from "stream";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

const mockSpawn = spawn as unknown as jest.Mock;

interface MockProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: jest.Mock; end: jest.Mock };
  emitClose: (code: number) => void;
  emitError: () => void;
}

function makeProc(): MockProc {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn() });
  proc.emitClose = (code: number) => proc.emit("close", code);
  proc.emitError = () => proc.emit("error");
  return proc;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe("isAllowedTool", () => {
  it("returns true for known tools", () => {
    expect(isAllowedTool("file_read")).toBe(true);
    expect(isAllowedTool("file_write")).toBe(true);
    expect(isAllowedTool("database_query")).toBe(true);
    expect(isAllowedTool("code_interpreter")).toBe(true);
  });

  it("returns false for unknown tools", () => {
    expect(isAllowedTool("rm_rf")).toBe(false);
    expect(isAllowedTool("")).toBe(false);
  });
});

describe("executeSandboxTool", () => {
  it("rejects unknown tools", async () => {
    const result = await executeSandboxTool({ tool: "rm_rf", args: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown tool");
  });

  it("refuses to execute code_interpreter on the host", async () => {
    const result = await executeSandboxTool({ tool: "code_interpreter", args: { code: "console.log(1)" } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not allowed on the host");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns a validation error for bad code_interpreter args", async () => {
    const result = await executeSandboxTool({ tool: "code_interpreter", args: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Validation error");
  });

  it("reads files via cat", async () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);
    const promise = executeSandboxTool({ tool: "file_read", args: { path: "/tmp/notes.txt" } });
    proc.stdout.emit("data", Buffer.from("hello world"));
    proc.emitClose(0);
    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledWith("cat", ["/tmp/notes.txt"], expect.any(Object));
    expect(result.stdout).toBe("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("rejects path traversal", async () => {
    const result = await executeSandboxTool({ tool: "file_read", args: { path: "/etc/../passwd" } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Validation error");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("writes files via tee", async () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);
    const promise = executeSandboxTool({ tool: "file_write", args: { path: "/tmp/out.txt", content: "data" } });
    proc.emitClose(0);
    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledWith("tee", ["/tmp/out.txt"], expect.any(Object));
    expect(proc.stdin.write).toHaveBeenCalledWith("data");
    expect(proc.stdin.end).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it("runs database queries via sqlite3", async () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);
    const promise = executeSandboxTool({ tool: "database_query", args: { query: "SELECT 1" } });
    proc.stdout.emit("data", Buffer.from("1"));
    proc.emitClose(0);
    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledWith("sqlite3", ["/tmp/data.db", "SELECT 1"], expect.any(Object));
    expect(result.stdout).toBe("1");
    expect(result.exitCode).toBe(0);
  });

  it("maps a nonzero exit code", async () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);
    const promise = executeSandboxTool({ tool: "file_read", args: { path: "/tmp/missing" } });
    proc.emitClose(2);
    const result = await promise;
    expect(result.exitCode).toBe(2);
  });

  it("returns exit code 1 on spawn error", async () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);
    const promise = executeSandboxTool({ tool: "file_read", args: { path: "/tmp/x" } });
    proc.emitError();
    const result = await promise;
    expect(result.exitCode).toBe(1);
  });

  it("truncates oversized output", async () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);
    const promise = executeSandboxTool({ tool: "file_read", args: { path: "/tmp/big" } });
    proc.stdout.emit("data", Buffer.from("x".repeat(110_000)));
    proc.emitClose(0);
    const result = await promise;
    expect(result.stdout.length).toBe(100_000);
  });

  it("returns an execution error for unexpected failures", async () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);
    const promise = executeSandboxTool({ tool: "file_read", args: { path: "/tmp/x" } });
    proc.stdout.emit("data", Buffer.from("partial"));
    proc.emitClose(0);
    const result = await promise;
    expect(result.stdout).toBe("partial");
    expect(result.exitCode).toBe(0);
  });
});
