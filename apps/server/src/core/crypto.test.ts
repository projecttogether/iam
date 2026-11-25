import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, overrideConfigForTests, type Config } from "../config";
import { encryptSecrets, secretsOf } from "../engine/connections";
import { decrypt, encrypt, generateKey, rotate, SecretUnreadable } from "./crypto";

/** Port of tests/test_crypto.py. */

/** Made by Python's cryptography.fernet (Fernet(KEY).encrypt(...)), as the Django version stored secrets. */
const PYTHON_KEY = "-_jk8sgrDng2BPvt--55QUpymy0eDpTXuOJZ3JniyM8=";
const PYTHON_TOKEN =
  "gAAAAABrAJa6pI4HhAwARTORpj2qDCeiJfkLWwvk4TvqQVmSfE_eXH7mDS32UYcLEAwedybsFFyJ4DRyU6zKofbJv0MDwZCCbKKabSjWZ-5-t_CX85B4GUY=";

describe("crypto", () => {
  let original: Pick<Config, "encryptionKeys" | "isDevelopment">;
  beforeEach(() => {
    original = { encryptionKeys: config().encryptionKeys, isDevelopment: config().isDevelopment };
  });
  afterEach(() => overrideConfigForTests(original));

  it("round-trips, and the ciphertext differs", () => {
    const token = encrypt("secret");
    expect(token).not.toBe("secret");
    expect(token).not.toContain("secret");
    expect(decrypt(token)).toBe("secret");
  });

  it("reports a wrong key", () => {
    const token = encrypt("secret");
    overrideConfigForTests({ encryptionKeys: [generateKey()] });
    expect(() => decrypt(token)).toThrow(SecretUnreadable);
  });

  it("treats an invalid key as a configuration error", () => {
    overrideConfigForTests({ encryptionKeys: ["not-a-key"] });
    // Python: ImproperlyConfigured; here a plain Error, not SecretUnreadable.
    expect(() => encrypt("x")).toThrow(
      "ENCRYPTION_KEY must be Fernet keys: 32 url-safe base64-encoded bytes each.",
    );
  });

  it("needs a key in production", () => {
    overrideConfigForTests({ encryptionKeys: [], isDevelopment: false });
    expect(() => encrypt("x")).toThrow("Set ENCRYPTION_KEY to encrypt connection secrets.");
  });

  it("re-encrypts with the new key on rotation", () => {
    // Python runs `manage.py rotate_secrets` over a saved connection; the
    // TypeScript command (cli.ts rotate-secrets) runs rotate() on each one.
    const old = config().encryptionKeys[0] ?? generateKey();
    overrideConfigForTests({ encryptionKeys: [old] });
    const stored = encryptSecrets({ token: "abc" });
    const fresh = generateKey();
    overrideConfigForTests({ encryptionKeys: [fresh, old] });
    const rotated = rotate(stored);
    overrideConfigForTests({ encryptionKeys: [fresh] });
    expect(secretsOf({ secretData: rotated })).toEqual({ token: "abc" });
  });

  it("decrypts a token that Python's Fernet made", () => {
    overrideConfigForTests({ encryptionKeys: [PYTHON_KEY] });
    expect(decrypt(PYTHON_TOKEN)).toBe('{"token": "made by Python"}');
    expect(secretsOf({ secretData: PYTHON_TOKEN })).toEqual({ token: "made by Python" });
  });
});
