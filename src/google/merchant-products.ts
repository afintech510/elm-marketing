/**
 * Merchant Products API v1beta — REST client.
 *
 * Uses direct fetch() instead of @google-shopping/products gRPC client
 * to avoid OAuth2Client ↔ gRPC metadata incompatibility.
 *
 * Endpoints:
 *   POST   /products/v1beta/accounts/{id}/productInputs:insert
 *   DELETE  /products/v1beta/accounts/{id}/productInputs/{name}
 *   GET    /products/v1beta/accounts/{id}/products  (list with statuses)
 */

import { getAccessToken } from "../auth/google";

const BASE = "https://merchantapi.googleapis.com";

type MerchantApiError = {
  code: number;
  message: string;
  status: string;
};

async function merchantFetch(
  brandId: string,
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const token = await getAccessToken(brandId);
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const err = body?.error as MerchantApiError | undefined;
    const msg = err?.message || `HTTP ${res.status}`;
    const error = new Error(`Merchant API: ${msg}`) as any;
    error.code = err?.code || res.status;
    error.status = err?.status || "UNKNOWN";
    throw error;
  }

  return body;
}

// ── Insert or update a product input ────────────────────────────
export async function upsertProductInput(
  brandId: string,
  merchantId: string,
  offer: Record<string, any>
): Promise<any> {
  // Merchant API v1beta: top-level fields are channel/feedLabel/offerId/contentLanguage,
  // everything else goes under 'attributes'
  const { offerId, channel, contentLanguage, feedLabel, ...attributes } = offer;

  const payload = {
    channel,
    contentLanguage,
    feedLabel,
    offerId,
    attributes,
  };

  return merchantFetch(
    brandId,
    `/products/v1beta/accounts/${merchantId}/productInputs:insert`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
}

// ── Delete a product input ──────────────────────────────────────
export async function deleteProductInput(
  brandId: string,
  merchantId: string,
  offerId: string,
  feedLabel: string = "US",
  contentLanguage: string = "en"
): Promise<void> {
  const name = `accounts/${merchantId}/productInputs/${offerId}`;
  await merchantFetch(
    brandId,
    `/products/v1beta/${name}?dataSource=api&feedLabel=${feedLabel}&contentLanguage=${contentLanguage}`,
    { method: "DELETE" }
  );
}

// ── List products with statuses ─────────────────────────────────
export async function listProducts(
  brandId: string,
  merchantId: string,
  pageSize: number = 250
): Promise<any[]> {
  const result = await merchantFetch(
    brandId,
    `/products/v1beta/accounts/${merchantId}/products?pageSize=${pageSize}`
  );
  return result.products || [];
}

// ── Get product status (for disapproval details) ────────────────
export async function getProductStatus(
  brandId: string,
  merchantId: string,
  productName: string
): Promise<any> {
  return merchantFetch(
    brandId,
    `/products/v1beta/${productName}`
  );
}
