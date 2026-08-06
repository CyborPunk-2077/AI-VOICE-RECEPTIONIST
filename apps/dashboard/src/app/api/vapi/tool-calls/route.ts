import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import {
  loadVapiAuthConfig,
  loadN8nGatewayConfig,
  verifyVapiSignature,
  parseVapiToolCallsPayload,
  sanitizeToolArguments,
  buildN8nRequestBody,
  resolveBusinessFromVapiIdentity,
  forwardToN8n,
  formatVapiResults,
  stringifyResult,
  TOOL_ROUTES,
  type VapiToolResult,
} from "@/lib/vapi-gateway";

// The single server.url every function tool in config/vapi-tools.json now
// points at (see that file's _readme). This is the trust boundary
// described in docs/n8n-setup.md "Tenant isolation" — see that doc for
// the full request flow and manual test instructions.
//
// node:crypto's timingSafeEqual (used for constant-time signature
// comparison) is not guaranteed available on the Edge runtime, so this
// route explicitly opts into the Node.js runtime.
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authConfig = loadVapiAuthConfig();
  const n8nConfig = loadN8nGatewayConfig();

  // Fail closed: if either half of this gateway's own configuration is
  // missing, every request is rejected — never silently treated as
  // trusted just because a real secret hasn't been provisioned yet. This
  // is the expected, correct response in this project's current phase
  // (no real Vapi/n8n accounts exist — see CLAUDE.md).
  if (!authConfig || !n8nConfig) {
    return NextResponse.json(
      {
        error: "gateway_not_configured",
        message: "The Vapi tool gateway is not configured (VAPI_WEBHOOK_SECRET / N8N_GATEWAY_SHARED_SECRET / N8N_BASE_URL). See docs/n8n-setup.md.",
      },
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
    return NextResponse.json({ error: "invalid_json", message: "Request body was not valid JSON." }, { status: 400 });
  }

  const parsed = parseVapiToolCallsPayload(parsedBody);

  if (parsed.toolCalls.length === 0) {
    return NextResponse.json(
      { error: "no_tool_calls", message: "No recognizable tool calls were found in this request." },
      { status: 400 }
    );
  }

  const admin = getSupabaseAdminClient();
  const resolved = admin
    ? await resolveBusinessFromVapiIdentity(admin, {
        assistantId: parsed.assistantId,
        phoneNumberId: parsed.phoneNumberId,
      })
    : null;

  if (!resolved) {
    // Unresolvable business (no admin client configured, no matching
    // vapi_business_map row, or Supabase unreachable) is fatal for every
    // tool call in this batch — there is no safe partial fallback, and
    // this must never guess or default to any business.
    const results: VapiToolResult[] = parsed.toolCalls.map((toolCall) => ({
      toolCallId: toolCall.id,
      result: stringifyResult({
        error: "business_not_mapped",
        message: "This assistant/phone number is not mapped to a business in vapi_business_map yet.",
      }),
    }));
    return NextResponse.json(formatVapiResults(results));
  }

  const trusted = {
    businessSlug: resolved.businessSlug,
    callerNumber: parsed.callerNumber,
    callId: parsed.callId,
  };

  const results = await Promise.all(
    parsed.toolCalls.map(async (toolCall): Promise<VapiToolResult> => {
      const webhookPath = TOOL_ROUTES[toolCall.function.name];

      if (!webhookPath) {
        return {
          toolCallId: toolCall.id,
          result: stringifyResult({
            error: "unknown_tool",
            message: `The gateway has no route for tool "${toolCall.function.name}".`,
          }),
        };
      }

      // Whatever the model put in `arguments.business_id` /
      // `.caller_number` / `.call_id` is discarded here (sanitizeToolArguments
      // strips those keys unconditionally) and replaced with the
      // server-resolved trusted values — the LLM cannot choose or
      // override any of the three.
      const cleanArguments = sanitizeToolArguments(toolCall.function.arguments);
      const body = buildN8nRequestBody(cleanArguments, trusted);

      try {
        const forwarded = await forwardToN8n(n8nConfig, webhookPath, body);
        return {
          toolCallId: toolCall.id,
          result: stringifyResult(forwarded.json ?? { error: "empty_response", status: forwarded.status }),
        };
      } catch {
        return {
          toolCallId: toolCall.id,
          result: stringifyResult({ error: "gateway_forward_failed", message: "Could not reach the n8n backend." }),
        };
      }
    })
  );

  return NextResponse.json(formatVapiResults(results));
}
