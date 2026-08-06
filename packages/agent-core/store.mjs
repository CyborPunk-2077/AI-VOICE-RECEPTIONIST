// Lead + call-log storage.
//
// Prototype default is a JSON-lines file: zero setup, survives restarts,
// trivially inspectable (`cat data/leads.jsonl`), and good enough to prove
// the product to a business owner. It is NOT a production store — no
// concurrency guarantees beyond append-only writes, no retention policy.
//
// The interface is deliberately two methods so swapping in Supabase later
// (the schema in supabase/migrations already has callback_requests and
// calls tables for exactly this) is a drop-in replacement.

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "..", "..", "data");

export function createFileStore(dir = DATA_DIR) {
  const leadsPath = join(dir, "leads.jsonl");
  const callsPath = join(dir, "calls.jsonl");

  return {
    async saveLead(lead) {
      await mkdir(dir, { recursive: true });
      await appendFile(leadsPath, JSON.stringify(lead) + "\n", "utf8");
      return lead;
    },

    async logCall(entry) {
      await mkdir(dir, { recursive: true });
      await appendFile(callsPath, JSON.stringify(entry) + "\n", "utf8");
      return entry;
    },

    async listLeads(businessSlug) {
      const rows = await readJsonl(leadsPath);
      return businessSlug ? rows.filter((r) => r.business === businessSlug) : rows;
    },

    async listCalls(businessSlug) {
      const rows = await readJsonl(callsPath);
      return businessSlug ? rows.filter((r) => r.business === businessSlug) : rows;
    },
  };
}

/** In-memory store for tests — same interface, no filesystem. */
export function createMemoryStore() {
  const leads = [];
  const calls = [];
  return {
    async saveLead(lead) { leads.push(lead); return lead; },
    async logCall(entry) { calls.push(entry); return entry; },
    async listLeads(slug) { return slug ? leads.filter((l) => l.business === slug) : leads; },
    async listCalls(slug) { return slug ? calls.filter((c) => c.business === slug) : calls; },
  };
}

async function readJsonl(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .reverse(); // newest first
}
