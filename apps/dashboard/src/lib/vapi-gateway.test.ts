// Automated tests for the Vapi gateway's pure logic (Phase 5.7).
//
// Run with:
//   cd apps/dashboard && npm run test:gateway
// (equivalent to: node --experimental-strip-types --test src/lib/vapi-gateway.test.ts)
//
// Uses Node's built-in test runner (`node:test`) rather than adding a test
// framework dependency, and Node 22's `--experimental-strip-types` rather
// than a build step — both keep this at zero new dependencies. You may see
// a one-line "MODULE_TYPELESS_PACKAGE_JSON ... Reparsing as ES module"
// warning; that's expected (this package.json has no "type" field) and
// harmless — it does not affect the dashboard app itself, which Next.js
// compiles separately.
//
// This file deliberately does NOT start a server, hit Supabase, or hit
// Vapi/n8n — it exercises the same functions the route handlers call,
// directly, with fake inputs. See docs/n8n-setup.md section 10 for the
// manual curl-based tests that cover the parts only a running server can
// (headers, status codes, actual HTTP wiring).

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyVapiSignature,
  sanitizeToolArguments,
  parseVapiCallContext,
  extractToolCalls,
  parseVapiToolCallsPayload,
  buildN8nRequestBody,
  formatVapiResults,
  stringifyResult,
  loadVapiAuthConfig,
  loadN8nGatewayConfig,
  TOOL_ROUTES,
  TRUSTED_ARG_KEYS,
} from "./vapi-gateway.ts";

const SECRET = "test-secret-do-not-use-in-real-config";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// verifyVapiSignature
// ---------------------------------------------------------------------------

test("verifyVapiSignature: accepts a correct signature with no timestamp", () => {
  const body = '{"hello":"world"}';
  const result = verifyVapiSignature({
    rawBody: body,
    signatureHeader: sign(body),
    timestampHeader: null,
    secret: SECRET,
    maxSkewSeconds: 300,
  });
  assert.deepEqual(result, { valid: true });
});

test("verifyVapiSignature: rejects a missing signature header", () => {
  const result = verifyVapiSignature({
    rawBody: "{}",
    signatureHeader: null,
    timestampHeader: null,
    secret: SECRET,
    maxSkewSeconds: 300,
  });
  assert.equal(result.valid, false);
  assert.equal((result as { reason: string }).reason, "missing_signature");
});

test("verifyVapiSignature: rejects a wrong signature (same length, different content)", () => {
  const body = '{"hello":"world"}';
  const wrongButSameLength = sign(body, "a-completely-different-secret");
  const result = verifyVapiSignature({
    rawBody: body,
    signatureHeader: wrongButSameLength,
    timestampHeader: null,
    secret: SECRET,
    maxSkewSeconds: 300,
  });
  assert.equal(result.valid, false);
  assert.equal((result as { reason: string }).reason, "signature_mismatch");
});

test("verifyVapiSignature: rejects a malformed (non-hex, non-base64) signature", () => {
  const result = verifyVapiSignature({
    rawBody: "{}",
    signatureHeader: "not a real signature!!",
    timestampHeader: null,
    secret: SECRET,
    maxSkewSeconds: 300,
  });
  assert.equal(result.valid, false);
  assert.equal((result as { reason: string }).reason, "malformed_signature");
});

test("verifyVapiSignature: rejects a signature of the wrong length without throwing", () => {
  const result = verifyVapiSignature({
    rawBody: "{}",
    signatureHeader: "aabbcc", // valid hex, wrong length
    timestampHeader: null,
    secret: SECRET,
    maxSkewSeconds: 300,
  });
  assert.equal(result.valid, false);
  assert.equal((result as { reason: string }).reason, "signature_mismatch");
});

test("verifyVapiSignature: accepts a fresh timestamp folded into the signed payload", () => {
  const body = '{"hello":"world"}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signedPayload = `${timestamp}.${body}`;
  const result = verifyVapiSignature({
    rawBody: body,
    signatureHeader: sign(signedPayload),
    timestampHeader: timestamp,
    secret: SECRET,
    maxSkewSeconds: 300,
  });
  assert.deepEqual(result, { valid: true });
});

test("verifyVapiSignature: rejects an expired timestamp (replay protection)", () => {
  const body = '{"hello":"world"}';
  const oldTimestamp = String(Math.floor(Date.now() / 1000) - 3600); // 1 hour old
  const signedPayload = `${oldTimestamp}.${body}`;
  const result = verifyVapiSignature({
    rawBody: body,
    signatureHeader: sign(signedPayload),
    timestampHeader: oldTimestamp,
    secret: SECRET,
    maxSkewSeconds: 300,
  });
  assert.equal(result.valid, false);
  assert.equal((result as { reason: string }).reason, "timestamp_out_of_range");
});

test("verifyVapiSignature: rejects a non-numeric timestamp", () => {
  const result = verifyVapiSignature({
    rawBody: "{}",
    signatureHeader: sign("garbage.{}"),
    timestampHeader: "not-a-number",
    secret: SECRET,
    maxSkewSeconds: 300,
  });
  assert.equal(result.valid, false);
  assert.equal((result as { reason: string }).reason, "malformed_timestamp");
});

test("verifyVapiSignature: a captured valid (body-only) signature cannot be replayed with a forged fresh timestamp", () => {
  // If timestamp checking were bolted on incorrectly, an attacker who
  // captured a body+signature pair could resend it later with a fresh
  // timestamp header and have it accepted. Because a present timestamp
  // header changes what's actually signed (`${timestamp}.${body}`, not
  // just `${body}`), a body-only signature must NOT validate once a
  // timestamp header is introduced.
  const body = '{"hello":"world"}';
  const bodyOnlySignature = sign(body);
  const freshTimestamp = String(Math.floor(Date.now() / 1000));
  const result = verifyVapiSignature({
    rawBody: body,
    signatureHeader: bodyOnlySignature,
    timestampHeader: freshTimestamp,
    secret: SECRET,
    maxSkewSeconds: 300,
  });
  assert.equal(result.valid, false);
  assert.equal((result as { reason: string }).reason, "signature_mismatch");
});

// ---------------------------------------------------------------------------
// sanitizeToolArguments
// ---------------------------------------------------------------------------

test("sanitizeToolArguments: strips business_id, caller_number, and call_id", () => {
  const clean = sanitizeToolArguments({
    business_id: "attacker-chosen-business",
    caller_number: "+10000000000",
    call_id: "forged-call-id",
    service_name: "Haircut",
  });
  assert.deepEqual(clean, { service_name: "Haircut" });
  for (const key of TRUSTED_ARG_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(clean, key), false, `${key} should be stripped`);
  }
});

test("sanitizeToolArguments: parses JSON-encoded string arguments", () => {
  const clean = sanitizeToolArguments(JSON.stringify({ business_id: "nope", preferred_date: "2026-08-03" }));
  assert.deepEqual(clean, { preferred_date: "2026-08-03" });
});

test("sanitizeToolArguments: treats null/undefined/non-object input as empty", () => {
  assert.deepEqual(sanitizeToolArguments(null), {});
  assert.deepEqual(sanitizeToolArguments(undefined), {});
  assert.deepEqual(sanitizeToolArguments("not json"), {});
  assert.deepEqual(sanitizeToolArguments(42), {});
  assert.deepEqual(sanitizeToolArguments(["array", "not", "object"]), {});
});

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

const SAMPLE_TOOL_CALLS_PAYLOAD = {
  message: {
    type: "tool-calls",
    toolCallList: [
      {
        id: "call_abc123",
        type: "function",
        function: {
          name: "get_availability",
          arguments: { service_or_staff: "Haircut", preferred_date: "2026-08-03", business_id: "spoofed" },
        },
      },
      {
        id: "call_def456",
        type: "function",
        function: { name: "log_call", arguments: '{"intent":"Info","outcome":"Info Provided","call_summary":"test"}' },
      },
    ],
    call: {
      id: "call-uuid-1",
      assistantId: "asst_lumen",
      phoneNumberId: "phone_lumen",
      customer: { number: "+15035550142" },
    },
  },
};

test("parseVapiCallContext: extracts call/assistant/phone/caller identity", () => {
  const context = parseVapiCallContext(SAMPLE_TOOL_CALLS_PAYLOAD);
  assert.equal(context.callId, "call-uuid-1");
  assert.equal(context.callerNumber, "+15035550142");
  assert.equal(context.assistantId, "asst_lumen");
  assert.equal(context.phoneNumberId, "phone_lumen");
  assert.equal(context.messageType, "tool-calls");
});

test("parseVapiCallContext: missing fields resolve to null, not thrown errors", () => {
  const context = parseVapiCallContext({});
  assert.deepEqual(context, {
    callId: null,
    callerNumber: null,
    assistantId: null,
    phoneNumberId: null,
    messageType: null,
  });
  assert.deepEqual(parseVapiCallContext(null), parseVapiCallContext({}));
  assert.deepEqual(parseVapiCallContext("not an object"), parseVapiCallContext({}));
});

test("extractToolCalls: reads toolCallList and preserves each tool call's id and function name", () => {
  const toolCalls = extractToolCalls(SAMPLE_TOOL_CALLS_PAYLOAD);
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0]?.id, "call_abc123");
  assert.equal(toolCalls[0]?.function.name, "get_availability");
  assert.equal(toolCalls[1]?.id, "call_def456");
  assert.equal(toolCalls[1]?.function.name, "log_call");
});

test("extractToolCalls: also reads the alternate toolCalls key", () => {
  const alt = { message: { toolCalls: SAMPLE_TOOL_CALLS_PAYLOAD.message.toolCallList } };
  const toolCalls = extractToolCalls(alt);
  assert.equal(toolCalls.length, 2);
});

test("extractToolCalls: drops entries missing an id or function name", () => {
  const malformed = { message: { toolCallList: [{ id: "", function: { name: "log_call" } }, { id: "ok", function: {} }] } };
  assert.deepEqual(extractToolCalls(malformed), []);
});

test("parseVapiToolCallsPayload: combines context + tool calls", () => {
  const parsed = parseVapiToolCallsPayload(SAMPLE_TOOL_CALLS_PAYLOAD);
  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.assistantId, "asst_lumen");
});

// ---------------------------------------------------------------------------
// buildN8nRequestBody — the LLM cannot choose or override trusted fields
// ---------------------------------------------------------------------------

test("buildN8nRequestBody: trusted values always win, even if present in cleanArguments", () => {
  const body = buildN8nRequestBody(
    // Simulates a bug elsewhere letting a trusted key slip through sanitization —
    // buildN8nRequestBody is the last line of defense and must still win.
    { service_name: "Haircut", business_id: "attacker-value", call_id: "attacker-value" },
    { businessSlug: "lumen-salon-01", callerNumber: "+15035550142", callId: "real-call-id" }
  );
  assert.equal(body.business_id, "lumen-salon-01");
  assert.equal(body.caller_number, "+15035550142");
  assert.equal(body.call_id, "real-call-id");
  assert.equal(body.service_name, "Haircut");
});

// ---------------------------------------------------------------------------
// Tool routing
// ---------------------------------------------------------------------------

test("TOOL_ROUTES: covers exactly the six function tools, not transfer_to_human", () => {
  const names = Object.keys(TOOL_ROUTES).sort();
  assert.deepEqual(names, [
    "create_booking_optional",
    "create_callback_request",
    "get_availability",
    "get_business_info",
    "get_service_or_price_info",
    "log_call",
  ]);
  assert.equal("transfer_to_human" in TOOL_ROUTES, false);
});

test("TOOL_ROUTES: each value matches its n8n webhook path convention", () => {
  assert.equal(TOOL_ROUTES.get_business_info, "get-business-info");
  assert.equal(TOOL_ROUTES.create_booking_optional, "create-booking");
});

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

test("stringifyResult: passes strings through, JSON-encodes everything else", () => {
  assert.equal(stringifyResult("already a string"), "already a string");
  assert.equal(stringifyResult({ a: 1 }), '{"a":1}');
});

test("formatVapiResults: wraps results in the shape Vapi expects", () => {
  const formatted = formatVapiResults([{ toolCallId: "call_abc123", result: "ok" }]);
  assert.deepEqual(formatted, { results: [{ toolCallId: "call_abc123", result: "ok" }] });
});

// ---------------------------------------------------------------------------
// Environment config — fail closed
// ---------------------------------------------------------------------------

test("loadVapiAuthConfig: returns null when VAPI_WEBHOOK_SECRET is unset (fail closed)", () => {
  assert.equal(loadVapiAuthConfig({}), null);
});

test("loadVapiAuthConfig: returns null when the secret is still a REPLACE_WITH placeholder", () => {
  assert.equal(loadVapiAuthConfig({ VAPI_WEBHOOK_SECRET: "REPLACE_WITH_YOUR_VAPI_WEBHOOK_HMAC_SECRET" }), null);
});

test("loadVapiAuthConfig: loads defaults when only the secret is set", () => {
  const config = loadVapiAuthConfig({ VAPI_WEBHOOK_SECRET: "a-real-secret" });
  assert.ok(config);
  assert.equal(config?.secret, "a-real-secret");
  assert.equal(config?.signatureHeader, "x-vapi-signature");
  assert.equal(config?.timestampHeader, "x-vapi-timestamp");
  assert.equal(config?.maxSkewSeconds, 300);
});

test("loadVapiAuthConfig: VAPI_TIMESTAMP_HEADER=disabled turns off replay checking", () => {
  const config = loadVapiAuthConfig({ VAPI_WEBHOOK_SECRET: "a-real-secret", VAPI_TIMESTAMP_HEADER: "disabled" });
  assert.equal(config?.timestampHeader, null);
});

test("loadN8nGatewayConfig: returns null when unconfigured or still a placeholder (fail closed)", () => {
  assert.equal(loadN8nGatewayConfig({}), null);
  assert.equal(
    loadN8nGatewayConfig({
      N8N_BASE_URL: "REPLACE_WITH_YOUR_PRIVATE_N8N_BASE_URL",
      N8N_GATEWAY_SHARED_SECRET: "a-real-secret",
    }),
    null
  );
  assert.equal(
    loadN8nGatewayConfig({
      N8N_BASE_URL: "https://n8n.internal.example",
      N8N_GATEWAY_SHARED_SECRET: "REPLACE_WITH_YOUR_INTERNAL_N8N_GATEWAY_SHARED_SECRET",
    }),
    null
  );
});

test("loadN8nGatewayConfig: loads correctly when fully configured", () => {
  const config = loadN8nGatewayConfig({
    N8N_BASE_URL: "https://n8n.internal.example",
    N8N_GATEWAY_SHARED_SECRET: "a-real-secret",
  });
  assert.ok(config);
  assert.equal(config?.n8nBaseUrl, "https://n8n.internal.example");
  assert.equal(config?.n8nGatewaySecret, "a-real-secret");
  assert.equal(config?.n8nGatewayHeaderName, "x-receptionflow-gateway-secret");
});
