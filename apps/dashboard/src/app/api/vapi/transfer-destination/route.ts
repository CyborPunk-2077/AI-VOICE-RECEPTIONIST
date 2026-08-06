import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import {
  loadVapiAuthConfig,
  loadN8nGatewayConfig,
  verifyVapiSignature,
  parseVapiCallContext,
  resolveBusinessFromVapiIdentity,
  forwardToN8n,
  TRANSFER_WEBHOOK_PATH,
} from "@/lib/vapi-gateway";

// Requirement (Phase 5.7): "Keep transfer_to_human as Vapi's native
// transfer tool, but use the existing n8n transfer workflow for audited
// decisioning before a live transfer."
//
// config/vapi-tools.json's `transfer_to_human` stays a native `transferCall`
// tool — Vapi performs the actual call transfer itself and does not call
// any tool-calls webhook for it. The mechanism Vapi documents for making a
// transferCall's destination dynamic (rather than the single fixed number
// in vapi-tools.json's `destinations` array) is an assistant-level server
// message, commonly referred to as a "transfer-destination-request" —
// configured on the assistant itself (Vapi dashboard: Server URL /
// Server Messages), NOT inside config/vapi-tools.json's per-tool
// `server.url`. This route is that hook's target.
//
// VERIFY AGAINST LIVE VAPI DOCS before wiring this to a real assistant:
// this project has no live Vapi account (see CLAUDE.md), so the exact
// request shape (in particular, whether/how a transfer reason hint is
// included) and the exact expected response shape for a dynamic
// destination are implemented defensively, against Vapi's commonly
// documented conventions, not confirmed against a captured real payload.
// What IS load-bearing and does not depend on that: authentication,
// business resolution, and routing every decision through n8n's audited
// transfer_to_human workflow rather than deciding locally.
export const runtime = "nodejs";

const DEFAULT_TRANSFER_REASON = "explicit_human_request";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authConfig = loadVapiAuthConfig();
  const n8nConfig = loadN8nGatewayConfig();

  if (!authConfig || !n8nConfig) {
    return NextResponse.json(
      { error: "gateway_not_configured", message: "The Vapi gateway is not configured. See docs/n8n-setup.md." },
      { status: 503 }
    );
  }

  const rawBody = await request.text();

  const verification = verifyVapiSignature({
    rawBody,
    signatureHeader: request.headers.get(authConfig.signatureHeader),
    timestampHeader: authConfig.timestampHeader ? request.headers.get(authConfig.timestampHeader) : null,
    secret: authConfig.secret,
    maxSkewSeconds: authConfig.maxSkewSeconds,
  });

  if (!verification.valid) {
    return NextResponse.json({ error: "unauthorized", reason: verification.reason }, { status: 401 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const context = parseVapiCallContext(parsedBody);

  const admin = getSupabaseAdminClient();
  const resolved = admin
    ? await resolveBusinessFromVapiIdentity(admin, {
        assistantId: context.assistantId,
        phoneNumberId: context.phoneNumberId,
      })
    : null;

  if (!resolved) {
    return noTransferFallback("business_not_mapped");
  }

  if (!context.callId || !context.callerNumber) {
    // Both are required by n8n/workflows/transfer_to_human.json — a
    // request missing either is treated as a safe non-transfer, not
    // approved with a placeholder value.
    return noTransferFallback("missing_call_context");
  }

  // Reason hint: best-effort only (see file header). A real payload may
  // carry this somewhere this doesn't yet check — falling back to the
  // most common universal trigger is deliberately conservative rather
  // than inventing specificity that isn't there.
  const reasonHint =
    typeof (parsedBody as Record<string, unknown> | null)?.["reason"] === "string"
      ? ((parsedBody as Record<string, unknown>)["reason"] as string)
      : DEFAULT_TRANSFER_REASON;

  let decision: unknown;
  try {
    const forwarded = await forwardToN8n(n8nConfig, TRANSFER_WEBHOOK_PATH, {
      business_id: resolved.businessSlug,
      call_id: context.callId,
      caller_number: context.callerNumber,
      transfer_reason: reasonHint,
    });
    decision = forwarded.ok ? forwarded.json : null;
  } catch {
    decision = null;
  }

  if (
    decision &&
    typeof decision === "object" &&
    (decision as Record<string, unknown>).decision === "transfer_approved" &&
    typeof (decision as Record<string, unknown>).transfer_number === "string"
  ) {
    const transferNumber = (decision as Record<string, unknown>).transfer_number as string;
    // Best-effort response shape for a dynamically resolved transfer
    // destination — VERIFY AGAINST LIVE VAPI DOCS (see file header).
    return NextResponse.json({
      destination: {
        type: "number",
        number: transferNumber,
        message: "One moment — I'm connecting you with someone from the team now.",
      },
    });
  }

  return noTransferFallback("callback_fallback");
}

/**
 * n8n declined the transfer (no configured number) or was unreachable, or
 * business/call context couldn't be resolved. In every case: never invent
 * a transfer destination. The response shape here is a best-effort,
 * unverified guess at how to tell Vapi "do not transfer" — see file
 * header. What's guaranteed regardless of whether Vapi parses this
 * response as intended is that no phone number is returned.
 */
function noTransferFallback(reason: string): NextResponse {
  return NextResponse.json({
    error: reason,
    message: "No human transfer destination is available right now. The assistant should offer create_callback_request instead.",
  });
}
