import {
  encrypt,
  decrypt,
  reencryptWithNewKey,
  hashPassword,
  comparePassword as verifyPassword,
  signJWT,
  verifyJWT,
  generateNonce,
  hashForCache,
} from "../crypto/index.js";

describe("Crypto Module", () => {
  const testKey = "test-encryption-key-aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const plaintext = "sensitive-data-123";

  describe("encrypt/decrypt", () => {
    it("should encrypt and decrypt", async () => {
      const encrypted = await encrypt(plaintext, testKey);
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.salt).toBeTruthy();
      expect(encrypted.version).toBe(2);

      const decrypted = await decrypt(encrypted, testKey);
      expect(decrypted).toBe(plaintext);
    });

    it("should produce different ciphertext for same inputs (random salt)", async () => {
      const e1 = await encrypt(plaintext, testKey);
      const e2 = await encrypt(plaintext, testKey);
      expect(e1.ciphertext).not.toBe(e2.ciphertext);
      expect(e1.salt).not.toBe(e2.salt);
    });

    it("should reject wrong key", async () => {
      const encrypted = await encrypt(plaintext, testKey);
      await expect(decrypt(encrypted, "wrong-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toThrow();
    });
  });

  describe("reencryptWithNewKey", () => {
    it("should re-encrypt with a new key", async () => {
      const oldKey = "old-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const newKey = "new-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const encrypted = await encrypt(plaintext, oldKey);
      const reencrypted = await reencryptWithNewKey(encrypted, oldKey, newKey);

      expect(reencrypted.ciphertext).not.toBe(encrypted.ciphertext);
      expect(reencrypted.salt).not.toBe(encrypted.salt);

      const decrypted = await decrypt(reencrypted, newKey);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("hashPassword/verifyPassword", () => {
    it("should hash and verify password", async () => {
      const hash = await hashPassword("my-secure-password");
      expect(hash).toBeTruthy();
      expect(hash).not.toBe("my-secure-password");

      const valid = await verifyPassword("my-secure-password", hash);
      expect(valid).toBe(true);
    });

    it("should reject wrong password", async () => {
      const hash = await hashPassword("correct-password");
      const valid = await verifyPassword("wrong-password", hash);
      expect(valid).toBe(false);
    });

    it("should reject a malformed stored hash", async () => {
      expect(await verifyPassword("pw", "not-a-scrypt-hash")).toBe(false);
      expect(await verifyPassword("pw", "scrypt:1:2:3")).toBe(false);
    });
  });

  describe("generateNonce / hashForCache", () => {
    it("should generate a 12-byte nonce", () => {
      const nonce = generateNonce();
      expect(nonce).toHaveLength(12);
    });

    it("should hash objects canonically", () => {
      const h1 = hashForCache({ b: 1, a: 2 });
      const h2 = hashForCache({ a: 2, b: 1 });
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("signJWT / verifyJWT", () => {
    const claims = {
      sub: "user-1",
      email: "a@b.com",
      name: "A",
      role: "admin",
      namespace_access: ["default"],
    };

    it("should sign and verify a token", () => {
      const token = signJWT(claims, "secret", 3600);
      const decoded = verifyJWT(token, "secret");
      expect(decoded?.sub).toBe("user-1");
      expect(decoded?.role).toBe("admin");
    });

    it("should default to 86400s expiry", () => {
      const token = signJWT(claims, "secret");
      const decoded = verifyJWT(token, "secret");
      expect(decoded?.exp).toBeDefined();
      expect(decoded && decoded.exp - decoded.iat).toBe(86400);
    });

    it("should return null for a malformed token", () => {
      expect(verifyJWT("not-a-jwt", "secret")).toBeNull();
      expect(verifyJWT("a.b", "secret")).toBeNull();
    });

    it("should return null for a tampered signature", () => {
      const token = signJWT(claims, "secret", 3600);
      const [h, p, _s] = token.split(".");
      expect(verifyJWT(`${h}.${p}.AA${_s?.slice(2)}`, "secret")).toBeNull();
    });

    it("should return null for a token signed with the wrong secret", () => {
      const token = signJWT(claims, "secret", 3600);
      expect(verifyJWT(token, "other-secret")).toBeNull();
    });

    it("should verify with the old secret as a fallback", () => {
      const token = signJWT(claims, "old-secret", 3600);
      const decoded = verifyJWT(token, "new-secret", "old-secret");
      expect(decoded?.sub).toBe("user-1");
    });

    it("should reject an expired token", () => {
      const token = signJWT(claims, "secret", -10);
      expect(verifyJWT(token, "secret")).toBeNull();
    });
  });
});
