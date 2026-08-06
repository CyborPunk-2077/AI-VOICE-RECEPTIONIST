// Tool definitions + handlers, driven entirely by the business config.
//
// Design note — why the service catalogue is NOT a tool:
// For a small business (a few dozen offerings) the whole catalogue fits in
// the system prompt, which means zero tool-call latency on the most common
// question a caller asks ("how much is X?"). A tool round-trip on every
// price question makes the agent feel slow on a phone line, where even
// 700ms of silence is noticeable. Tools here are reserved for things the
// prompt genuinely cannot know: the current time, and side effects
// (saving a lead, transferring a call).
//
// If a business ever has a catalogue too big for a prompt, add a
// `lookup_offering` tool here — the shape is the same as the rest.

import { isOpenAt } from "./prompt.mjs";
import { spokenMoney } from "./config.mjs";

/**
 * Provider-neutral tool definitions. `toVapiTools()` adapts these to Vapi's
 * schema; writing another adapter (Exotel/Plivo/Retell/self-hosted) means
 * mapping this same list, not redesigning the agent.
 */
export function toolDefinitions(cfg) {
  const defs = [
    {
      name: "check_hours",
      description:
        "Check whether the business is open right now, and when it next opens or closes. Use this for any question about current opening status — never answer from memory.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      name: "capture_lead",
      description:
        "Save a caller's details so the business can follow up. Use when you cannot fully answer, when the caller wants a callback, or when they want to book something you cannot confirm yourself.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller's name, as they said it." },
          phone: { type: "string", description: "Callback number in +91XXXXXXXXXX form. Read it back to confirm before calling this." },
          reason: { type: "string", description: "One short sentence on what they want." },
          preferred_time: { type: "string", description: "When they'd like to be called back, if they said. Otherwise omit." },
        },
        required: ["name", "phone", "reason"],
      },
    },
  ];

  if (cfg.escalation.transferPolicy !== "never" && cfg.escalation.transferNumber) {
    defs.push({
      name: "transfer_call",
      description:
        "Hand this call to a human. Call this only for the reasons listed in your handoff rules. It returns whether the transfer is allowed right now.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why you're transferring, in a few words." },
        },
        required: ["reason"],
      },
    });
  }

  return defs;
}

/**
 * Executes a tool by name. Pure except for `store`, which is injected so
 * this is trivially testable and so swapping the file-backed prototype
 * store for Supabase later touches exactly one argument.
 */
export async function runTool(name, args, ctx) {
  const { config: cfg, store, now = new Date() } = ctx;
  switch (name) {
    case "check_hours":
      return handleCheckHours(cfg, now);
    case "capture_lead":
      return handleCaptureLead(cfg, args, ctx, store, now);
    case "transfer_call":
      return handleTransfer(cfg, args, now);
    default:
      return { ok: false, say: "I'm not able to do that right now, but I can take your details and have someone call you back." };
  }
}

function handleCheckHours(cfg, now) {
  const status = isOpenAt(cfg, now);
  if (status.open) {
    return { ok: true, open: true, say: `Yes, we're open right now, until ${status.closesAt}.` };
  }
  switch (status.reason) {
    case "before_open":
      return { ok: true, open: false, say: `We're not open yet today — we open at ${status.opensAt}.` };
    case "after_close":
      return { ok: true, open: false, say: `We've closed for today. We shut at ${status.closedAt}.` };
    case "on_break":
      return { ok: true, open: false, say: `We're on a short ${status.detail ?? "break"} right now and reopen at ${status.resumesAt}.` };
    case "holiday":
      return { ok: true, open: false, say: `We're closed today${status.detail ? ` for ${status.detail}` : ""}.` };
    default:
      return { ok: true, open: false, say: `We're closed today.` };
  }
}

async function handleCaptureLead(cfg, args, ctx, store, now) {
  const name = str(args?.name);
  const phone = normalizeIndianPhone(args?.phone, cfg);
  const reason = str(args?.reason);

  if (!name || !reason) {
    return { ok: false, say: "Sorry, I didn't catch that — could you tell me your name and what it's regarding?" };
  }
  if (!phone) {
    return { ok: false, say: "I didn't get that number correctly — could you say it once more, slowly?" };
  }

  const lead = {
    id: `lead_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
    business: cfg.slug,
    name,
    phone,
    reason,
    preferred_time: str(args?.preferred_time) || null,
    caller_number: ctx.callerNumber ?? null,
    call_id: ctx.callId ?? null,
    created_at: now.toISOString(),
  };

  try {
    await store.saveLead(lead);
  } catch {
    // Never surface storage failures to the caller as an error — the
    // business still gets the call recording/transcript, and telling a
    // caller "the system failed" helps nobody.
    return { ok: false, say: "Got it — I've made a note and someone will get back to you." };
  }

  return {
    ok: true,
    lead_id: lead.id,
    say: `Thanks ${name}, I've noted that down. Someone from ${cfg.profile.name} will call you back on ${phone.replace("+91", "")}.`,
  };
}

function handleTransfer(cfg, args, now) {
  const e = cfg.escalation;
  if (e.transferPolicy === "never" || !e.transferNumber) {
    return { ok: false, transfer: false, say: "Let me take your details and have someone call you straight back." };
  }
  if (e.transferPolicy === "business_hours_only") {
    const status = isOpenAt(cfg, now);
    if (!status.open) {
      return {
        ok: true,
        transfer: false,
        reason: "outside_hours",
        say: "There's nobody at the desk right now, but if you give me your name and number I'll make sure someone calls you back.",
      };
    }
  }
  return {
    ok: true,
    transfer: true,
    destination: e.transferNumber,
    reason: str(args?.reason) || "caller_request",
    say: "Let me put you through to someone who can help with that.",
  };
}

// --- helpers ---------------------------------------------------------------

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Normalizes what a speech-to-text engine produces into E.164.
 * STT commonly returns "nine eight seven..." as digits with spaces, or with
 * a leading 0, or with 91 but no plus. All of those are the same number.
 * Returns null rather than guessing when it can't be sure.
 */
export function normalizeIndianPhone(raw, cfg) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;

  const isIndia = (cfg?.profile?.timezone ?? "Asia/Kolkata") === "Asia/Kolkata";
  if (isIndia) {
    if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
    else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    if (d.length === 10 && /^[6-9]/.test(d)) return `+91${d}`;
    return null; // not a valid Indian mobile — better to re-ask than store junk
  }

  if (d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

/** Adapts the neutral definitions above into Vapi's function-tool schema. */
export function toVapiTools(cfg, serverUrl) {
  return toolDefinitions(cfg).map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters },
    server: { url: serverUrl },
  }));
}

/** Human-readable one-liner for a lead, for the demo UI and notifications. */
export function describeLead(lead, cfg) {
  const when = new Date(lead.created_at).toLocaleString("en-IN", {
    timeZone: cfg?.profile?.timezone ?? "Asia/Kolkata",
  });
  return `${when} — ${lead.name} (${lead.phone}): ${lead.reason}`;
}

export { spokenMoney };
