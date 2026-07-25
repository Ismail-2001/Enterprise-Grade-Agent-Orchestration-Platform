import crypto from "crypto";
import { scryptSync, timingSafeEqual } from "crypto";

export interface EncryptedPayloadV1 {
  iv: string;
  tag: string;
  data: string;
  keyId: string;
}

export interface EncryptedPayloadV2 {
  version: 2;
  algorithm: "aes-256-gcm";
  kdf: {
    name: "argon2id";
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  keyId: string;
  createdAt: string;
}

export type EncryptedPayload = EncryptedPayloadV1 | EncryptedPayloadV2;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const ARGON2_MEMORY_COST = 65536;
const ARGON2_TIME_COST = 3;
const ARGON2_PARALLELISM = 4;

const CURRENT_VERSION = 2;

export function generateNonce(): Buffer {
  return crypto.randomBytes(IV_LENGTH);
}

function deriveKeyV1(keyId: string): Buffer {
  return crypto.createHash("sha256").update(keyId).digest();
}

function deriveKeyV2(keyId: string, salt: Buffer): Buffer {
  return scryptSync(keyId, salt, KEY_LENGTH, {
    cost: 16384,
    blockSize: 8,
    parallelization: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

export async function encrypt(plaintext: string, keyId: string): Promise<EncryptedPayload> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKeyV2(keyId, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 2,
    algorithm: "aes-256-gcm",
    kdf: {
      name: "argon2id",
      memoryCost: ARGON2_MEMORY_COST,
      timeCost: ARGON2_TIME_COST,
      parallelism: ARGON2_PARALLELISM,
    },
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    keyId,
    createdAt: new Date().toISOString(),
  };
}

export async function decrypt(payload: EncryptedPayload, keyId: string): Promise<string> {
  if ("version" in payload && payload.version === 2) {
    const v2 = payload as EncryptedPayloadV2;
    const salt = Buffer.from(v2.salt, "base64");
    const iv = Buffer.from(v2.iv, "base64");
    const tag = Buffer.from(v2.tag, "base64");
    const ciphertext = Buffer.from(v2.ciphertext, "base64");
    const key = deriveKeyV2(keyId, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final("utf8");
  }

  const v1 = payload as EncryptedPayloadV1;
  const key = deriveKeyV1(v1.keyId);
  const iv = Buffer.from(v1.iv, "hex");
  const tag = Buffer.from(v1.tag, "hex");
  const encrypted = Buffer.from(v1.data, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export async function reencryptWithNewKey(oldPayload: EncryptedPayload, oldKeyId: string, newKeyId: string): Promise<EncryptedPayload> {
  const plaintext = await decrypt(oldPayload, oldKeyId);
  return encrypt(plaintext, newKeyId);
}

export function hashForCache(input: object): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT_SALT_LENGTH);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  });
  return `scrypt:${SCRYPT_COST}:${SCRYPT_BLOCK_SIZE}:${SCRYPT_PARALLELIZATION}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export async function comparePassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const cost = parseInt(parts[1] ?? "0", 10);
  const blockSize = parseInt(parts[2] ?? "0", 10);
  const parallelization = parseInt(parts[3] ?? "0", 10);
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expectedHash = Buffer.from(parts[5] ?? "", "base64");

  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH, { cost, blockSize, parallelization });
  return timingSafeEqual(hash, expectedHash);
}

export interface JWTClaims {
  sub: string;
  email: string;
  name: string;
  role: string;
  namespace_access: string[];
  iat: number;
  exp: number;
}

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let s = buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
  while (s.endsWith("=")) s = s.slice(0, -1);
  return s;
}

function base64urlDecode(str: string): Buffer {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return Buffer.from(base64, "base64");
}

export function signJWT(claims: Omit<JWTClaims, "iat" | "exp">, secret: string, expiresInSec: number = 86400): string {
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlEncode(JSON.stringify({ ...claims, iat: now, exp: now + expiresInSec }));
  const data = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(data).digest();
  return `${data}.${base64urlEncode(signature)}`;
}

export function verifyJWT(token: string, primarySecret: string, oldSecret?: string): JWTClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = parts[0] ?? "";
  const payload = parts[1] ?? "";
  const signature = parts[2] ?? "";
  const data = `${header}.${payload}`;

  const verifyWith = (secret: string): JWTClaims | null => {
    const expectedSig = crypto.createHmac("sha256", secret).update(data).digest();
    const actualSig = base64urlDecode(signature);
    if (expectedSig.length !== actualSig.length) return null;
    if (!timingSafeEqual(expectedSig, actualSig)) return null;

    const claims = JSON.parse(base64urlDecode(payload).toString("utf8")) as JWTClaims;
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now) return null;
    return claims;
  };

  const result = verifyWith(primarySecret);
  if (result) return result;

  if (oldSecret) {
    return verifyWith(oldSecret);
  }

  return null;
}
