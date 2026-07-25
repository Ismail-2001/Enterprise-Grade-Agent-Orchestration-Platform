import {
  encrypt,
  decrypt,
  reencryptWithNewKey,
  hashPassword,
  comparePassword as verifyPassword,
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
  });
});
