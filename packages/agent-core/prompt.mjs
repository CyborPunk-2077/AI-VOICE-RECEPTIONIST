// Business config -> voice agent system prompt.
//
// Everything the agent is allowed to say comes from the business JSON.
// Nothing here is business-specific; nothing in the JSON is prompt-specific.
// That separation is the whole point: onboarding a new business is editing
// data, never editing prose.
//
// Written for *voice*, which is a different medium from chat:
//   - no markdown, no bullet lists, no emoji (they get read aloud or garbled)
//   - short sentences, because a caller can't re-read a long one
//   - times spoken as "6 PM", never "18:00"
//   - money spoken as "1,200 rupees", never "₹1200"
//   - phone numbers read digit by digit
// And for *India specifically*: callers routinely code-switch mid-sentence
// between Hindi and English, so the agent has to match that naturally
// instead of forcing one language.

import { DAYS, spokenTime, spokenMoney, toMin } from "./config.mjs";

const LANG_NAMES = {
  hi: "Hindi", en: "English", mr: "Marathi", ta: "Tamil", te: "Telugu",
  kn: "Kannada", ml: "Malayalam", bn: "Bengali", gu: "Gujarati",
  pa: "Punjabi", or: "Odia", as: "Assamese", ur: "Urdu",
};

export function buildSystemPrompt(cfg) {
  const { profile: p, agent, policies, escalation } = cfg;
  const s = [];

  // --- Identity -----------------------------------------------------------
  s.push(`# Who you are`);
  s.push(
    `You are ${agent.name}, the ${agent.role} answering the phone for ${p.name}` +
      (p.type ? `, a ${p.type}` : "") +
      (p.city ? ` in ${p.city}` : "") +
      `. You are ${agent.persona || "warm, clear, and efficient"}.`
  );
  s.push(
    `You are speaking to a caller on a phone line. You are not a chatbot and you must never mention being an AI unless the caller directly asks — if they do ask, say plainly that you're an automated assistant for ${p.name} and offer to connect them to a person.`
  );

  // --- Language -----------------------------------------------------------
  s.push(`\n# Language`);
  const langs = (p.languages ?? ["hi", "en"]).map((l) => LANG_NAMES[l] ?? l);
  if (langs.length > 1) {
    s.push(
      `Callers may speak ${listOf(langs)}, and will often mix them within a single sentence. This is normal — mirror whatever they use. If a caller speaks Hindi, reply in natural spoken Hindi (Devanagari-free, conversational Hinglish is fine); if they switch to English mid-call, switch with them. Never announce that you're switching languages and never ask them to pick one.`
    );
  } else {
    s.push(`Speak ${langs[0]}.`);
  }
  s.push(
    `Use everyday spoken language, not formal or written language. Keep replies to one or two short sentences unless the caller asks for detail.`
  );

  // --- Voice formatting ---------------------------------------------------
  s.push(`\n# How to speak`);
  s.push(
    [
      `Say times the way people say them out loud: "6 PM", "half past 10", never "18:00".`,
      `Say money as "${spokenMoney(1200, p.currency)}", never as a symbol or "INR 1200".`,
      `Read phone numbers one digit at a time, slowly.`,
      `Never use bullet points, numbered lists, markdown, emoji, or special characters — everything you say is read aloud.`,
      `If you need to give more than three items, give the two or three most relevant and offer to go through the rest.`,
      `If the line is noisy or you didn't catch something, say so and ask them to repeat. Never guess at a name, number, or date.`,
      `Confirm names and phone numbers by reading them back before you rely on them.`,
    ].map((l) => `- ${l}`).join("\n")
  );

  // --- The business facts -------------------------------------------------
  s.push(`\n# What you know about ${p.name}`);
  s.push(factBlock(cfg));

  // --- Hours --------------------------------------------------------------
  s.push(`\n# Opening hours`);
  s.push(hoursBlock(cfg));

  // --- Offerings ----------------------------------------------------------
  if (cfg.offerings.length) {
    s.push(`\n# Services and prices`);
    s.push(offeringsBlock(cfg));
    if (policies.canQuotePrices) {
      s.push(
        `Quote only the prices listed above, exactly as listed. Where a price is marked "starting from", always say "starting from" — never quote it as a fixed price. Where a price needs an in-person assessment, say so and offer to note down their details.`
      );
    } else {
      s.push(`Do not quote any prices. If asked about cost, offer to have someone call back with exact pricing.`);
    }
    s.push(`If someone asks about something not on this list, say it's not something you can confirm and offer a callback. Never invent a service or a price.`);
  }

  // --- FAQs ---------------------------------------------------------------
  if (cfg.faqs.length) {
    s.push(`\n# Approved answers to common questions`);
    s.push(`These are the only approved answers. Use them when the question matches, in your own natural spoken words:`);
    s.push(cfg.faqs.map((f) => `- If asked "${f.q}" — ${f.a}`).join("\n"));
  }

  // --- Hard limits --------------------------------------------------------
  s.push(`\n# What you must never do`);
  const never = [
    `Never invent, guess, or estimate anything not written in this prompt — not prices, not availability, not policies, not staff names.`,
    `Never make a promise on the business's behalf beyond what's written here.`,
    ...(policies.neverDiscuss ?? []).map((t) => `Never discuss ${t}.`),
    ...(policies.extraRules ?? []),
  ];
  s.push(never.map((l) => `- ${l}`).join("\n"));
  s.push(
    `When you don't know something, the correct answer is always some version of: "I don't want to give you wrong information — let me take your number and have someone call you back with the exact details." That is never a failure. Guessing is.`
  );

  // --- Tools --------------------------------------------------------------
  s.push(`\n# Tools`);
  s.push(toolGuidance(cfg));

  // --- Escalation ---------------------------------------------------------
  s.push(`\n# When to hand off to a human`);
  s.push(escalationBlock(cfg));

  // --- Call flow ----------------------------------------------------------
  s.push(`\n# How a call should go`);
  s.push(
    [
      `Open with: "${greeting(cfg)}"`,
      `Let them explain what they need. Don't interrupt.`,
      `Answer from what you know above, or use a tool.`,
      `Before ending, ask if there's anything else.`,
      `Close warmly and briefly.`,
    ].map((l, i) => `${i + 1}. ${l}`).join("\n")
  );
  s.push(
    `Keep the whole call under about ${cfg.agent.maxCallMinutes} minutes. If it's running long or going in circles, offer a callback or a transfer rather than repeating yourself.`
  );

  return s.join("\n");
}

// --- section builders ------------------------------------------------------

function factBlock(cfg) {
  const { profile: p } = cfg;
  const out = [`- Name: ${p.name}`];
  if (p.type) out.push(`- Type of business: ${p.type}`);
  if (p.tagline) out.push(`- About: ${p.tagline}`);
  if (p.address) out.push(`- Address: ${p.address}${p.landmark ? ` (${p.landmark})` : ""}`);
  if (p.city) out.push(`- City: ${p.city}`);
  if (p.publicPhone) out.push(`- The business's own public number: ${p.publicPhone} (read it out one digit at a time)`);
  out.push(`- Current local time zone: ${p.timezone} (India Standard Time). All times you say are local time.`);
  return out.join("\n");
}

function hoursBlock(cfg) {
  const h = cfg.hours;
  const lines = DAYS.map((d) => {
    const v = h[d];
    const label = cap(d);
    if (v == null) return `- ${label}: closed`;
    return `- ${label}: ${spokenTime(v.open)} to ${spokenTime(v.close)}`;
  });
  for (const b of h.breaks ?? []) {
    lines.push(`- Closed daily for ${b.label ?? "a break"} from ${spokenTime(b.start)} to ${spokenTime(b.end)}.`);
  }
  for (const d of h.closedDates ?? []) {
    lines.push(`- Closed on ${d.date}${d.reason ? ` for ${d.reason}` : ""}.`);
  }
  lines.push(
    `If someone asks whether you're open right now, use the check_hours tool rather than working it out yourself — you do not reliably know the current date and time.`
  );
  return lines.join("\n");
}

function offeringsBlock(cfg) {
  const cur = cfg.profile.currency;
  return cfg.offerings
    .map((o) => {
      let price;
      switch (o.priceType) {
        case "exact": price = spokenMoney(o.price, cur); break;
        case "from": price = `starting from ${spokenMoney(o.price, cur)}`; break;
        case "range": price = `between ${spokenMoney(o.priceMin, cur)} and ${spokenMoney(o.priceMax, cur)}`; break;
        case "free": price = `free`; break;
        default: price = `price only after an in-person assessment`;
      }
      const bits = [`- ${o.name}: ${price}`];
      if (o.durationMinutes) bits.push(`takes about ${o.durationMinutes} minutes`);
      if (o.bookable === false) bits.push(`cannot be booked over the phone`);
      if (o.notes) bits.push(o.notes);
      const aka = (o.aliases ?? []).length ? ` (callers may call this: ${o.aliases.join(", ")})` : "";
      return bits.join(" — ") + aka;
    })
    .join("\n");
}

function toolGuidance(cfg) {
  const lines = [
    `- check_hours — use whenever the caller asks if you're open, when you close, or whether they can come now. Never answer this from memory.`,
    `- capture_lead — use to take down a caller's details whenever you can't fully answer, whenever they want a callback, and whenever they want to book something you can't confirm yourself. Collect ${listOf(cfg.capture.askFor)} before calling it. Always read the phone number back to confirm it before you save it.`,
  ];
  if (cfg.escalation.transferPolicy !== "never") {
    lines.push(`- transfer_call — use to hand the caller to a person. See the handoff rules below.`);
  }
  lines.push(`- end_call — use only after the caller has confirmed they don't need anything else.`);
  lines.push(
    `\nWhen a tool returns something, tell the caller the outcome in plain words. Never read out raw data, field names, or JSON. If a tool fails, don't mention the error — say you're having trouble pulling that up and offer to have someone call back.`
  );
  return lines.join("\n");
}

function escalationBlock(cfg) {
  const e = cfg.escalation;
  if (e.transferPolicy === "never" || !e.transferNumber) {
    return [
      `You cannot transfer calls. When any of the following happens, apologise briefly, use capture_lead to take their details, and promise a callback:`,
      ...(e.triggers ?? []).map((t) => `- ${t}`),
    ].join("\n");
  }
  const when =
    e.transferPolicy === "business_hours_only"
      ? `Transfer only during opening hours. Outside opening hours, take their details with capture_lead and promise a callback instead — do not transfer to a phone nobody will answer.`
      : `You may transfer at any time.`;
  return [
    `Use transfer_call when any of these happens:`,
    ...(e.triggers ?? []).map((t) => `- ${t}`),
    ``,
    when,
    `Before transferring, say one short line so the caller isn't left in silence — something like "Let me put you through to someone who can help with that."`,
    `Never argue with a caller who wants a human. Transfer or take a callback, immediately and politely.`,
  ].join("\n");
}

function greeting(cfg) {
  if (cfg.agent.greeting?.trim()) return cfg.agent.greeting.trim();
  return `Thank you for calling ${cfg.profile.name}, this is ${cfg.agent.name}. How can I help you?`;
}

export { greeting as buildGreeting };

// --- small helpers ---------------------------------------------------------

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function listOf(items) {
  const a = (items ?? []).filter(Boolean);
  if (a.length === 0) return "";
  if (a.length === 1) return a[0];
  return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}

/** True if the business is open at a given Date, per its own config + timezone. */
export function isOpenAt(cfg, when = new Date()) {
  const tz = cfg.profile.timezone || "Asia/Kolkata";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, weekday: "long", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(when);
  const get = (t) => parts.find((x) => x.type === t)?.value ?? "";

  const day = get("weekday").toLowerCase();
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  // Intl can render midnight as "24" in some environments; normalize it.
  const hour = get("hour") === "24" ? "00" : get("hour");
  const nowMin = toMin(`${hour}:${get("minute")}`);

  const closedDate = (cfg.hours.closedDates ?? []).find((d) => d.date === date);
  if (closedDate) return { open: false, reason: "holiday", detail: closedDate.reason ?? null, day, date };

  const today = cfg.hours[day];
  if (today == null) return { open: false, reason: "closed_today", day, date };

  if (nowMin < toMin(today.open)) {
    return { open: false, reason: "before_open", opensAt: spokenTime(today.open), day, date };
  }
  if (nowMin >= toMin(today.close)) {
    return { open: false, reason: "after_close", closedAt: spokenTime(today.close), day, date };
  }
  for (const b of cfg.hours.breaks ?? []) {
    if (nowMin >= toMin(b.start) && nowMin < toMin(b.end)) {
      return { open: false, reason: "on_break", detail: b.label ?? null, resumesAt: spokenTime(b.end), day, date };
    }
  }
  return { open: true, closesAt: spokenTime(today.close), day, date };
}
