/**
 * Builds GMC product descriptions with ELM copy rules enforced.
 *
 * Rules (non-negotiable):
 *  - "per cu. yard" (never "/yd", never "per yard" alone)
 *  - "Locally sourced" or "Processed locally" badges (never "Responsibly sourced")
 *  - No founding-year claims ("since 19XX", "30 years", "decades")
 *  - Mulch is "double ground" (never triple ground as standard)
 *  - "cu yds" (never "yards" or "yd")
 */

import { getSourcingBadge } from "./google-taxonomy";

type DescriptionInput = {
  name: string;
  description: string | null;
  materialClass: string;
  categorySlug: string;
};

const FORBIDDEN_PATTERNS = [
  /since\s+(?:19|20)\d{2}/gi,
  /\b\d{2,3}\+?\s*years?\b/gi,
  /decades?\s+of/gi,
  /responsibly\s+sourced/gi,
  /triple\s+ground/gi,
];

function sanitize(text: string): string {
  let result = text;
  for (const pattern of FORBIDDEN_PATTERNS) {
    result = result.replace(pattern, "");
  }
  // Collapse multiple spaces
  return result.replace(/\s{2,}/g, " ").trim();
}

export function buildDescription(input: DescriptionInput): string {
  const parts: string[] = [];

  // Product description (sanitized)
  if (input.description) {
    parts.push(sanitize(input.description));
  }

  // Sourcing badge
  const badge = getSourcingBadge(input.materialClass);
  if (badge) {
    parts.push(badge + ".");
  }

  // Delivery info
  parts.push(
    "Sold per cu. yard. Delivered by dump truck anywhere in Suffolk County, Long Island. Same-day delivery available on weekday orders placed by 11 AM."
  );

  // Pickup option
  parts.push(
    "Customer pickup available at our yard: 110 Frowein Road, Center Moriches, NY 11934."
  );

  return parts.join(" ").slice(0, 5000); // GMC max 5000 chars
}

export function buildTitle(name: string): string {
  // Ensure "per cu. yard" is in the title for bulk materials
  const base = sanitize(name);
  if (base.toLowerCase().includes("per cu")) return base;
  return `${base} — Delivered per cu. yard`;
}
