import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

/**
 * Calculates projected monthly spend from ENABLED campaign daily budgets.
 * PAUSED campaigns don't count — they don't spend.
 */
export async function calculateCurrentMonthlyBudgetCents(brandId: string): Promise<number> {
  const { data } = await (supabase as any)
    .from("mktg_google_campaigns")
    .select("budget_cents_daily")
    .eq("brand_id", brandId)
    .eq("status", "ENABLED");

  const dailySum = (data ?? []).reduce(
    (sum: number, c: { budget_cents_daily: number | null }) => sum + (c.budget_cents_daily ?? 0),
    0
  );
  return dailySum * 30;
}
