/**
 * Single choke point for all Google Ads mutations.
 * Enforces publish_mode, monthly budget cap, and audit logging.
 */

import { getBrandAccount } from "../auth/google";
import { calculateCurrentMonthlyBudgetCents } from "./budget-calculator";
import { writeAuditAction } from "./audit";
import { GuardrailViolation } from "./errors";

type MutationOpts = {
  brandId: string;
  action: string;
  targetResource?: string;
  payload: Record<string, unknown>;
  triggeredBy: string;
  budgetDeltaCents?: number; // positive = spend increase
};

/**
 * Validates a mutation against guardrails. Returns an audit ID for later update.
 * Throws GuardrailViolation if blocked.
 */
export async function guardMutation(opts: MutationOpts): Promise<string> {
  const account = await getBrandAccount(opts.brandId);

  // G2: publish_mode enforcement
  if (account.publish_mode === "read_only") {
    const auditId = await writeAuditAction({
      brandId: opts.brandId,
      agentName: "googleAdsCampaignAgent",
      action: opts.action,
      payload: opts.payload,
      status: "rejected_by_guardrail",
      result: { reason: "publish_mode=read_only" },
      triggeredBy: opts.triggeredBy,
    });
    throw new GuardrailViolation("publish_mode=read_only blocks all writes");
  }

  if (account.publish_mode === "suggest" && opts.triggeredBy === "system") {
    const auditId = await writeAuditAction({
      brandId: opts.brandId,
      agentName: "googleAdsCampaignAgent",
      action: opts.action,
      payload: opts.payload,
      status: "rejected_by_guardrail",
      result: { reason: "publish_mode=suggest blocks unapproved system writes" },
      triggeredBy: opts.triggeredBy,
    });
    throw new GuardrailViolation("publish_mode=suggest requires human-approved trigger");
  }

  // G3: budget cap enforcement (only for budget-increasing mutations)
  if (opts.budgetDeltaCents && opts.budgetDeltaCents > 0) {
    const currentMonthly = await calculateCurrentMonthlyBudgetCents(opts.brandId);
    const projected = currentMonthly + opts.budgetDeltaCents * 30;
    if (projected > account.monthly_budget_cap_cents) {
      const auditId = await writeAuditAction({
        brandId: opts.brandId,
        agentName: "googleAdsCampaignAgent",
        action: opts.action,
        payload: opts.payload,
        status: "rejected_by_guardrail",
        result: {
          reason: "monthly_budget_cap_exceeded",
          currentCents: currentMonthly,
          projectedCents: projected,
          capCents: account.monthly_budget_cap_cents,
        },
        triggeredBy: opts.triggeredBy,
      });
      throw new GuardrailViolation(
        `Budget cap exceeded: projected $${(projected / 100).toFixed(2)} > cap $${(account.monthly_budget_cap_cents / 100).toFixed(2)}`
      );
    }
  }

  // G4: write pending audit row (updated to success/error after mutation)
  return writeAuditAction({
    brandId: opts.brandId,
    agentName: "googleAdsCampaignAgent",
    action: opts.action,
    targetResource: opts.targetResource,
    payload: opts.payload,
    status: "pending",
    triggeredBy: opts.triggeredBy,
  });
}
