// Business config loading + validation.
//
// Zero dependencies on purpose: this has to run with a bare `node` on any
// machine, with no npm install, so onboarding a business never blocks on a
// toolchain. Everything here is pure — no network, no filesystem writes.

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUSINESS_DIR = join(HERE, "..", "..", "businesses");

export const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const PRICE_TYPES = new Set(["exact", "from", "range", "on_request", "free"]);
const TRANSFER_POLICIES = new Set(["always", "business_hours_only", "never"]);

/**
 * Validates a business config. Returns { errors, warnings }.
 *
 * The split matters: `errors` mean the agent would behave unsafely or
 * incoherently and we refuse to build it. `warnings` mean the agent will
 * work but will fall back to "let me have someone call you back" more
 * often than it needs to — which is the correct degradation, not a bug.
 */
export function validateBusiness(cfg) {
  const errors = [];
  const warnings = [];
  const bad = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    return { errors: ["config is not a JSON object"], warnings };
  }

  if (!isNonEmptyString(cfg.slug)) bad("slug is required (short kebab-case id, e.g. sharma-dental)");
  else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(cfg.slug)) bad(`slug "${cfg.slug}" must be lowercase kebab-case`);

  const p = cfg.profile;
  if (!p || typeof p !== "object") bad("profile is required");
  else {
    if (!isNonEmptyString(p.name)) bad("profile.name is required");
    if (!isNonEmptyString(p.type)) warn("profile.type is empty — the agent won't know what kind of business this is");
    if (!isNonEmptyString(p.address)) warn("profile.address is empty — the agent can't tell callers where you are");
    if (p.publicPhone && !isIndianOrE164(p.publicPhone)) warn(`profile.publicPhone "${p.publicPhone}" is not in +country format`);
    if (p.currency && typeof p.currency !== "string") bad("profile.currency must be a string like \"INR\"");
    if (p.languages && !Array.isArray(p.languages)) bad("profile.languages must be an array like [\"hi\",\"en\"]");
  }

  // Hours
  const h = cfg.hours;
  if (!h || typeof h !== "object") {
    warn("hours is missing — the agent won't be able to answer 'are you open?'");
  } else {
    let anyOpen = false;
    for (const day of DAYS) {
      const v = h[day];
      if (v === undefined) { warn(`hours.${day} is missing (treated as closed)`); continue; }
      if (v === null) continue; // explicitly closed — fine
      if (typeof v !== "object") { bad(`hours.${day} must be null or { open, close }`); continue; }
      if (!isTime(v.open) || !isTime(v.close)) { bad(`hours.${day} needs open/close as "HH:MM" 24-hour times`); continue; }
      if (toMin(v.open) >= toMin(v.close)) bad(`hours.${day}: open (${v.open}) must be before close (${v.close})`);
      anyOpen = true;
    }
    if (!anyOpen) warn("every day is closed — check hours");
    for (const [i, b] of (h.breaks ?? []).entries()) {
      if (!isTime(b?.start) || !isTime(b?.end)) bad(`hours.breaks[${i}] needs start/end as "HH:MM"`);
      else if (toMin(b.start) >= toMin(b.end)) bad(`hours.breaks[${i}]: start must be before end`);
    }
    for (const [i, d] of (h.closedDates ?? []).entries()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d?.date ?? "")) bad(`hours.closedDates[${i}].date must be YYYY-MM-DD`);
    }
  }

  // Offerings
  const offerings = cfg.offerings ?? [];
  if (!Array.isArray(offerings)) bad("offerings must be an array");
  else {
    if (offerings.length === 0) warn("no offerings listed — the agent can't discuss services or prices at all");
    const seen = new Set();
    for (const [i, o] of offerings.entries()) {
      const where = `offerings[${i}]`;
      if (!isNonEmptyString(o?.name)) { bad(`${where}.name is required`); continue; }
      const key = o.name.trim().toLowerCase();
      if (seen.has(key)) bad(`${where}: duplicate name "${o.name}"`);
      seen.add(key);
      if (o.priceType && !PRICE_TYPES.has(o.priceType)) {
        bad(`${where}.priceType "${o.priceType}" must be one of: ${[...PRICE_TYPES].join(", ")}`);
      }
      const needsNumber = o.priceType === "exact" || o.priceType === "from";
      if (needsNumber && typeof o.price !== "number") {
        bad(`${where}.priceType is "${o.priceType}" so price must be a number`);
      }
      if (o.priceType === "range" && (typeof o.priceMin !== "number" || typeof o.priceMax !== "number")) {
        bad(`${where}.priceType is "range" so priceMin and priceMax must both be numbers`);
      }
      if (o.aliases && !Array.isArray(o.aliases)) bad(`${where}.aliases must be an array of strings`);
      if (o.bookable && o.durationMinutes != null && typeof o.durationMinutes !== "number") {
        bad(`${where}.durationMinutes must be a number`);
      }
    }
  }

  // FAQs
  const faqs = cfg.faqs ?? [];
  if (!Array.isArray(faqs)) bad("faqs must be an array");
  else {
    if (faqs.length === 0) warn("no FAQs — every off-script question becomes a callback");
    for (const [i, f] of faqs.entries()) {
      if (!isNonEmptyString(f?.q) || !isNonEmptyString(f?.a)) bad(`faqs[${i}] needs both q and a`);
    }
  }

  // Policies
  const pol = cfg.policies ?? {};
  if (pol.canQuotePrices && offerings.every((o) => o?.price == null && o?.priceType !== "free")) {
    warn("policies.canQuotePrices is true but no offering has a price");
  }

  // Escalation — the safety-critical one
  const esc = cfg.escalation ?? {};
  if (esc.transferPolicy && !TRANSFER_POLICIES.has(esc.transferPolicy)) {
    bad(`escalation.transferPolicy must be one of: ${[...TRANSFER_POLICIES].join(", ")}`);
  }
  if (esc.transferPolicy && esc.transferPolicy !== "never") {
    if (!isNonEmptyString(esc.transferNumber)) {
      warn("escalation.transferPolicy allows transfers but no transferNumber is set — the agent will offer a callback instead");
    } else if (!isIndianOrE164(esc.transferNumber)) {
      bad(`escalation.transferNumber "${esc.transferNumber}" must be in +country format, e.g. +919876543210`);
    } else if (/^\+?REPLACE/i.test(esc.transferNumber)) {
      warn("escalation.transferNumber is still a placeholder");
    }
  }

  return { errors, warnings };
}

/** Reads and validates one business by slug. Throws on validation errors. */
export async function loadBusiness(slug, dir = BUSINESS_DIR) {
  const raw = await readFile(join(dir, `${slug}.json`), "utf8");
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`businesses/${slug}.json is not valid JSON: ${e.message}`);
  }
  const { errors, warnings } = validateBusiness(cfg);
  if (errors.length) {
    throw new Error(`businesses/${slug}.json has ${errors.length} error(s):\n  - ${errors.join("\n  - ")}`);
  }
  return { config: normalize(cfg), warnings };
}

/** Lists available business slugs (ignores _TEMPLATE and dotfiles). */
export async function listBusinesses(dir = BUSINESS_DIR) {
  const files = await readdir(dir);
  return files
    .filter((f) => f.endsWith(".json") && !f.startsWith("_") && !f.startsWith("."))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/** Fills in defaults so downstream code never has to null-check. */
export function normalize(cfg) {
  const profile = { timezone: "Asia/Kolkata", currency: "INR", languages: ["hi", "en"], ...(cfg.profile ?? {}) };
  return {
    ...cfg,
    profile,
    agent: { name: "the receptionist", role: "receptionist", maxCallMinutes: 6, ...(cfg.agent ?? {}) },
    hours: { breaks: [], closedDates: [], ...(cfg.hours ?? {}) },
    offerings: (cfg.offerings ?? []).map((o) => ({ priceType: o.price == null ? "on_request" : "exact", bookable: false, aliases: [], ...o })),
    faqs: cfg.faqs ?? [],
    policies: { canQuotePrices: true, canBook: false, canCancel: false, neverDiscuss: [], extraRules: [], ...(cfg.policies ?? {}) },
    escalation: { transferPolicy: "business_hours_only", triggers: [], ...(cfg.escalation ?? {}) },
    capture: { askFor: ["name", "phone", "reason"], ...(cfg.capture ?? {}) },
  };
}

// --- helpers ---------------------------------------------------------------

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isTime = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

// Accepts E.164 (+<country><number>). Deliberately loose on length so this
// works outside India too — the agent core is not India-only, it just
// defaults to India.
const isIndianOrE164 = (v) => typeof v === "string" && /^\+[1-9]\d{7,14}$/.test(v.replace(/[\s-]/g, ""));

/** "10:00" -> "10 AM", "14:30" -> "2:30 PM". Voice agents must never say "14:30". */
export function spokenTime(t) {
  const [h, m] = t.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** 5000 -> "5,000 rupees" (Indian digit grouping, spoken not symbolic). */
export function spokenMoney(amount, currency = "INR") {
  if (typeof amount !== "number") return "";
  if (amount === 0) return "free";
  const unit = currency === "INR" ? "rupees" : currency;
  return `${indianGroup(amount)} ${unit}`;
}

/** Indian grouping: 1234567 -> "12,34,567". */
export function indianGroup(n) {
  const s = String(Math.round(n));
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
}
