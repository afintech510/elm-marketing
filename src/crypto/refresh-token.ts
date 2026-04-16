/**
 * AES-256-GCM encryption for Google OAuth refresh tokens.
 * Format: base64(iv[12] || authTag[16] || ciphertext[...])
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

function getKey(): Buffer {
  const raw = process.env.MKTG_ENCRYPTION_KEY;
  if (!raw) throw new Error("MKTG_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("MKTG_ENCRYPTION_KEY must be 32 bytes base64-encoded");
  return key;
}

export function encryptRefreshToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptRefreshToken(encoded: string): string {
  if (!encoded) throw new Error("Cannot decrypt empty token");
  const key = getKey();
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < 29) throw new Error("Invalid encrypted token (too short)");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
