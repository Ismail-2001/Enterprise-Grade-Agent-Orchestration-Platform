import { get_encoding, get_encoding_name_for_model, Tiktoken, TiktokenEncoding, TiktokenModel } from "tiktoken";

const encoderCache = new Map<string, Tiktoken>();

function getEncoder(encodingName: string): Tiktoken {
  let enc = encoderCache.get(encodingName);
  if (!enc) {
    enc = get_encoding(encodingName as TiktokenEncoding);
    encoderCache.set(encodingName, enc);
  }
  return enc;
}

const MODEL_TO_ENCODING: Record<string, string> = {
  // OpenAI — handled by tiktoken's own model map where possible
  "gpt-4o": "o200k_base",
  "gpt-4o-mini": "o200k_base",
  "gpt-3.5-turbo": "cl100k_base",
  "gpt-4": "cl100k_base",
  "gpt-4-0613": "cl100k_base",
  "gpt-4-turbo": "o200k_base",
  // Anthropic — closest available encoding (no public Anthropic tokenizer)
  "claude-3-5-sonnet-20241022": "cl100k_base",
  "claude-3-5-haiku-20241022": "cl100k_base",
  "claude-3-opus-20240229": "cl100k_base",
  "claude-sonnet-4-20250514": "o200k_base",
  // Ollama / local — sentencepiece-style, closest heuristic
  "llama3-8b-8192": "cl100k_base",
  "llama3-70b-8192": "cl100k_base",
  "mixtral-8x7b-32768": "cl100k_base",
};

const DEFAULT_ENCODING = "cl100k_base";

export function encodingNameForModel(model: string): string {
  if (!model) return DEFAULT_ENCODING;
  try {
    return get_encoding_name_for_model(model as TiktokenModel);
  } catch {
    return MODEL_TO_ENCODING[model] ?? DEFAULT_ENCODING;
  }
}

export function countTokensForModel(text: string, model?: string): number {
  const encodingName = encodingNameForModel(model ?? "");
  const enc = getEncoder(encodingName);
  try {
    return enc.encode(text).length;
  } catch {
    return text.length;
  }
}

export function countTokens(text: string): number {
  return countTokensForModel(text);
}

export function disposeTokenizers(): void {
  for (const enc of encoderCache.values()) {
    try { enc.free(); } catch { /* ignore */ }
  }
  encoderCache.clear();
}
