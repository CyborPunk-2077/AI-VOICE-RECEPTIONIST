// agent-core — everything needed to turn a business JSON into a working
// voice agent, with no dependency on any particular voice provider,
// database, or web framework.
//
//   loadBusiness()      businesses/<slug>.json -> validated config
//   buildSystemPrompt() config -> the agent's system prompt
//   toolDefinitions()   config -> the tools the agent can call
//   runTool()           executes one tool call
//
// Nothing in here imports Vapi, n8n, Supabase, or Next.js. That's what
// makes the telephony provider swappable — see docs/india-telephony.md,
// which explains why that swappability is not optional for India.

export { loadBusiness, listBusinesses, validateBusiness, normalize, spokenTime, spokenMoney, indianGroup, BUSINESS_DIR, DAYS } from "./config.mjs";
export { buildSystemPrompt, buildGreeting, isOpenAt } from "./prompt.mjs";
export { toolDefinitions, toVapiTools, runTool, normalizeIndianPhone, describeLead } from "./tools.mjs";
export { createFileStore, createMemoryStore } from "./store.mjs";
