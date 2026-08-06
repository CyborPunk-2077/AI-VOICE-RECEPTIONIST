#!/usr/bin/env node
// The agent server: tool webhooks + a console to test the agent.
//
//   node apps/agent-server/server.mjs
//   node apps/agent-server/server.mjs --port 4000 --business fitzone-gym
//
// Zero dependencies — runs on a bare Node 18+ with no npm install, so you
// can clone this and be talking to an agent in under a minute.
//
// Endpoints:                                        auth when SECRET is set
//   GET  /                     test console            —  (static page)
//   GET  /api/auth             is a secret required?   —
//   GET  /api/businesses       list configured          ✓
//   GET  /api/agent/:slug      prompt + tools           ✓
//   POST /api/tools            tool webhook (Vapi)      ✓
//   POST /api/simulate         run a tool locally       ✓
//   GET  /api/leads/:slug      captured leads           ✓
//
// AUTH: if AGENT_SERVER_SECRET is set, everything that runs a tool or
// returns caller data requires it, via the x-agent-secret header or a
// ?secret= query parameter. It is intentionally NOT required when unset, so
// local testing needs no setup — the server warns loudly at boot, and you
// must set it before exposing this to the internet.
//
// /api/leads and /api/simulate are gated for the same reason /api/tools is,
// and it is worth being explicit about why: leads are real callers' names
// and phone numbers, and /api/simulate runs capture_lead, which writes.
// Gating only the Vapi webhook — as this server used to — left both of
// those reachable by anyone who found the URL, which matters because the
// quickstart tells you to put ngrok in front of it.

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../../packages/env/load.mjs";
import {
  loadBusiness, listBusinesses, buildSystemPrompt, buildGreeting,
  toolDefinitions, runTool, createFileStore,
} from "../../packages/agent-core/index.mjs";

// Before anything reads process.env. A missing .env is fine.
loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const PORT = Number(argOf("--port", process.env.PORT || 3100));
const DEFAULT_BUSINESS = argOf("--business", process.env.DEFAULT_BUSINESS || null);
const SECRET = process.env.AGENT_SERVER_SECRET || null;

const store = createFileStore();
const cache = new Map();

async function business(slug) {
  if (!cache.has(slug)) cache.set(slug, (await loadBusiness(slug)).config);
  return cache.get(slug);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return sendFile(res, join(HERE, "public", "index.html"), "text/html");
    }
    // Unauthenticated on purpose: the console has to be able to ask whether
    // it needs a secret before it can sensibly ask you for one. Leaks
    // nothing beyond "this server has auth turned on", which is a good
    // thing for a scanner to learn.
    if (req.method === "GET" && path === "/api/auth") {
      return json(res, 200, { required: Boolean(SECRET) });
    }
    if (req.method === "GET" && path === "/api/businesses") {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      const slugs = await listBusinesses();
      const out = [];
      for (const s of slugs) {
        const c = await business(s);
        out.push({ slug: s, name: c.profile.name, type: c.profile.type, city: c.profile.city });
      }
      return json(res, 200, { businesses: out, default: DEFAULT_BUSINESS ?? slugs[0] ?? null });
    }
    if (req.method === "GET" && path.startsWith("/api/agent/")) {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      const cfg = await business(path.split("/")[3]);
      return json(res, 200, {
        slug: cfg.slug,
        name: cfg.profile.name,
        greeting: buildGreeting(cfg),
        systemPrompt: buildSystemPrompt(cfg),
        tools: toolDefinitions(cfg),
      });
    }
    // Captured leads are real people's names and phone numbers. This is the
    // most sensitive thing the server can hand out, so it is gated whenever
    // a secret exists at all.
    if (req.method === "GET" && path.startsWith("/api/leads/")) {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, { leads: await store.listLeads(path.split("/")[3]) });
    }
    // /api/simulate runs the same tools as the webhook — including
    // capture_lead, which writes. Gating /api/tools but not this one left
    // the door open next to the locked one.
    if (req.method === "POST" && path === "/api/simulate") {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      const body = await readJson(req);
      const cfg = await business(body.business);
      const result = await runTool(body.tool, body.arguments ?? {}, {
        config: cfg, store, callId: "sim_" + Date.now(), callerNumber: body.caller_number ?? null,
      });
      return json(res, 200, result);
    }
    if (req.method === "POST" && path === "/api/tools") {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      return handleToolWebhook(req, res, url);
    }
    return json(res, 404, { error: "not_found" });
  } catch (err) {
    console.error(`[error] ${path}:`, err.message);
    return json(res, 500, { error: "server_error", message: err.message });
  }
});

/**
 * True if this request may touch tools or captured leads.
 *
 * No secret configured means everything is open — that is what makes the
 * clone-and-run demo work, and the boot banner says so in as many words.
 * Once a secret exists, it is required everywhere that runs a tool or
 * returns caller data, not just on the Vapi webhook.
 *
 * The `?secret=` form is accepted because the browser console cannot set
 * headers on a plain navigation and because it makes curl one-liners
 * readable. It is no weaker than the header — both end up in the same
 * places — but prefer the header in anything scripted, since query strings
 * are the more likely of the two to be written to an access log.
 */
function authed(req) {
  if (!SECRET) return true;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const supplied = req.headers["x-agent-secret"] ?? url.searchParams.get("secret");
  return typeof supplied === "string" && timingSafeEqualStr(supplied, SECRET);
}

/** Constant-time compare, so a wrong secret leaks nothing through timing. */
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Vapi-compatible tool webhook.
 *
 * Which business a call belongs to is resolved from the URL
 * (?business=<slug>) — i.e. from configuration you control when you set up
 * the assistant, not from anything the model can put in the request body.
 * That distinction is the whole tenant-isolation story: give each business
 * its own tool URL and one business's agent can never act as another's.
 */
async function handleToolWebhook(req, res, url) {
  const body = await readJson(req);
  const msg = body?.message ?? body ?? {};
  const calls = msg.toolCallList ?? msg.toolCalls ?? [];

  const slug = url.searchParams.get("business") ?? DEFAULT_BUSINESS;
  if (!slug) return json(res, 400, { error: "no_business", message: "Add ?business=<slug> to the tool URL." });

  let cfg;
  try {
    cfg = await business(slug);
  } catch {
    return json(res, 404, { error: "unknown_business", message: `No businesses/${slug}.json` });
  }

  const callId = msg.call?.id ?? null;
  const callerNumber = msg.call?.customer?.number ?? null;

  const results = [];
  for (const c of calls) {
    const name = c?.function?.name ?? c?.name;
    let args = c?.function?.arguments ?? c?.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }

    const out = await runTool(name, args, { config: cfg, store, callId, callerNumber });
    console.log(`[tool] ${slug} ${name} -> ${out.ok ? "ok" : "declined"}`);
    results.push({ toolCallId: c?.id, result: typeof out === "string" ? out : JSON.stringify(out) });
  }

  await store.logCall({
    business: slug, call_id: callId, caller_number: callerNumber,
    tools: calls.map((c) => c?.function?.name ?? c?.name), at: new Date().toISOString(),
  });

  return json(res, 200, { results });
}

// --- helpers ---------------------------------------------------------------

function json(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b), "access-control-allow-origin": "*" });
  res.end(b);
}

async function sendFile(res, path, type) {
  try {
    const b = await readFile(path);
    res.writeHead(200, { "content-type": type, "content-length": b.length });
    res.end(b);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

server.listen(PORT, async () => {
  const slugs = await listBusinesses().catch(() => []);
  console.log(`\n  ReceptionFlow agent server`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Businesses: ${slugs.join(", ") || "(none — add one to businesses/)"}`);
  console.log(`  Tool URL:   http://localhost:${PORT}/api/tools?business=<slug>`);
  console.log(SECRET ? `  Auth:       on (x-agent-secret)` : `  Auth:       OFF — fine locally, set AGENT_SERVER_SECRET before exposing this publicly`);
  console.log(`\n  Open the URL above to test the agent without any phone setup.\n`);
});
