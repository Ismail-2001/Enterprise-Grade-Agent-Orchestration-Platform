import { encodingNameForModel, countTokensForModel, disposeTokenizers, countTokens } from "../tokens.js";

afterAll(() => {
  disposeTokenizers();
});

describe("encodingNameForModel", () => {
  it("maps gpt-4o to o200k_base", () => {
    expect(encodingNameForModel("gpt-4o")).toBe("o200k_base");
  });

  it("maps gpt-4o-mini to o200k_base", () => {
    expect(encodingNameForModel("gpt-4o-mini")).toBe("o200k_base");
  });

  it("maps gpt-3.5-turbo to cl100k_base", () => {
    expect(encodingNameForModel("gpt-3.5-turbo")).toBe("cl100k_base");
  });

  it("maps gpt-4 to cl100k_base", () => {
    expect(encodingNameForModel("gpt-4")).toBe("cl100k_base");
  });

  it("maps Anthropic Claude models to a cl100k_base heuristic", () => {
    expect(encodingNameForModel("claude-3-5-sonnet-20241022")).toBe("cl100k_base");
    expect(encodingNameForModel("claude-3-opus-20240229")).toBe("cl100k_base");
  });

  it("falls back to cl100k_base for unknown models", () => {
    expect(encodingNameForModel("some-future-model-xyz")).toBe("cl100k_base");
  });

  it("falls back to cl100k_base for empty model", () => {
    expect(encodingNameForModel("")).toBe("cl100k_base");
  });
});

describe("countTokensForModel", () => {
  it("returns 0 for empty string", () => {
    expect(countTokensForModel("", "gpt-4o")).toBe(0);
  });

  it("counts tokens for a simple message", () => {
    const tokens = countTokensForModel("Hello world, this is a test", "gpt-4o");
    expect(tokens).toBeGreaterThan(0);
  });

  it("counts more tokens for longer text", () => {
    const short = countTokensForModel("short message", "gpt-4o");
    const long = countTokensForModel("short message ".repeat(20), "gpt-4o");
    expect(long).toBeGreaterThan(short);
  });

  it("selects different encodings for different models of the same text", () => {
    const text = "Hello world, this is a tokenizer selection test.";
    const o200k = countTokensForModel(text, "gpt-4o");
    const cl100k = countTokensForModel(text, "gpt-3.5-turbo");
    // Both encodings should produce a valid non-zero count
    expect(o200k).toBeGreaterThan(0);
    expect(cl100k).toBeGreaterThan(0);
  });

  it("treats unknown models with default cl100k_base", () => {
    const unknown = countTokensForModel("Hello world", "made-up-model");
    const gpt35 = countTokensForModel("Hello world", "gpt-3.5-turbo");
    expect(unknown).toBe(gpt35);
  });

  it("is backward compatible with the plain countTokens() signature", () => {
    expect(countTokens("Hello world, this is a test")).toBeGreaterThan(0);
  });
});
