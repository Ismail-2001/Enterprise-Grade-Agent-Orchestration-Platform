import * as grpc from "@grpc/grpc-js";

const mockCreate = jest.fn();
jest.mock("openai", () => {
  return {
    __esModule: true,
    default: class {
      chat = { completions: { create: mockCreate } };
    },
  };
});

const mockSemaphoreAcquire = jest.fn(() => Promise.resolve(false));

jest.mock("@e-gaop/shared", () => {
  const actual = jest.requireActual("@e-gaop/shared");
  return {
    ...actual,
    AsyncSemaphore: class {
      acquire(): Promise<boolean> {
        return mockSemaphoreAcquire();
      }
      release(): void {}
    },
  };
});

let handlers: Map<string, { func: any }>;
let rateLimiter: any;

beforeAll(() => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.ANTHROPIC_API_KEY = "anthropic-key";
  jest.resetModules();
  const api = require("../index");
  handlers = (api.server as any).handlers as Map<string, { func: any }>;
  rateLimiter = api.rateLimiter;
});

afterEach(() => {
  jest.clearAllMocks();
  rateLimiter.dispose();
});

const GEN_PATH = "/egaop.v1.LLMService/Generate";
const STREAM_PATH = "/egaop.v1.LLMService/GenerateStream";

describe("LLM Router concurrency exhaustion", () => {
  it("returns DEADLINE_EXCEEDED on Generate when no concurrency slot is free", async () => {
    const handler = handlers.get(GEN_PATH)!;
    const result = await new Promise((resolve) => {
      handler.func(
        {
          request: {
            agent_id: "default/agent-1",
            execution_id: "exec-1",
            model: "gpt-4o",
            messages: [{ role: "user", content: "Hello" }],
          },
        },
        (err: any) => resolve(err)
      );
    });

    expect((result as any).code).toBe(grpc.status.DEADLINE_EXCEEDED);
    expect((result as any).message).toMatch(/Too many concurrent/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("emits DEADLINE_EXCEEDED on GenerateStream when no concurrency slot is free", async () => {
    const handler = handlers.get(STREAM_PATH)!;
    const call = {
      request: {
        agent_id: "default/agent-1",
        execution_id: "exec-1",
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
      write: jest.fn(),
      end: jest.fn(),
      emit: jest.fn(),
    };
    await handler.func(call);

    expect(call.emit).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ code: grpc.status.DEADLINE_EXCEEDED })
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("emits INTERNAL on GenerateStream when the concurrency semaphore throws", async () => {
    mockSemaphoreAcquire.mockImplementationOnce(() => {
      throw new Error("semaphore broken");
    });

    jest.resetModules();
    process.env.OPENAI_API_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY = "anthropic-key";
    const api = require("../index");
    const freshHandlers = (api.server as any).handlers as Map<string, { func: any }>;
    const freshRateLimiter = api.rateLimiter;

    const call = {
      request: {
        agent_id: "default/agent-1",
        execution_id: "exec-1",
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
      write: jest.fn(),
      end: jest.fn(),
      emit: jest.fn(),
    };
    await freshHandlers.get(STREAM_PATH)!.func(call);

    expect(call.emit).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ code: grpc.status.INTERNAL })
    );
    freshRateLimiter.dispose();
  });
});
