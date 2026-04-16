#!/usr/bin/env tsx
// Generates a 32-byte AES-256-GCM encryption key as base64.
// Output: 44-character base64 string. Set as MKTG_ENCRYPTION_KEY on VPS.
// Usage: npx tsx scripts/generate-encryption-key.ts

import { randomBytes } from "crypto";

const key = randomBytes(32).toString("base64");
console.log(key);
