export type InjectionSeverity = "low" | "medium" | "high" | "critical";

export interface PromptInjectionResult {
  detected: boolean;
  severity: InjectionSeverity;
  confidence: number;
  indicators: string[];
}

const INJECTION_PATTERNS: Array<{
  pattern: RegExp;
  severity: InjectionSeverity;
  label: string;
}> = [
  // Direct instruction override attempts
  { pattern: /ignore (all |any )?(previous|prior|above|earlier) (instructions|messages|prompts|text)/i, severity: "critical", label: "instruction_override" },
  { pattern: /disregard (all |any )?(previous|prior|above) (instructions|rules|prompts)/i, severity: "critical", label: "instruction_override" },
  { pattern: /forget (all |any )?(previous|prior|above) (instructions|rules|prompts)/i, severity: "critical", label: "instruction_override" },
  { pattern: /(you are now |you are no longer |act as if |pretend that you are )/i, severity: "high", label: "role_reassignment" },
  { pattern: /(you'?re now|you are now) (a |an )?(different|new) (assistant|model|bot|ai)/i, severity: "high", label: "role_reassignment" },
  // System prompt exfiltration
  { pattern: /(reveal|show|print|display|output|repeat) (your|the|this) (system|initial|base) (prompt|instructions|messages?)/i, severity: "critical", label: "system_prompt_exfiltration" },
  { pattern: /(what|tell me) (is|are) (your|the) (system|base|initial) (prompt|instructions|role)/i, severity: "critical", label: "system_prompt_exfiltration" },
  // Prompt splitting / delimiter injection
  { pattern: /(ignore|disregard|forget).{0,40}(instructions|prompt).{0,40}(and |then )?(say|output|respond|do)/i, severity: "high", label: "instruction_splitting" },
  { pattern: /[=#]{5,}/i, severity: "medium", label: "delimiter_injection" },
  // Jailbreak phrases
  { pattern: /\bdan\b|jailbreak|jail.?break|do anything now|security.?bypass|unfiltered mode/i, severity: "critical", label: "jailbreak" },
  { pattern: /dev.?mode|developer mode|god.?mode|super.?mode/i, severity: "high", label: "jailbreak" },
  // Data exfiltration / leakage
  { pattern: /(secret|password|api[ _-]?key|token|credential|private key).{0,60}(leak|output|reveal|send|post|transmit|extract)/i, severity: "critical", label: "secret_exfiltration" },
  { pattern: /base64.{0,40}(decode|encode)/i, severity: "medium", label: "encoded_payload" },
  { pattern: /(hex|binary|rot13|morse).{0,30}(decode|encode)/i, severity: "medium", label: "encoded_payload" },
  // Tool/function abuse
  { pattern: /(call|invoke|execute|run) (the )?(tool|function|command).{0,40}(shell|bash|rm |sudo|chmod|curl|wget)/i, severity: "high", label: "tool_abuse" },
  // Social engineering / coercion
  { pattern: /you (must|have to|need to|will) (obey|do|follow) me|i (am|'m) your (master|creator|owner|admin)/i, severity: "high", label: "authority_override" },
  { pattern: /it'?s (for|about) (a test|testing|research|security|legal)/i, severity: "medium", label: "social_engineering" },
  { pattern: /hypothetical|simulation|pretend.{0,40}(ignore|bypass|violate)/i, severity: "medium", label: "framing" },
];

export function detectPromptInjection(text: string): PromptInjectionResult {
  if (!text) {
    return { detected: false, severity: "low", confidence: 0, indicators: [] };
  }

  const indicators: string[] = [];
  let maxSeverity: InjectionSeverity = "low";
  const severityRank: Record<InjectionSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  const labelCount = new Map<string, number>();

  for (const { pattern, severity, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      indicators.push(label);
      labelCount.set(label, (labelCount.get(label) ?? 0) + 1);
      if (severityRank[severity] > severityRank[maxSeverity]) {
        maxSeverity = severity;
      }
    }
  }

  if (indicators.length === 0) {
    return { detected: false, severity: "low", confidence: 0, indicators: [] };
  }

  const uniqueMatches = indicators.length;
  const confidence = Math.min(0.5 + uniqueMatches * 0.15, 0.98);
  return { detected: true, severity: maxSeverity, confidence, indicators };
}

export function scanMessagesForInjection(
  messages: Array<{ role?: string; content?: unknown }>,
): { detected: boolean; worst: PromptInjectionResult; violations: Array<{ role: string; result: PromptInjectionResult }> } {
  const violations: Array<{ role: string; result: PromptInjectionResult }> = [];
  let worst: PromptInjectionResult = { detected: false, severity: "low", confidence: 0, indicators: [] };

  for (const msg of messages) {
    const role = msg.role ?? "unknown";
    if (role === "system") continue; // system prompts are trusted (authored by operator)
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    const result = detectPromptInjection(content);
    if (result.detected) {
      violations.push({ role, result });
      if ((worst.detected && result.severity === "critical") || !worst.detected) {
        worst = result;
      }
    }
  }

  return { detected: violations.length > 0, worst, violations };
}
