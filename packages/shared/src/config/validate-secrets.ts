import pino from "pino";
import crypto from "crypto";
import { getSecret } from "./secrets.js";
import { FatalConfigError } from "../errors/index.js";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

const KNOWN_BAD_VALUES = new Set([
  "default",
  "changeme",
  "secret",
  "password",
  "admin",
  "dev-key-do-not-use-in-production",
  "dev-key-do-not-use-in-production-32-chars!!",
  "your-secret-key",
  "supersecret",
  "1234567890",
  "jwt-secret",
  "change-me",
  "test-secret",
  "key",
]);

const HEX_ENTROPY_THRESHOLD = 4.3;

function calculateShannonEntropy(value: string): number {
  const len = value.length;
  if (len === 0) return 0;
  const freq: Record<string, number> = {};
  for (const ch of value) {
    freq[ch] = (freq[ch] ?? 0) + 1;
  }
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

interface SecretSpec {
  name: string;
  minLength?: number;
  rejectValues?: string[];
  requireEntropy?: boolean;
}

const REQUIRED_SECRETS: SecretSpec[] = [
  { name: "EGAOP_MASTER_ENCRYPTION_KEY", minLength: 64, requireEntropy: false },
  { name: "JWT_SECRET", minLength: 64, requireEntropy: true },
  { name: "POSTGRES_PASSWORD", minLength: 16 },
  { name: "OPENAI_API_KEY", minLength: 10 },
  { name: "GRAFANA_PASSWORD", minLength: 16 },
  { name: "INTERNAL_SERVICE_TOKEN", minLength: 32 },
  { name: "REDIS_PASSWORD", minLength: 16 },
];

function validateValue(spec: SecretSpec, value: string): string | null {
  if (!value || value.trim().length === 0) {
    return `${spec.name} is not set`;
  }

  const allRejected = new Set([
    ...KNOWN_BAD_VALUES,
    ...(spec.rejectValues ?? []),
  ]);

  const trimmed = value.trim();
  if (allRejected.has(trimmed.toLowerCase())) {
    return `${spec.name} matches a known-bad value — generate a new secret with: openssl rand -hex 32`;
  }

  if (spec.minLength && value.length < spec.minLength) {
    return `${spec.name} is too short (${value.length} < ${spec.minLength} chars)`;
  }

  if (spec.requireEntropy) {
    const entropy = calculateShannonEntropy(value);
    if (entropy < HEX_ENTROPY_THRESHOLD) {
      return `${spec.name} entropy too low (${entropy.toFixed(2)} < ${HEX_ENTROPY_THRESHOLD}). Use a cryptographically random string.`;
    }
  }

  if (spec.name === "JWT_SECRET" && process.env.NODE_ENV === "production") {
    const isFile = /[\n\r]/.test(value) || (process.env.JWT_SECRET_FILE ? true : false);
    if (isFile) {
      return `JWT_SECRET loaded from file in production — use K8s Secret or Vault injection instead`;
    }
  }

  return null;
}

export function validateSecrets(extraSecrets?: SecretSpec[]): void {
  const specs = [...REQUIRED_SECRETS, ...(extraSecrets ?? [])];
  const errors: string[] = [];

  for (const spec of specs) {
    const value = getSecret(spec.name) ?? "";
    const error = validateValue(spec, value);

    if (error) {
      errors.push(`  ✗ ${error}`);
    } else {
      logger.info(`✓ ${spec.name} validated (${value.length} chars)`);
    }
  }

  if (errors.length > 0) {
    logger.fatal(
      `Secret validation failed — refusing to start:\n${errors.join("\n")}`
    );
    process.exit(1);
  }

  logger.info("All secrets validated successfully");
}

export function validateJWTSecret(): void {
  const secret = getSecret("JWT_SECRET");
  const error = validateValue({ name: "JWT_SECRET", minLength: 64, requireEntropy: true }, secret ?? "");
  if (error) {
    throw new FatalConfigError(`JWT_SECRET validation failed: ${error}\nGenerate with: openssl rand -hex 32`);
  }
  logger.info("JWT_SECRET entropy validated");
}
