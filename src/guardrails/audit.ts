import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

type AuditInput = {
  brandId: string;
  agentName: string;
  action: string;
  targetResource?: string;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  status: "pending" | "success" | "error" | "rejected_by_guardrail";
  triggeredBy: string;
};

export async function writeAuditAction(input: AuditInput): Promise<string> {
  const { data, error } = await (supabase as any)
    .from("mktg_agent_actions")
    .insert({
      brand_id: input.brandId,
      agent_name: input.agentName,
      action: input.action,
      target_resource: input.targetResource,
      payload: input.payload,
      result: input.result,
      status: input.status,
      triggered_by: input.triggeredBy,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[audit] Failed to write audit row:", error.message);
    return "audit-failed";
  }
  return data.id;
}

export async function updateAuditAction(
  auditId: string,
  update: { status: string; targetResource?: string; result?: Record<string, unknown> }
): Promise<void> {
  if (auditId === "audit-failed") return;
  await (supabase as any)
    .from("mktg_agent_actions")
    .update({
      status: update.status,
      target_resource: update.targetResource,
      result: update.result,
    })
    .eq("id", auditId);
}
