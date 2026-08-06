// Exotel adapter — the India-compliant PSTN leg.
//
// Why Exotel and not Twilio/Vapi: TRAI requires that domestic Indian call
// signalling and media originate from infrastructure inside India, operated
// under an Indian licence. Exotel holds a UL-VNO licence and interconnects
// natively with Airtel, Jio, Vi, and BSNL. A US-hosted platform cannot
// lawfully carry these calls, which is the whole reason this file exists.
// See docs/india-telephony.md.
//
// Call path:
//   caller dials ExoPhone
//     -> Exotel App flow
//       -> Voicebot applet, which opens a WebSocket to our /media endpoint
//         -> we stream PCM both ways while the Conversation engine runs
//     -> optional Connect applet for a live human transfer
//
// VERIFY AGAINST LIVE EXOTEL DOCS: the exact voicebot stream envelope
// (event names, base64 field, chunk cadence) is written to Exotel's
// commonly documented media-streaming shape, and the parser below is
// deliberately tolerant of variations. No Exotel account exists in this
// repo to confirm against. `parseStreamEvent` is the single place to adjust
// if their envelope differs — nothing else in the codebase depends on it.

import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Inbound stream envelope
// ---------------------------------------------------------------------------

export const STREAM_EVENT = {
  CONNECTED: "connected",
  START: "start",
  MEDIA: "media",
  DTMF: "dtmf",
  STOP: "stop",
  MARK: "mark",
  CLEAR: "clear",
};

/**
 * Normalizes one inbound stream message into a stable internal shape.
 * Tolerant by design: providers nest call metadata differently and rename
 * fields between versions, so we look in several plausible places rather
 * than assuming one.
 *
 * @returns {{ event: string, payload: Buffer|null, callSid: string|null,
 *             from: string|null, to: string|null, streamSid: string|null,
 *             digit: string|null, raw: object }}
 */
export function parseStreamEvent(msg) {
  const m = typeof msg === "string" ? safeParse(msg) : msg ?? {};
  const event = String(m.event ?? m.type ?? "").toLowerCase();

  const start = m.start ?? m.stream_sid_data ?? {};
  const params = start.customParameters ?? start.custom_parameters ?? m.customParameters ?? {};
  const media = m.media ?? {};

  const b64 = media.payload ?? m.payload ?? m.audio ?? null;

  return {
    event,
    payload: b64 ? Buffer.from(b64, "base64") : null,
    callSid: first(m.call_sid, m.callSid, start.callSid, start.call_sid, m.stream_sid, m.streamSid),
    streamSid: first(m.stream_sid, m.streamSid, start.streamSid, start.stream_sid),
    from: first(m.from, start.from, params.from, params.From, m.CallFrom),
    to: first(m.to, start.to, params.to, params.To, m.CallTo),
    // Which business this call belongs to comes from a custom parameter we
    // set on the applet URL — configuration we control, never anything the
    // caller or the model can influence.
    business: first(params.business, params.Business, m.business),
    digit: first(m.dtmf?.digit, m.digit),
    sequence: m.sequence_number ?? m.sequenceNumber ?? null,
    raw: m,
  };
}

/** Outbound media frame. */
export function mediaFrame(pcm, streamSid = null) {
  const f = { event: "media", media: { payload: pcm.toString("base64") } };
  if (streamSid) f.stream_sid = streamSid;
  return f;
}

/**
 * Tells the carrier to discard whatever it has buffered from us.
 * This is what makes barge-in actually work: without it, the carrier keeps
 * playing already-sent audio for a second or more after we stop sending,
 * so the agent talks over the caller anyway.
 */
export function clearFrame(streamSid = null) {
  const f = { event: "clear" };
  if (streamSid) f.stream_sid = streamSid;
  return f;
}

/** Marks a playback position, so we can tell when audio finished playing. */
export function markFrame(name, streamSid = null) {
  const f = { event: "mark", mark: { name } };
  if (streamSid) f.stream_sid = streamSid;
  return f;
}

// ---------------------------------------------------------------------------
// Applet responses (the HTTP side of an Exotel App flow)
// ---------------------------------------------------------------------------

/**
 * Response for a Passthru applet — Exotel calls this mid-flow and continues
 * the flow regardless of the body. Useful for logging and for deciding
 * routing before the voicebot picks up.
 */
export const passthruOk = () => ({ status: "ok" });

/**
 * Builds the Connect-applet payload used to hand a live call to a human.
 * Exotel dials this number and bridges the caller to it.
 */
export function connectToNumber(number, { callerId = null, timeout = 30 } = {}) {
  return {
    select: "number",
    destination: { numbers: [number] },
    ...(callerId ? { caller_id: callerId } : {}),
    timeout,
  };
}

// ---------------------------------------------------------------------------
// Outbound / call control REST API
// ---------------------------------------------------------------------------

/**
 * Thin client for Exotel's REST API. Only what a receptionist needs:
 * connecting a live call to a human, and reading call details.
 *
 * Credentials are Basic auth (API key + token) scoped to a subdomain and
 * account SID — all server-side only, never in browser code.
 */
export function exotelClient({ apiKey, apiToken, accountSid, subdomain = "api.exotel.com" }) {
  const auth = "Basic " + Buffer.from(`${apiKey}:${apiToken}`).toString("base64");
  const base = `https://${subdomain}/v1/Accounts/${accountSid}`;

  async function call(path, { method = "GET", form: fields } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: auth,
        ...(fields ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: fields ? new URLSearchParams(fields).toString() : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Exotel ${res.status}: ${text.slice(0, 300)}`);
    return safeParse(text) ?? text;
  }

  return {
    /** Bridges an existing caller to a human agent. */
    connect({ from, to, callerId, timeLimit = 1800 }) {
      return call("/Calls/connect.json", {
        method: "POST",
        form: { From: from, To: to, CallerId: callerId, TimeLimit: timeLimit, CallType: "trans" },
      });
    },

    /** Places an outbound call. Note: outbound is subject to DLT/DND rules. */
    placeCall({ from, to, callerId, url }) {
      return call("/Calls/connect.json", {
        method: "POST",
        form: { From: from, To: to, CallerId: callerId, Url: url, CallType: "trans" },
      });
    },

    details(callSid) {
      return call(`/Calls/${callSid}.json`);
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook authentication
// ---------------------------------------------------------------------------

/**
 * Verifies a shared-secret header in constant time.
 *
 * Exotel's own webhooks don't carry an HMAC signature by default, so the
 * practical protection is a secret embedded in the URL/header you configure
 * on the applet, checked here. Constant-time comparison because a
 * byte-at-a-time early return leaks the secret to anyone who can time
 * requests.
 */
export function verifySharedSecret(provided, expected) {
  if (!expected) return { valid: false, reason: "not_configured" };
  if (!provided) return { valid: false, reason: "missing" };

  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    timingSafeEqual(b, b); // keep the timing profile flat
    return { valid: false, reason: "mismatch" };
  }
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: "mismatch" };
}

/** Optional HMAC verification, if you front Exotel with your own signer. */
export function verifyHmac(rawBody, signature, secret) {
  if (!secret || !signature) return { valid: false, reason: "not_configured" };
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let provided;
  try { provided = Buffer.from(signature, /^[0-9a-f]+$/i.test(signature) ? "hex" : "base64"); }
  catch { return { valid: false, reason: "malformed" }; }

  if (provided.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return { valid: false, reason: "mismatch" };
  }
  return timingSafeEqual(provided, expected) ? { valid: true } : { valid: false, reason: "mismatch" };
}

// ---------------------------------------------------------------------------
// Phone number helpers
// ---------------------------------------------------------------------------

/** Exotel reports caller IDs in several formats; normalize to E.164. */
export function normalizeExotelNumber(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  if (d.length === 11 && d.startsWith("0")) return `+91${d.slice(1)}`;
  if (d.length === 10 && /^[6-9]/.test(d)) return `+91${d}`;
  if (d.length > 12) return `+${d.slice(-12)}`; // some trunks prefix a route code
  return `+${d}`;
}

/**
 * Describes the Exotel App flow to build in their dashboard for a business.
 * Emitted by the setup CLI so you're not translating docs into clicks.
 */
export function appFlowPlan({ business, publicBaseUrl, transferNumber }) {
  const wsBase = publicBaseUrl.replace(/^http/, "ws");
  return {
    business,
    applets: [
      {
        step: 1,
        applet: "Passthru",
        url: `${publicBaseUrl}/exotel/incoming?business=${business}`,
        note: "Optional but recommended — logs the call and lets you reject blocked numbers before the bot answers.",
      },
      {
        step: 2,
        applet: "Voicebot",
        url: `${wsBase}/media?business=${business}`,
        note: "The main one. Streams caller audio to the agent and plays the agent's replies back.",
      },
      {
        step: 3,
        applet: "Connect",
        destination: transferNumber ?? "(set escalation.transferNumber in the business JSON)",
        note: "Only reached when the agent decides to transfer. Leave unconnected if the business never transfers.",
      },
    ],
  };
}

// --- helpers ---------------------------------------------------------------

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function first(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return String(v);
  return null;
}
