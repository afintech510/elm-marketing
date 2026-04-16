/**
 * Shared Google Ads + Merchant API client helpers.
 * Every agent imports from here — no direct credential handling elsewhere.
 */

import { GoogleAdsApi } from "google-ads-api";
import { createClient } from "@supabase/supabase-js";
import { decryptRefreshToken } from "../crypto/refresh-token";

// ── Supabase client (service role) ──────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

// ── Types ───────────────────────────────────────────────────────
export type BrandAccount = {
  id: string;
  brand_id: string;
  google_customer_id: string;
  merchant_id: string;
  store_code: string | null;
  refresh_token_encrypted: string;
  publish_mode: string;
  monthly_budget_cap_cents: number;
  conversion_action_purchase: string | null;
  conversion_action_lead: string | null;
};

// ── In-memory access token cache ────────────────────────────────
// Simple Map cache for access tokens (50-min TTL).
// In Phase 02+ this moves to Redis; for now a local Map is sufficient.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// ── Brand account lookup ────────────────────────────────────────
export async function getBrandAccount(brandId: string): Promise<BrandAccount> {
  const { data, error } = await supabase
    .from("mktg_google_accounts")
    .select("*")
    .eq("brand_id", brandId)
    .is("revoked_at", null)
    .single();

  if (error || !data) {
    throw new Error(`No connected Google account for brand "${brandId}"`);
  }
  if (!data.refresh_token_encrypted) {
    throw new Error(`Brand "${brandId}" has no refresh token — complete the OAuth connect flow first`);
  }
  return data as BrandAccount;
}

// ── Access token (with cache) ───────────────────────────────────
export async function getAccessToken(brandId: string): Promise<string> {
  const cached = tokenCache.get(brandId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const account = await getBrandAccount(brandId);
  const refreshToken = decryptRefreshToken(account.refresh_token_encrypted);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token refresh failed: ${await tokenRes.text()}`);
  }

  const { access_token, expires_in } = await tokenRes.json();

  // Cache with 50-min TTL (Google returns ~3600s; buffer 10min)
  tokenCache.set(brandId, {
    token: access_token,
    expiresAt: Date.now() + 50 * 60 * 1000,
  });

  return access_token;
}

// ── Google Ads client ───────────────────────────────────────────
export async function getGoogleAdsClient(brandId: string) {
  const account = await getBrandAccount(brandId);
  const refreshToken = decryptRefreshToken(account.refresh_token_encrypted);

  const api = new GoogleAdsApi({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
  });

  return api.Customer({
    customer_id: account.google_customer_id,
    // login_customer_id: undefined — Path B, no MCC
    refresh_token: refreshToken,
  });
}

// ── Invalidate cache (called on disconnect) ─────────────────────
export function invalidateTokenCache(brandId: string) {
  tokenCache.delete(brandId);
}
