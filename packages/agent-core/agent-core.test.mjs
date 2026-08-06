// Tests for the pieces where a bug would be silent and expensive:
// timezone-aware open/closed logic, Indian phone normalization, config
// validation, and the guarantee that no business's prompt can leak
// another's data.
//
//   node --test packages/agent-core/agent-core.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  validateBusiness, normalize, isOpenAt, buildSystemPrompt, buildGreeting,
  toolDefinitions, runTool, normalizeIndianPhone, createMemoryStore,
  spokenTime, spokenMoney, indianGroup, loadBusiness, listBusinesses,
} from "./index.mjs";

const base = () => normalize({
  slug: "test-biz",
  profile: { name: "Test Clinic", type: "clinic", city: "Jaipur", timezone: "Asia/Kolkata", currency: "INR", languages: ["hi", "en"] },
  agent: { name: "Asha", role: "receptionist" },
  hours: {
    monday: { open: "10:00", close: "18:00" },
    tuesday: { open: "10:00", close: "18:00" },
    wednesday: { open: "10:00", close: "18:00" },
    thursday: { open: "10:00", close: "18:00" },
    friday: { open: "10:00", close: "18:00" },
    saturday: { open: "10:00", close: "14:00" },
    sunday: null,
    breaks: [{ start: "13:00", end: "14:00", label: "lunch" }],
    closedDates: [{ date: "2026-10-20", reason: "Diwali" }],
  },
  offerings: [{ name: "Consultation", price: 300, priceType: "exact", bookable: true }],
  faqs: [{ q: "Parking?", a: "Yes, out front." }],
  escalation: { transferNumber: "+919876543210", transferPolicy: "business_hours_only", triggers: ["asks for a human"] },
});

/** A Date at a given IST wall-clock time. IST = UTC+5:30, no DST. */
const ist = (y, m, d, hh, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh - 5, mm - 30));

// --- opening hours ---------------------------------------------------------

test("isOpenAt: open during business hours", () => {
  // 2026-08-03 is a Monday.
  const s = isOpenAt(base(), ist(2026, 8, 3, 11, 0));
  assert.equal(s.open, true);
  assert.equal(s.closesAt, "6 PM");
});

test("isOpenAt: closed before opening", () => {
  const s = isOpenAt(base(), ist(2026, 8, 3, 9, 0));
  assert.equal(s.open, false);
  assert.equal(s.reason, "before_open");
  assert.equal(s.opensAt, "10 AM");
});

test("isOpenAt: closed after closing", () => {
  const s = isOpenAt(base(), ist(2026, 8, 3, 19, 0));
  assert.equal(s.open, false);
  assert.equal(s.reason, "after_close");
});

test("isOpenAt: closed during the lunch break", () => {
  const s = isOpenAt(base(), ist(2026, 8, 3, 13, 30));
  assert.equal(s.open, false);
  assert.equal(s.reason, "on_break");
  assert.equal(s.resumesAt, "2 PM");
});

test("isOpenAt: closed all day Sunday", () => {
  // 2026-08-02 is a Sunday.
  const s = isOpenAt(base(), ist(2026, 8, 2, 12, 0));
  assert.equal(s.open, false);
  assert.equal(s.reason, "closed_today");
});

test("isOpenAt: holiday overrides normal opening hours", () => {
  // 2026-10-20 is a Tuesday the clinic would otherwise be open on.
  const s = isOpenAt(base(), ist(2026, 10, 20, 12, 0));
  assert.equal(s.open, false);
  assert.equal(s.reason, "holiday");
  assert.equal(s.detail, "Diwali");
});

test("isOpenAt: uses IST, not the server's local timezone", () => {
  // 06:00 UTC = 11:30 IST -> open. A naive UTC implementation would say closed.
  const s = isOpenAt(base(), new Date("2026-08-03T06:00:00Z"));
  assert.equal(s.open, true);
});

test("isOpenAt: boundary — exactly at open is open, exactly at close is not", () => {
  assert.equal(isOpenAt(base(), ist(2026, 8, 3, 10, 0)).open, true);
  assert.equal(isOpenAt(base(), ist(2026, 8, 3, 18, 0)).open, false);
});

// --- phone normalization ---------------------------------------------------

test("normalizeIndianPhone: accepts the many shapes STT produces", () => {
  const cfg = base();
  for (const input of ["9876543210", "+919876543210", "09876543210", "919876543210", "98765 43210", "+91 98765-43210"]) {
    assert.equal(normalizeIndianPhone(input, cfg), "+919876543210", `failed on ${input}`);
  }
});

test("normalizeIndianPhone: rejects rather than guesses", () => {
  const cfg = base();
  for (const bad of ["12345", "", null, undefined, "abcd", "1234567890", "5876543210"]) {
    assert.equal(normalizeIndianPhone(bad, cfg), null, `should reject ${bad}`);
  }
});

test("normalizeIndianPhone: non-India config falls back to loose E.164", () => {
  const cfg = normalize({ slug: "x", profile: { name: "X", timezone: "America/New_York" } });
  assert.equal(normalizeIndianPhone("+1 415 555 0100", cfg), "+14155550100");
});

// --- validation ------------------------------------------------------------

test("validateBusiness: accepts a good config", () => {
  const { errors } = validateBusiness(base());
  assert.deepEqual(errors, []);
});

test("validateBusiness: requires slug and profile.name", () => {
  const { errors } = validateBusiness({});
  assert.ok(errors.some((e) => e.includes("slug")));
  assert.ok(errors.some((e) => e.includes("profile")));
});

test("validateBusiness: rejects a bad transfer number", () => {
  const cfg = base();
  cfg.escalation.transferNumber = "9876543210"; // no country code
  const { errors } = validateBusiness(cfg);
  assert.ok(errors.some((e) => e.includes("transferNumber")));
});

test("validateBusiness: rejects close-before-open", () => {
  const cfg = base();
  cfg.hours.monday = { open: "18:00", close: "10:00" };
  const { errors } = validateBusiness(cfg);
  assert.ok(errors.some((e) => e.includes("monday")));
});

test("validateBusiness: rejects a priced offering with no price", () => {
  const cfg = base();
  cfg.offerings = [{ name: "X", priceType: "exact" }];
  const { errors } = validateBusiness(cfg);
  assert.ok(errors.some((e) => e.includes("price must be a number")));
});

test("validateBusiness: rejects duplicate offering names", () => {
  const cfg = base();
  cfg.offerings = [{ name: "Consultation", price: 1, priceType: "exact" }, { name: "consultation", price: 2, priceType: "exact" }];
  const { errors } = validateBusiness(cfg);
  assert.ok(errors.some((e) => e.includes("duplicate")));
});

test("validateBusiness: warns (not errors) on a thin but usable config", () => {
  const { errors, warnings } = validateBusiness(normalize({ slug: "thin", profile: { name: "Thin Co" } }));
  assert.deepEqual(errors, []);
  assert.ok(warnings.length > 0);
});

// --- prompt ----------------------------------------------------------------

test("buildSystemPrompt: contains this business's facts and no placeholders", () => {
  const p = buildSystemPrompt(base());
  assert.match(p, /Test Clinic/);
  assert.match(p, /Asha/);
  assert.match(p, /300 rupees/);
  assert.doesNotMatch(p, /REPLACE_WITH|undefined|\[object Object\]/);
});

test("buildSystemPrompt: renders hours in spoken 12-hour form", () => {
  const p = buildSystemPrompt(base());
  assert.match(p, /10 AM to 6 PM/);
  // Scoped to the hours section: the "How to speak" section legitimately
  // contains the string 18:00, in the instruction telling the agent never
  // to say it.
  const hours = p.slice(p.indexOf("# Opening hours"), p.indexOf("# Services"));
  assert.doesNotMatch(hours, /\d{2}:\d{2}/);
  assert.match(hours, /Sunday: closed/);
  assert.match(hours, /lunch from 1 PM to 2 PM/);
});

test("buildSystemPrompt: two businesses never leak into each other", () => {
  const a = base();
  const b = normalize({ ...base(), slug: "other", profile: { ...base().profile, name: "Other Clinic" }, offerings: [{ name: "Xray", price: 900, priceType: "exact" }] });
  assert.doesNotMatch(buildSystemPrompt(a), /Other Clinic|Xray/);
  assert.doesNotMatch(buildSystemPrompt(b), /Test Clinic/);
});

test("buildGreeting: falls back to a sensible default, honours an override", () => {
  assert.match(buildGreeting(base()), /Test Clinic.*Asha/);
  const c = base(); c.agent.greeting = "Namaste, Test Clinic!";
  assert.equal(buildGreeting(c), "Namaste, Test Clinic!");
});

// --- tools -----------------------------------------------------------------

test("toolDefinitions: omits transfer_call when transfers are disabled", () => {
  const cfg = base();
  cfg.escalation.transferPolicy = "never";
  assert.equal(toolDefinitions(cfg).some((t) => t.name === "transfer_call"), false);
  assert.equal(toolDefinitions(base()).some((t) => t.name === "transfer_call"), true);
});

test("runTool: capture_lead stores a normalized lead", async () => {
  const store = createMemoryStore();
  const res = await runTool("capture_lead",
    { name: "Ankit", phone: "098765 43210", reason: "Root canal" },
    { config: base(), store, callId: "c1", callerNumber: "+919000000001" });
  assert.equal(res.ok, true);
  const [lead] = await store.listLeads("test-biz");
  assert.equal(lead.phone, "+919876543210");
  assert.equal(lead.name, "Ankit");
  assert.equal(lead.call_id, "c1");
});

test("runTool: capture_lead re-asks instead of storing a bad number", async () => {
  const store = createMemoryStore();
  const res = await runTool("capture_lead", { name: "A", phone: "123", reason: "x" }, { config: base(), store });
  assert.equal(res.ok, false);
  assert.equal((await store.listLeads()).length, 0);
});

test("runTool: capture_lead survives a store failure without alarming the caller", async () => {
  const broken = { saveLead: async () => { throw new Error("db down"); }, logCall: async () => {} };
  const res = await runTool("capture_lead", { name: "A", phone: "9876543210", reason: "x" }, { config: base(), store: broken });
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.say, /error|fail|db/i);
});

test("runTool: transfer_call respects business_hours_only", async () => {
  const cfg = base(), store = createMemoryStore();
  const during = await runTool("transfer_call", { reason: "r" }, { config: cfg, store, now: ist(2026, 8, 3, 11) });
  assert.equal(during.transfer, true);
  assert.equal(during.destination, "+919876543210");

  const after = await runTool("transfer_call", { reason: "r" }, { config: cfg, store, now: ist(2026, 8, 3, 22) });
  assert.equal(after.transfer, false);
  assert.equal(after.reason, "outside_hours");
});

test("runTool: transfer_call never leaks a number when transfers are off", async () => {
  const cfg = base(); cfg.escalation.transferPolicy = "never";
  const res = await runTool("transfer_call", { reason: "r" }, { config: cfg, store: createMemoryStore() });
  assert.equal(res.transfer, false);
  assert.equal(res.destination, undefined);
});

test("runTool: unknown tool degrades to a callback offer", async () => {
  const res = await runTool("nonexistent", {}, { config: base(), store: createMemoryStore() });
  assert.equal(res.ok, false);
  assert.match(res.say, /call you back/i);
});

// --- formatting ------------------------------------------------------------

test("spokenTime: 24h to spoken 12h", () => {
  assert.equal(spokenTime("09:00"), "9 AM");
  assert.equal(spokenTime("12:00"), "12 PM");
  assert.equal(spokenTime("13:30"), "1:30 PM");
  assert.equal(spokenTime("00:00"), "12 AM");
});

test("indianGroup: lakh-style digit grouping", () => {
  assert.equal(indianGroup(1200), "1,200");
  assert.equal(indianGroup(14000), "14,000");
  assert.equal(indianGroup(1234567), "12,34,567");
});

test("spokenMoney: words not symbols", () => {
  assert.equal(spokenMoney(5000), "5,000 rupees");
  assert.equal(spokenMoney(0), "free");
});

// --- the shipped configs ---------------------------------------------------

test("every business in businesses/ loads, validates, and builds a prompt", async () => {
  const slugs = await listBusinesses();
  assert.ok(slugs.length > 0);
  for (const s of slugs) {
    const { config } = await loadBusiness(s);
    const prompt = buildSystemPrompt(config);
    assert.ok(prompt.length > 500, `${s}: prompt suspiciously short`);
    assert.doesNotMatch(prompt, /undefined|\[object Object\]|NaN/, `${s}: prompt has a rendering bug`);
    assert.ok(toolDefinitions(config).length >= 2, `${s}: too few tools`);
  }
});
