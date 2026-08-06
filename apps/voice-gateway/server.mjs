#!/usr/bin/env node
// Voice gateway — answers real phone calls on an Indian number.
//
//   node apps/voice-gateway/server.mjs
//   node apps/voice-gateway/server.mjs --port 8080
//
// This is the process that must run on Indian infrastructure (a Mumbai or
// Delhi VM) for TRAI compliance. Everything upstream of it — Exotel — is
// already Indian; everything downstream (STT/LLM/TTS APIs) is a normal
// outbound HTTPS call and is not part of the regulated call path.
//
// Endpoints:
//   WS   /media                Exotel voicebot stream (the actual call audio)
//   POST /exotel/incoming      Passthru applet — logs, can reject a caller
//   POST /exotel/transfer      Connect applet — returns the human's number
//   GET  /health               provider + business readiness
//   WS   /monitor              live call feed for the console
//
// Every endpoint that matters is authenticated with EXOTEL_WEBHOOK_SECRET.

import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { attachWebSocket } from "../../packages/ws/server.mjs";
import { loadEnv } from "../../packages/env/load.mjs";
import { loadBusiness, listBusinesses, createFileStore } from "../../packages/agent-core/index.mjs";
import { providersFromEnv } from "../../packages/voice/providers.mjs";
import { Conversation } from "../../packages/voice/conversation.mjs";
import { mulawToPcm16, pcm16ToMulaw } from "../../packages/voice/audio.mjs";
import {
  parseStreamEvent, mediaFrame, clearFrame, STREAM_EVENT,
  verifySharedSecret, normalizeExotelNumber, connectToNumber, exotelClient,
} from "../../packages/telephony/exotel.mjs";

// Before anything reads process.env. A missing .env is fine.
const envFile = loadEnv();

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

// `--mock` is the flag form of MOCK_PROVIDERS=1. It exists because
// `MOCK_PROVIDERS=1 node ...` is a syntax error in cmd.exe and PowerShell,
// which made the documented no-keys path unusable on Windows.
if (argv.includes("--mock")) process.env.MOCK_PROVIDERS = "1";

const PORT = Number(argOf("--port", process.env.PORT || 8080));
const SECRET = process.env.EXOTEL_WEBHOOK_SECRET || null;
const DEFAULT_BUSINESS = process.env.DEFAULT_BUSINESS || null;
const SAMPLE_RATE = Number(process.env.TELEPHONY_SAMPLE_RATE || 8000);

// Wire format on the carrier leg. Everything above this line — the VAD, the
// STT/TTS providers, the conversation engine — speaks linear 16-bit PCM and
// nothing else; µ-law exists only in the two conversions below, at the edge.
//
// Getting this wrong does not fail loudly. It sounds like continuous loud
// static in both directions, which is a miserable thing to debug at 2am, so
// the boot banner prints the setting.
const ENCODING = (process.env.TELEPHONY_ENCODING || "pcm").toLowerCase();
if (!["pcm", "mulaw"].includes(ENCODING)) {
  console.error(`TELEPHONY_ENCODING must be "pcm" or "mulaw" — got "${ENCODING}".`);
  process.exit(1);
}
const MULAW = ENCODING === "mulaw";

/** Carrier → us. Decode inbound frames to the linear PCM the engine expects. */
const decodeInbound = (buf) => (MULAW ? mulawToPcm16(buf) : buf);
/** Us → carrier. Encode outbound PCM to whatever the trunk asked for. */
const encodeOutbound = (pcm) => (MULAW ? pcm16ToMulaw(pcm) : pcm);

const store = createFileStore();
const providers = providersFromEnv();
const configs = new Map();
const liveCalls = new Map();
const monitor = new EventEmitter();       // fans call events out to the console
monitor.setMaxListeners(50);

async function business(slug) {
  if (!configs.has(slug)) configs.set(slug, (await loadBusiness(slug)).config);
  return configs.get(slug);
}

const exotel = process.env.EXOTEL_API_KEY && process.env.EXOTEL_API_TOKEN && process.env.EXOTEL_ACCOUNT_SID
  ? exotelClient({
      apiKey: process.env.EXOTEL_API_KEY,
      apiToken: process.env.EXOTEL_API_TOKEN,
      accountSid: process.env.EXOTEL_ACCOUNT_SID,
      subdomain: process.env.EXOTEL_SUBDOMAIN || "api.exotel.com",
    })
  : null;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/health") {
      const slugs = await listBusinesses().catch(() => []);
      return json(res, providers.ready ? 200 : 503, {
        ok: providers.ready,
        providers: { stt: providers.stt?.name ?? null, tts: providers.tts?.name ?? null, llm: providers.llm?.name ?? null },
        warnings: providers.warnings,
        businesses: slugs,
        audio: { encoding: ENCODING, sampleRate: SAMPLE_RATE },
        exotel: Boolean(exotel),
        authenticated: Boolean(SECRET),
        liveCalls: liveCalls.size,
      });
    }

    if (req.method === "GET" && path === "/calls") {
      return json(res, 200, {
        live: [...liveCalls.values()].map((c) => ({
          callSid: c.callSid, business: c.business, from: c.from,
          startedAt: c.startedAt, turns: c.convo?.turns ?? 0,
        })),
      });
    }

    // --- Passthru applet: first touch, before the bot answers -------------
    if (req.method === "POST" && path === "/exotel/incoming") {
      if (!authed(req, url)) return json(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      const params = { ...Object.fromEntries(url.searchParams), ...parseForm(body) };
      const from = normalizeExotelNumber(params.CallFrom ?? params.from);
      const slug = params.business ?? DEFAULT_BUSINESS;

      console.log(`[call] incoming ${from} -> ${slug}`);
      await store.logCall({
        business: slug, call_id: params.CallSid ?? null, caller_number: from,
        event: "incoming", at: new Date().toISOString(),
      });
      monitor.emit("event", { type: "incoming", business: slug, from, callSid: params.CallSid ?? null });

      return json(res, 200, { status: "ok" });
    }

    // --- Connect applet: hand off to a human ------------------------------
    if (req.method === "POST" && path === "/exotel/transfer") {
      if (!authed(req, url)) return json(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      const params = { ...Object.fromEntries(url.searchParams), ...parseForm(body) };
      const slug = params.business ?? DEFAULT_BUSINESS;

      let cfg;
      try { cfg = await business(slug); }
      catch { return json(res, 404, { error: "unknown_business" }); }

      const number = cfg.escalation?.transferNumber;
      if (!number || cfg.escalation.transferPolicy === "never") {
        return json(res, 200, { select: "none", reason: "transfers_disabled" });
      }
      console.log(`[call] transfer ${slug} -> ${number}`);
      monitor.emit("event", { type: "transfer", business: slug, destination: number });
      return json(res, 200, connectToNumber(number, { callerId: cfg.profile.publicPhone ?? null }));
    }

    return json(res, 404, { error: "not_found" });
  } catch (err) {
    console.error(`[error] ${path}: ${err.message}`);
    return json(res, 500, { error: "server_error" });
  }
});

// ---------------------------------------------------------------------------
// WebSocket: the call audio itself
// ---------------------------------------------------------------------------

attachWebSocket(server, async (conn, req) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/monitor") return attachMonitor(conn);
  if (url.pathname !== "/media") return conn.close(1008, "unknown endpoint");

  if (SECRET) {
    const supplied = url.searchParams.get("secret") ?? req.headers["x-exotel-secret"];
    if (!verifySharedSecret(supplied, SECRET).valid) {
      console.warn("[media] rejected unauthenticated stream");
      return conn.close(1008, "unauthorized");
    }
  }

  if (!providers.ready) {
    console.error("[media] refused — providers not configured:", providers.warnings.join(" "));
    return conn.close(1011, "providers not configured");
  }

  const session = {
    callSid: null, streamSid: null, from: null, business: null,
    convo: null, startedAt: new Date().toISOString(),
  };

  conn.on("json", async (msg) => {
    const ev = parseStreamEvent(msg);

    switch (ev.event) {
      case STREAM_EVENT.CONNECTED:
        return;

      case STREAM_EVENT.START: {
        session.callSid = ev.callSid;
        session.streamSid = ev.streamSid;
        session.from = normalizeExotelNumber(ev.from);
        session.business = ev.business ?? url.searchParams.get("business") ?? DEFAULT_BUSINESS;

        let cfg;
        try {
          cfg = await business(session.business);
        } catch {
          console.error(`[media] unknown business "${session.business}"`);
          return conn.close(1011, "unknown business");
        }

        const convo = new Conversation({
          config: cfg, providers, store, sampleRate: SAMPLE_RATE,
          callId: session.callSid, callerNumber: session.from,
        });
        session.convo = convo;
        liveCalls.set(session.callSid ?? String(Date.now()), session);

        convo.on("audio", (pcm) => conn.sendJson(mediaFrame(encodeOutbound(pcm), session.streamSid)));
        // Barge-in: flush whatever the carrier still has queued from us.
        convo.on("audio-cancel", () => conn.sendJson(clearFrame(session.streamSid)));
        convo.on("transcript", (t) => {
          console.log(`[${session.business}] ${t.role}: ${t.text}`);
          monitor.emit("event", { type: "transcript", callSid: session.callSid, business: session.business, ...t });
        });
        convo.on("tool", (t) => monitor.emit("event", { type: "tool", callSid: session.callSid, business: session.business, ...t }));
        convo.on("transfer", async ({ destination }) => {
          // Exotel's own Connect applet performs the bridge; if the REST
          // client is configured we can also trigger it directly.
          if (exotel && session.from) {
            try { await exotel.connect({ from: session.from, to: destination, callerId: cfg.profile.publicPhone }); }
            catch (e) { console.error(`[transfer] ${e.message}`); }
          }
        });
        convo.on("error", (e) => console.error(`[convo] ${e.message}`));
        convo.on("ended", (entry) => {
          monitor.emit("event", { type: "ended", callSid: session.callSid, business: session.business, ...entry });
          conn.close(1000, "call ended");
        });

        console.log(`[media] call ${session.callSid} from ${session.from} -> ${session.business}`);
        monitor.emit("event", { type: "started", callSid: session.callSid, business: session.business, from: session.from });
        await convo.start();
        return;
      }

      case STREAM_EVENT.MEDIA:
        if (ev.payload && session.convo) await session.convo.pushAudio(decodeInbound(ev.payload));
        return;

      case STREAM_EVENT.DTMF:
        monitor.emit("event", { type: "dtmf", callSid: session.callSid, digit: ev.digit });
        return;

      case STREAM_EVENT.STOP:
        await session.convo?.end("caller_hung_up");
        liveCalls.delete(session.callSid);
        return;
    }
  });

  // Some carriers send raw binary media rather than base64-in-JSON.
  conn.on("binary", async (buf) => { if (session.convo) await session.convo.pushAudio(decodeInbound(buf)); });

  conn.on("disconnected", async () => {
    await session.convo?.end("stream_closed");
    liveCalls.delete(session.callSid);
    console.log(`[media] closed ${session.callSid ?? "(no sid)"}`);
  });

  conn.on("error", (e) => console.error(`[media] ${e.message}`));
});

/** Read-only live feed for the console. Never carries audio. */
function attachMonitor(conn) {
  const forward = (e) => conn.sendJson(e);
  monitor.on("event", forward);
  conn.sendJson({ type: "hello", live: liveCalls.size, providers: {
    stt: providers.stt?.name ?? null, tts: providers.tts?.name ?? null, llm: providers.llm?.name ?? null,
  }});
  conn.on("disconnected", () => monitor.off("event", forward));
}

// ---------------------------------------------------------------------------

function authed(req, url) {
  if (!SECRET) return true; // unset = local dev; the banner warns about this
  return verifySharedSecret(url.searchParams.get("secret") ?? req.headers["x-exotel-secret"], SECRET).valid;
}

function json(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b), "access-control-allow-origin": "*" });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function parseForm(raw) {
  if (!raw) return {};
  if (raw.trim().startsWith("{")) { try { return JSON.parse(raw); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}

server.listen(PORT, async () => {
  const slugs = await listBusinesses().catch(() => []);
  const ok = (b) => (b ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m");
  console.log(`\n  \x1b[1mReceptionFlow voice gateway\x1b[0m  :${PORT}\n`);
  console.log(
    envFile.loaded
      ? `  .env loaded — ${envFile.applied.length} value(s) applied${envFile.skipped.length ? `, ${envFile.skipped.length} already set in the environment` : ""}`
      : `  no .env file — reading the environment only  (cp .env.example .env)`
  );
  console.log(`  ${ok(providers.stt)} STT   ${providers.stt?.name ?? "not configured"}`);
  console.log(`  ${ok(providers.tts)} TTS   ${providers.tts?.name ?? "not configured"}`);
  console.log(`  ${ok(providers.llm)} LLM   ${providers.llm?.name ?? "not configured"}`);
  console.log(`  ${ok(exotel)} Exotel REST ${exotel ? "configured" : "not configured (Connect applet still works)"}`);
  console.log(`  ${ok(SECRET)} Auth  ${SECRET ? "on" : "OFF — set EXOTEL_WEBHOOK_SECRET before exposing publicly"}`);
  console.log(`  ${ok(true)} Audio ${MULAW ? "G.711 µ-law" : "linear PCM"} @ ${SAMPLE_RATE}Hz  (TELEPHONY_ENCODING=${ENCODING})`);
  console.log(`\n  Businesses: ${slugs.join(", ") || "(none)"}`);
  console.log(`  Voicebot WS: wss://<your-host>/media?business=<slug>`);
  for (const w of providers.warnings) console.log(`  \x1b[33m! ${w}\x1b[0m`);
  console.log("");
});
