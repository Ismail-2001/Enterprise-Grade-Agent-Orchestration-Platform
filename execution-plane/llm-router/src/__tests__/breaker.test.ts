const mockCreate = jest.fn();
jest.mock("openai", () => {
  return {
    __esModule: true,
    default: class {
      chat = { completions: { create: mockCreate } };
    },
  };
});

let handlers: Map<string, { func: any; type: string; path: string }>;

beforeAll(() => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.LLM_CIRCUIT_BREAKER_VOLUME = "1";
  process.env.LLM_CIRCUIT_BREAKER_THRESHOLD = "1";
  process.env.LLM_CIRCUIT_BREAKER_RESET_MS = "50";
  jest.resetModules();
  const api = require("../index");
  handlers = (api.server as any).handlers as Map<string, { func: any; type: string; path: string }>;
});

afterEach(() => {
  jest.clearAllMocks();
});

const GEN_PATH = "/egaop.v1.LLMService/Generate";

function runGenerate(req: Record<string, unknown>): Promise<any> {
  const handler = handlers.get(GEN_PATH)!;
  return new Promise((resolve) => {
    handler.func({ request: req }, (err: any, result?: any) => resolve({ err, result }));
  });
}

function request(agentId: string): Record<string, unknown> {
  return {
    agent_id: agentId,
    execution_id: "exec-1",
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello there" }],
  };
}

describe("LLM Router circuit breaker", () => {
  it("opens the breaker after repeated failures and fast-fails subsequent models", async () => {
    mockCreate.mockRejectedValue(new Error("upstream down"));

    const { err } = await runGenerate(request("default/agent-cb-1"));
    expect(err.code).toBe(13);
  });

  it("recovers after the reset window and succeeds", async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));

    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "recovered", tool_calls: undefined } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const { err, result } = await runGenerate(request("default/agent-cb-2"));
    expect(err).toBeNull();
    expect(result.content).toBe("recovered");
  });
});
