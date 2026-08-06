// ReceptionFlow — Vapi tool gateway core logic (Phase 5.7)
//
// This module is the trust boundary between Vapi (the LLM-driven caller)
// and the nine n8n workflows in n8n/workflows/. Its entire job:
//   1. Prove a request genuinely came from Vapi (HMAC signature, optional
//      replay window) before doing anything else.
//   2. Resolve which business this call belongs to from Vapi's own call
//      metadata (assistant id / phone number id) via `vapi_business_map`
//      — never from anything the request body claims.
//   3. Strip business_id/caller_number/call_id out of whatever arguments
//      the LLM supplied, and inject the server-resolved values instead.
//   4. Forward only known tool names to their matching n8n webhook, with
//      an internal shared secret n8n's Header Auth checks for.
//
// Kept as pure, dependency-light functions (no Next.js imports here) so
// the security-critical pieces — signature verification, argument
// sanitization, payload parsing — can be unit tested directly with
// Node's built-in test runner (see vapi-gateway.test.ts) without needing
// a running Next.js server or real Supabase/Vapi credentials.
//
// IMPORTANT: several shapes below (the Vapi tool-call webhook payload,
// the transfer-destination-request payload, and the exact result format
// Vapi expects back) are implemented against Vapi's commonly documented
// server-message conventions, defensively parsed with fallbacks. No real
// Vapi account exists in this project yet (see CLAUDE.md / this phase's
// instructions), so these have not been verified against a live payload.
// Treat anything marked "VERIFY AGAINST LIVE VAPI DOCS" as a checklist
// item for the first real integration attempt, not a settled fact.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export interface SignatureVerificationInput {
  /** Raw (unparsed) request body — signatures must be verified before JSON.parse touches it. */
  rawBody: string;
  /** Value of the signature header, or null if absent. */
  signatureHeader: string | null;
  /** Value of the timestamp header, or null if absent / not configured. */
  timestampHeader: string | null;
  /** Shared HMAC secret. */
  secret: string;
  /** Replay window, in seconds, when a timestamp is present. */
  maxSkewSeconds: number;
}

export type SignatureFailureReason =
  | "missing_signature"
  | "malformed_signature"
  | "signature_mismatch"
  | "malformed_timestamp"
  | "timestamp_out_of_range";

export type SignatureVerificationResult =
  | { valid: true }
  | { valid: false; reason: SignatureFailureReason };

/**
 * Verifies an HMAC-SHA256 signature in constant time.
 *
 * Timestamp/replay checking is conditional: it only runs when
 * `timestampHeader` is non-null, i.e. when the incoming request actually
 * carried that header. This matches "where the selected Vapi HMAC
 * credential supports timestamps" — some webhook-signing schemes sign
 * `${timestamp}.${body}`, others sign the body alone. If a timestamp is
 * present, it is both freshness-checked (rejecting anything older than
 * `maxSkewSeconds`, which also rejects a replayed request captured and
 * resent later) and folded into the signed payload so an attacker can't
 * reuse a valid signature with a forged fresh timestamp.
 */
export function verifyVapiSignature(input: SignatureVerificationInput): SignatureVerificationResult {
  const { rawBody, signatureHeader, timestampHeader, secret, maxSkewSeconds } = input;

  if (!signatureHeader) {
    return { valid: false, reason: "missing_signature" };
  }

  let signedPayload = rawBody;

  if (timestampHeader !== null) {
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) {
      return { valid: false, reason: "malformed_timestamp" };
    }
    const nowSeconds = Date.now() / 1000;
    if (Math.abs(nowSeconds - timestamp) > maxSkewSeconds) {
      return { valid: false, reason: "timestamp_out_of_range" };
    }
    signedPayload = `${timestampHeader}.${rawBody}`;
  }

  const provided = decodeSignature(signatureHeader);
  const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest();

  if (!provided) {
    return { valid: false, reason: "malformed_signature" };
  }

  if (provided.length !== expected.length) {
    // Run a same-length constant-time compare anyway so a length mismatch
    // doesn't return measurably faster than a content mismatch.
    timingSafeEqual(expected, expected);
    return { valid: false, reason: "signature_mismatch" };
  }

  return timingSafeEqual(provided, expected) ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}

function decodeSignature(raw: string): Buffer | null {
  const value = raw.startsWith("sha256=") ? raw.slice("sha256=".length) : raw;
  if (!value) return null;
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value, "hex");
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) {
    return Buffer.from(value, "base64");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Environment / configuration — fail closed, never fail open
// ---------------------------------------------------------------------------

export interface VapiAuthConfig {
  secret: string;
  signatureHeader: string;
  /** Header name to look for, or null if timestamp/replay checking is disabled entirely. */
  timestampHeader: string | null;
  maxSkewSeconds: number;
}

type Environment = Record<string, string | undefined>;

/**
 * Reads Vapi webhook auth config from the environment. Returns null (never
 * throws) when unconfigured or still holding a REPLACE_WITH_ placeholder —
 * callers MUST treat null as "reject every request", not "skip auth".
 */
export function loadVapiAuthConfig(env: Environment = process.env): VapiAuthConfig | null {
  const secret = env.VAPI_WEBHOOK_SECRET?.trim();
  if (!secret || secret.startsWith("REPLACE_WITH")) return null;

  return {
    secret,
    signatureHeader: nonEmpty(env.VAPI_SIGNATURE_HEADER) ?? "x-vapi-signature",
    timestampHeader: resolveTimestampHeaderName(env.VAPI_TIMESTAMP_HEADER),
    maxSkewSeconds: positiveNumber(env.VAPI_SIGNATURE_MAX_SKEW_SECONDS) ?? 300,
  };
}

function resolveTimestampHeaderName(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return "x-vapi-timestamp";
  if (trimmed.toLowerCase() === "disabled" || trimmed.toLowerCase() === "none") return null;
  return trimmed;
}

export interface N8nGatewayConfig {
  n8nBaseUrl: string;
  n8nGatewaySecret: string;
  n8nGatewayHeaderName: string;
}

/** Same fail-closed contract as loadVapiAuthConfig. */
export function loadN8nGatewayConfig(env: Environment = process.env): N8nGatewayConfig | null {
  const n8nBaseUrl = env.N8N_BASE_URL?.trim();
  const n8nGatewaySecret = env.N8N_GATEWAY_SHARED_SECRET?.trim();
  if (!n8nBaseUrl || n8nBaseUrl.startsWith("REPLACE_WITH")) return null;
  if (!n8nGatewaySecret || n8nGatewaySecret.startsWith("REPLACE_WITH")) return null;

  return {
    n8nBaseUrl,
    n8nGatewaySecret,
    n8nGatewayHeaderName: nonEmpty(env.N8N_GATEWAY_HEADER_NAME) ?? "x-receptionflow-gateway-secret",
  };
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function positiveNumber(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Tool routing + argument sanitization
// ---------------------------------------------------------------------------

/**
 * Maps each LLM-facing function tool name (config/vapi-tools.json) to its
 * n8n webhook path. transfer_to_human is intentionally absent: it stays a
 * native Vapi transferCall tool (see docs/n8n-setup.md) and is not routed
 * through this table — its audited decisioning is handled by the separate
 * transfer-destination flow, see TRANSFER_WEBHOOK_PATH below.
 */
export const TOOL_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  get_business_info: "get-business-info",
  get_service_or_price_info: "get-service-or-price-info",
  get_availability: "get-availability",
  create_booking_optional: "create-booking",
  create_callback_request: "create-callback-request",
  log_call: "log-call",
});

export const TRANSFER_WEBHOOK_PATH = "transfer-to-human";

/**
 * Argument keys the gateway always strips from whatever the LLM supplied,
 * regardless of whether they're present, before forwarding to n8n. These
 * three values are only ever taken from trusted, server-resolved call
 * metadata — see resolveBusinessFromVapiIdentity and parseVapiCallContext.
 */
export const TRUSTED_ARG_KEYS = ["business_id", "caller_number", "call_id"] as const;

/**
 * Normalizes and sanitizes a tool call's `function.arguments`. Vapi may
 * send arguments as a JSON object or as a JSON-encoded string depending on
 * model/tool-calling mode — both are accepted. Anything that isn't a plain
 * object (after that one JSON.parse attempt) sanitizes to `{}` rather than
 * throwing, since a malformed arguments payload should surface as "n8n
 * rejects this for missing required fields", not a gateway crash.
 */
export function sanitizeToolArguments(rawArguments: unknown): Record<string, unknown> {
  if (rawArguments === null || rawArguments === undefined) return {};

  if (typeof rawArguments === "string") {
    try {
      return sanitizeToolArguments(JSON.parse(rawArguments) as unknown);
    } catch {
      return {};
    }
  }

  if (typeof rawArguments !== "object" || Array.isArray(rawArguments)) return {};

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawArguments as Record<string, unknown>)) {
    if ((TRUSTED_ARG_KEYS as readonly string[]).includes(key)) continue;
    clean[key] = value;
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Vapi payload parsing
// ---------------------------------------------------------------------------

export interface VapiToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: unknown };
}

export interface VapiCallContext {
  callId: string | null;
  callerNumber: string | null;
  assistantId: string | null;
  phoneNumberId: string | null;
  messageType: string | null;
}

export interface ParsedVapiToolCallsRequest extends VapiCallContext {
  toolCalls: VapiToolCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Extracts call/assistant/phone-number/caller identity from a Vapi server
 * message. Shared by both the tool-calls handler and the
 * transfer-destination-request handler — every server message Vapi sends
 * carries this same call context. VERIFY AGAINST LIVE VAPI DOCS: exact
 * field names (`call.assistantId` vs a top-level `assistantId`, etc.) once
 * a real payload is available.
 */
export function parseVapiCallContext(body: unknown): VapiCallContext {
  const root = isRecord(body) ? body : {};
  const message = isRecord(root.message) ? root.message : root;

  const call = isRecord(message.call) ? message.call : {};
  const customer = isRecord(call.customer) ? call.customer : isRecord(message.customer) ? message.customer : {};
  const assistant = isRecord(message.assistant) ? message.assistant : {};
  const phoneNumber = isRecord(message.phoneNumber) ? message.phoneNumber : {};

  return {
    callId: firstString(call.id, message.callId),
    callerNumber: firstString(customer.number),
    assistantId: firstString(call.assistantId, assistant.id, message.assistantId),
    phoneNumberId: firstString(call.phoneNumberId, phoneNumber.id, message.phoneNumberId),
    messageType: firstString(message.type),
  };
}

/** Extracts the tool-call list from a `type: "tool-calls"` server message. */
export function extractToolCalls(body: unknown): VapiToolCall[] {
  const root = isRecord(body) ? body : {};
  const message = isRecord(root.message) ? root.message : root;

  const raw =
    (Array.isArray(message.toolCallList) && message.toolCallList) ||
    (Array.isArray(message.toolCalls) && message.toolCalls) ||
    [];

  return raw
    .filter(isRecord)
    .map((item): VapiToolCall => ({
      id: typeof item.id === "string" ? item.id : "",
      type: typeof item.type === "string" ? item.type : undefined,
      function: isRecord(item.function)
        ? { name: typeof item.function.name === "string" ? item.function.name : "", arguments: item.function.arguments }
        : { name: "", arguments: undefined },
    }))
    .filter((tc) => tc.id.length > 0 && tc.function.name.length > 0);
}

export function parseVapiToolCallsPayload(body: unknown): ParsedVapiToolCallsRequest {
  return { ...parseVapiCallContext(body), toolCalls: extractToolCalls(body) };
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

export interface VapiToolResult {
  toolCallId: string;
  result: string;
}

/** Vapi expects tool call responses shaped `{ results: [{ toolCallId, result }] }`. */
export function formatVapiResults(results: VapiToolResult[]): { results: VapiToolResult[] } {
  return { results };
}

/** Vapi tool results are strings the model reads — structured data is JSON-encoded into that string. */
export function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Business resolution — the actual tenant-isolation fix this phase adds
// ---------------------------------------------------------------------------

export interface ResolvedBusiness {
  /** Internal businesses.id (uuid). Not sent anywhere outside this process. */
  businessId: string;
  /** businesses.business_slug — the value n8n's existing workflows expect as `business_id` in the request body. */
  businessSlug: string;
}

/**
 * Resolves a business from Vapi's own call metadata via
 * `vapi_business_map` (supabase/migrations/0003_vapi_gateway.sql) —
 * never from anything in the request body a caller or the LLM could
 * influence. Checks assistant id first, then phone number id; returns
 * the FIRST match rather than requiring both to agree, since a business
 * may be mapped by only one of the two. Returns null if neither
 * identifier is present, neither matches a row, or Supabase is
 * unreachable — every one of those cases must be treated identically by
 * the caller (reject the request), never falling back to a default or
 * "most likely" business.
 */
export async function resolveBusinessFromVapiIdentity(
  admin: SupabaseClient<Database>,
  identity: { assistantId: string | null; phoneNumberId: string | null }
): Promise<ResolvedBusiness | null> {
  const businessId = await lookupBusinessId(admin, identity);
  if (!businessId) return null;

  const { data: businessRow, error } = await admin
    .from("businesses")
    .select("business_slug")
    .eq("id", businessId)
    .maybeSingle();

  if (error || !businessRow) return null;
  return { businessId, businessSlug: businessRow.business_slug };
}

async function lookupBusinessId(
  admin: SupabaseClient<Database>,
  identity: { assistantId: string | null; phoneNumberId: string | null }
): Promise<string | null> {
  const { assistantId, phoneNumberId } = identity;

  if (assistantId) {
    const { data } = await admin
      .from("vapi_business_map")
      .select("business_id")
      .eq("vapi_assistant_id", assistantId)
      .maybeSingle();
    if (data) return data.business_id;
  }

  if (phoneNumberId) {
    const { data } = await admin
      .from("vapi_business_map")
      .select("business_id")
      .eq("vapi_phone_number_id", phoneNumberId)
      .maybeSingle();
    if (data) return data.business_id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// n8n forwarding
// ---------------------------------------------------------------------------

export interface ForwardResult {
  ok: boolean;
  status: number;
  json: unknown;
}

/**
 * Forwards one validated, trusted-value-injected request body to the
 * matching n8n webhook, carrying the internal gateway shared secret every
 * n8n webhook node's Header Auth credential must also be configured with
 * (see docs/n8n-setup.md) — this is what makes the n8n URLs themselves
 * unusable to anyone who doesn't already hold this secret, closing off
 * direct external access to the underlying workflows.
 */
export async function forwardToN8n(
  config: N8nGatewayConfig,
  webhookPath: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<ForwardResult> {
  const url = `${config.n8nBaseUrl.replace(/\/+$/, "")}/webhook/${webhookPath}`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [config.n8nGatewayHeaderName]: config.n8nGatewaySecret,
    },
    body: JSON.stringify(body),
  });

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  return { ok: response.ok, status: response.status, json };
}

/**
 * Builds the exact body forwarded to an n8n workflow: the LLM's sanitized
 * (trusted-key-stripped) arguments, with business_id/caller_number/call_id
 * always set from the server-resolved, trusted values — even if the caller
 * or model tried to supply their own, those are already gone by the time
 * this runs (see sanitizeToolArguments).
 */
export function buildN8nRequestBody(
  cleanArguments: Record<string, unknown>,
  trusted: { businessSlug: string; callerNumber: string | null; callId: string | null }
): Record<string, unknown> {
  return {
    ...cleanArguments,
    business_id: trusted.businessSlug,
    caller_number: trusted.callerNumber,
    call_id: trusted.callId,
  };
}
