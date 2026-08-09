import { streamAnthropic, streamOllama, streamLLMWithFallback } from "../index";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function sseResponse(lines: string[]): Response {
  const body = lines.join("\n") + "\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("streamAnthropic", () => {
  it("yields text deltas and a final usage chunk", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      ])
    ) as unknown as typeof fetch;

    const chunks: string[] = [];
    let finalUsage: any;
    for await (const chunk of streamAnthropic(
      [{ role: "user", content: "Hi" }],
      "claude-3-5-sonnet-20241022",
      0.7,
      undefined
    )) {
      if (chunk.content) chunks.push(chunk.content);
      if (chunk.usage) finalUsage = chunk.usage;
    }

    expect(chunks.join("")).toBe("Hello world");
    expect(finalUsage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("throws when API key missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(async () => {
      for await (const chunk of streamAnthropic([{ role: "user", content: "Hi" }], "claude-3-5-sonnet-20241022", 0.7, undefined)) {
        expect(chunk).toBeDefined();
      }
    }).rejects.toThrow("ANTHROPIC_API_KEY not configured");
  });

  it("throws on a non-ok upstream response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue("boom"),
    }) as unknown as typeof fetch;

    await expect(async () => {
      for await (const chunk of streamAnthropic([{ role: "user", content: "Hi" }], "claude-3-5-sonnet-20241022", 0.7, undefined)) {
        expect(chunk).toBeDefined();
      }
    }).rejects.toThrow(/Anthropic API error/);
  });

  it("ignores malformed SSE frames", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
        'data: not-json',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      ])
    ) as unknown as typeof fetch;

    let finalUsage: any;
    for await (const chunk of streamAnthropic([{ role: "user", content: "Hi" }], "claude-3-5-sonnet-20241022", 0.7, undefined)) {
      if (chunk.usage) finalUsage = chunk.usage;
    }
    expect(finalUsage).toEqual({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  });
});

describe("streamOllama", () => {
  it("yields text deltas and a final usage chunk", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        '{"message":{"role":"assistant","content":"Hello"}}',
        '{"message":{"role":"assistant","content":" there"}}',
        '{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":8,"eval_count":4}',
      ])
    ) as unknown as typeof fetch;

    const chunks: string[] = [];
    let finalUsage: any;
    for await (const chunk of streamOllama([{ role: "user", content: "Hi" }], "llama3-8b-8192", 0.7, undefined)) {
      if (chunk.content) chunks.push(chunk.content);
      if (chunk.usage) finalUsage = chunk.usage;
    }

    expect(chunks.join("")).toBe("Hello there");
    expect(finalUsage).toEqual({ prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 });
  });

  it("throws on a non-ok upstream response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue("boom"),
    }) as unknown as typeof fetch;

    await expect(async () => {
      for await (const chunk of streamOllama([{ role: "user", content: "Hi" }], "llama3-8b-8192", 0.7, undefined)) {
        expect(chunk).toBeDefined();
      }
    }).rejects.toThrow(/Ollama API error/);
  });
});

describe("streamLLMWithFallback", () => {
  it("streams from the preferred model (Ollama path)", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        '{"message":{"role":"assistant","content":"fallback"},"done":true,"prompt_eval_count":2,"eval_count":1}',
      ])
    ) as unknown as typeof fetch;

    const chunks: string[] = [];
    for await (const chunk of streamLLMWithFallback(
      [{ role: "user", content: "Hi" }],
      "llama3-8b-8192",
      0.7,
      undefined,
      undefined
    )) {
      if (chunk.content) chunks.push(chunk.content);
    }

    expect(chunks.join("")).toBe("fallback");
  });

  it("streams from the preferred model (Anthropic path)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"claude"}}',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      ])
    ) as unknown as typeof fetch;

    const chunks: string[] = [];
    for await (const chunk of streamLLMWithFallback(
      [{ role: "user", content: "Hi" }],
      "claude-3-5-sonnet-20241022",
      0.7,
      undefined,
      undefined
    )) {
      if (chunk.content) chunks.push(chunk.content);
    }

    expect(chunks.join("")).toBe("claude");
  });

  it("throws when all models in the fallback chain fail", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    await expect(async () => {
      for await (const chunk of streamLLMWithFallback(
        [{ role: "user", content: "Hi" }],
        "llama3-8b-8192",
        0.7,
        undefined,
        undefined
      )) {
        expect(chunk).toBeDefined();
      }
    }).rejects.toThrow();
  });
});
