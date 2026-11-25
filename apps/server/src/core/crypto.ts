import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "../config";

/**
 * Encryption of connection secrets at rest: Fernet (AES-128-CBC with
 * HMAC-SHA256), the format of the Django version, so secrets it stored stay
 * readable. ENCRYPTION_KEY holds one or more comma-separated Fernet keys. The
 * first key encrypts; every key decrypts, so rotation is: put a new key
 * first, run `rotate-secrets`, then drop the old key.
 */

/** A stored secret was encrypted with a key that is no longer configured. */
export class SecretUnreadable extends Error {
  constructor() {
    super("A stored secret cannot be decrypted with the configured ENCRYPTION_KEY.");
    this.name = "SecretUnreadable";
  }
}

const VERSION = 0x80;

type Key = { signing: Buffer; encryption: Buffer };

function parseKey(value: string): Key {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32)
    throw new Error("ENCRYPTION_KEY must be Fernet keys: 32 url-safe base64-encoded bytes each.");
  return { signing: bytes.subarray(0, 16), encryption: bytes.subarray(16) };
}

/** Url-safe base64 with padding, as Python's Fernet writes it. */
function encode(bytes: Buffer): string {
  return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

function keys(): Key[] {
  const settings = config();
  if (settings.encryptionKeys.length > 0) return settings.encryptionKeys.map(parseKey);
  if (!settings.isDevelopment) throw new Error("Set ENCRYPTION_KEY to encrypt connection secrets.");
  // Development and tests only: derived from the development secret.
  const digest = createHash("sha256").update(`iam-dev:${settings.AUTH_SECRET}`).digest();
  return [parseKey(digest.toString("base64url"))];
}

function encryptWith(key: Key, plaintext: Buffer, timestamp = Math.floor(Date.now() / 1000)): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", key.encryption, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.alloc(9);
  header[0] = VERSION;
  header.writeBigUInt64BE(BigInt(timestamp), 1);
  const body = Buffer.concat([header, iv, ciphertext]);
  const mac = createHmac("sha256", key.signing).update(body).digest();
  return encode(Buffer.concat([body, mac]));
}

/** The plaintext and timestamp of a token, or null when this key did not make it. */
function decryptWith(key: Key, data: Buffer): { plaintext: Buffer; timestamp: number } | null {
  const body = data.subarray(0, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const expected = createHmac("sha256", key.signing).update(body).digest();
  if (!timingSafeEqual(mac, expected)) return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key.encryption, body.subarray(9, 25));
    const plaintext = Buffer.concat([decipher.update(body.subarray(25)), decipher.final()]);
    return { plaintext, timestamp: Number(body.readBigUInt64BE(1)) };
  } catch {
    return null;
  }
}

function tokenBytes(token: string): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(token)) throw new SecretUnreadable();
  const data = Buffer.from(token, "base64url");
  // Version, timestamp, IV, at least one block, HMAC.
  if (data.length < 1 + 8 + 16 + 16 + 32 || data[0] !== VERSION || (data.length - 57) % 16 !== 0) {
    throw new SecretUnreadable();
  }
  return data;
}

export function encrypt(value: string): string {
  return encryptWith(keys()[0]!, Buffer.from(value, "utf8"));
}

export function decrypt(token: string): string {
  const data = tokenBytes(token);
  for (const key of keys()) {
    const result = decryptWith(key, data);
    if (result) return result.plaintext.toString("utf8");
  }
  throw new SecretUnreadable();
}

/** The token encrypted again with the first key, keeping its timestamp (MultiFernet.rotate). */
export function rotate(token: string): string {
  const data = tokenBytes(token);
  const all = keys();
  for (const key of all) {
    const result = decryptWith(key, data);
    if (result) return encryptWith(all[0]!, result.plaintext, result.timestamp);
  }
  throw new SecretUnreadable();
}

/** A new ENCRYPTION_KEY value. */
export function generateKey(): string {
  return encode(randomBytes(32));
}
