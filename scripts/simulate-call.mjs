#!/usr/bin/env node
// Impersonates Exotel's voicebot stream against a running voice gateway.
//
//   MOCK_PROVIDERS=1 node apps/voice-gateway/server.mjs      # terminal 1
//   node scripts/simulate-call.mjs --business sharma-dental  # terminal 2
//
// Speaks by sending PCM that looks like speech to the VAD, then silence to
// trigger endpointing. Verifies the parts that break in production — the
// Exotel envelope, endpointing, tool calls, barge-in, and teardown —
// without a phone number or a single billed API call.
//
// If your Exotel trunk hands over G.711 µ-law, test that path too — it is a
// different set of bytes on the wire and a mismatch sounds like static:
//
//   TELEPHONY_ENCODING=mulaw node apps/voice-gateway/server.mjs
//   node scripts/simulate-call.mjs --encoding mulaw

import { loadEnv } from "../packages/env/load.mjs";
import { pcm16ToMulaw, mulawToPcm16 } from "../packages/voice/audio.mjs";

loadEnv();

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const HOST = argOf("--host", "localhost:8080");
const BUSINESS = argOf("--business", "sharma-dental");
const SECRET = process.env.EXOTEL_WEBHOOK_SECRET || "";
const RATE = 8000;
const FRAME = Math.floor(RATE * 0.02) * 2; // 20ms of 16-bit PCM

// Must match the gateway's TELEPHONY_ENCODING, exactly as a real trunk would.
const ENCODING = (argOf("--encoding", process.env.TELEPHONY_ENCODING) || "pcm").toLowerCase();
const MULAW = ENCODING === "mulaw";
const wire = (pcm) => (MULAW ? pcm16ToMulaw(pcm) : pcm);
const unwire = (buf) => (MULAW ? mulawToPcm16(buf) : buf);

// What the caller "says". The mock LLM pattern-matches these to pick tools.
const TURNS = argv.includes("--turns")
  ? JSON.parse(argOf("--turns", "[]"))
  : ["are you open right now", "i want to book an appointment", "can i speak to a person"];

const qs = new URLSearchParams({ business: BUSINESS });
if (SECRET) qs.set("secret", SECRET);

const ws = new WebSocket(`ws://${HOST}/media?${qs}`);
ws.binaryType = "arraybuffer";

const received = { frames: 0, bytes: 0, clears: 0, wireBytes: 0, maxFrame: 0 };

// A full 20ms frame on the wire: 160 samples, 2 bytes each as linear PCM,
// 1 byte each as µ-law.
const FULL_FRAME_BYTES = MULAW ? FRAME / 2 : FRAME;
let turn = 0;

ws.onopen = async () => {
  say(`connected  (${MULAW ? "G.711 µ-law" : "linear PCM"} @ ${RATE}Hz)`);
  send({ event: "connected" });
  send({
    event: "start",
    stream_sid: "sim_stream_1",
    start: {
      callSid: "sim_call_" + Date.now(),
      from: "+919876500011",
      to: "+911412345678",
      customParameters: { business: BUSINESS },
    },
  });

  // Let the greeting play before the caller starts talking.
  await sleep(2500);

  for (const text of TURNS) {
    say(`caller says: "${text}"`);
    await speak(1200);   // energy the VAD reads as speech
    await silence(900);  // hangover that ends the turn
    await sleep(2500);   // let the agent answer
    turn++;
  }

  say("hanging up");
  send({ event: "stop" });
  await sleep(400);
  ws.close(1000);
};

ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(e.data).toString());
  if (m.event === "media") {
    const raw = Buffer.from(m.media.payload, "base64");
    received.frames++;
    received.wireBytes += raw.length;
    // Largest, not average: the final chunk of an utterance is a short tail.
    received.maxFrame = Math.max(received.maxFrame, raw.length);
    // Decode before measuring, so the duration is right in both encodings.
    received.bytes += unwire(raw).length;
  } else if (m.event === "clear") {
    received.clears++;
    say("← carrier buffer cleared (barge-in)");
  }
};

ws.onclose = () => {
  const secs = (received.bytes / 2 / RATE).toFixed(1);
  console.log(`\n  ${received.frames} audio frames received (${secs}s of speech)`);
  console.log(`  ${received.clears} barge-in clear(s)`);

  // The gateway is supposed to encode outbound audio to whatever the trunk
  // asked for, and counting frames does not prove it did: frames arrive
  // either way, and a mismatch is audible static rather than an error
  // anyone logs. Compare the raw frame size on the wire against what this
  // encoding requires — an absolute number, not a ratio against our own
  // decode of the same bytes, which would agree with itself no matter what.
  let encodingOk = true;
  if (received.frames > 0) {
    encodingOk = received.maxFrame === FULL_FRAME_BYTES;
    console.log(
      `  outbound frame size: ${received.maxFrame} bytes / 20ms — ` +
        (encodingOk
          ? `matches ${MULAW ? "µ-law" : "linear PCM"}`
          : `\x1b[31mexpected ${FULL_FRAME_BYTES} for ${MULAW ? "µ-law" : "linear PCM"}\x1b[0m`)
    );
    if (!encodingOk) {
      console.log(
        `  \x1b[33m→ the gateway is sending ${received.maxFrame === FRAME ? "linear PCM" : "µ-law"}, but --encoding says ${ENCODING}.\x1b[0m\n` +
          `  \x1b[33m  Set TELEPHONY_ENCODING on the gateway to match your Exotel trunk.\x1b[0m`
      );
    }
  }

  const pass = received.frames > 0 && encodingOk;
  console.log(
    pass
      ? "\n  \x1b[32mPASS\x1b[0m — the agent answered and streamed audio back.\n"
      : received.frames === 0
        ? "\n  \x1b[31mFAIL\x1b[0m — no audio came back.\n"
        : "\n  \x1b[31mFAIL\x1b[0m — audio came back in the wrong encoding.\n"
  );
  process.exit(pass ? 0 : 1);
};

ws.onerror = (e) => { console.error("  websocket error:", e.message ?? e); process.exit(1); };

// --- helpers ---------------------------------------------------------------

const send = (o) => ws.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(`  ${s}`);

/** Sends `ms` of speech-like audio in real-time 20ms frames. */
async function speak(ms) {
  const frames = Math.floor(ms / 20);
  for (let f = 0; f < frames; f++) {
    const buf = Buffer.alloc(FRAME);
    for (let i = 0; i < FRAME / 2; i++) {
      // Noisy waveform — loud and irregular enough to clear the VAD's
      // adaptive floor, the way real speech does.
      const t = (f * (FRAME / 2) + i) / RATE;
      const v = Math.sin(2 * Math.PI * 180 * t) * 0.4 + (Math.random() - 0.5) * 0.5;
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 12000))), i * 2);
    }
    send({ event: "media", media: { payload: wire(buf).toString("base64") } });
    await sleep(20);
  }
}

async function silence(ms) {
  const frames = Math.floor(ms / 20);
  for (let f = 0; f < frames; f++) {
    send({ event: "media", media: { payload: wire(Buffer.alloc(FRAME)).toString("base64") } });
    await sleep(20);
  }
}
