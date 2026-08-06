// Tests for the audio and telephony layers — the places where a bug is
// silent (garbled audio, a VAD that never fires) rather than a clean crash.
//
//   node --test packages/voice/voice.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  resamplePcm16, pcmToWav, wavToPcm, rms, VoiceActivityDetector,
  mulawToPcm16, pcm16ToMulaw, chunkBuffer, silence, durationMs,
} from "./audio.mjs";
import {
  parseStreamEvent, mediaFrame, clearFrame, verifySharedSecret,
  normalizeExotelNumber, connectToNumber, appFlowPlan,
} from "../telephony/exotel.mjs";
import { mockSTT, mockTTS, mockLLM, providersFromEnv } from "./providers.mjs";
import { Conversation } from "./conversation.mjs";
import { loadBusiness, createMemoryStore } from "../agent-core/index.mjs";

/** Synthesizes a tone, as a stand-in for speech energy. */
function tone(ms, rate = 8000, amp = 8000) {
  const n = Math.floor((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / rate) * amp), i * 2);
  return b;
}

// --- audio -----------------------------------------------------------------

test("resamplePcm16: 8k->16k doubles the sample count", () => {
  const out = resamplePcm16(tone(100), 8000, 16000);
  assert.equal(out.length, tone(100).length * 2);
});

test("resamplePcm16: same rate is a passthrough, empty stays empty", () => {
  const t = tone(10);
  assert.equal(resamplePcm16(t, 8000, 8000), t);
  assert.equal(resamplePcm16(Buffer.alloc(0), 8000, 16000).length, 0);
});

test("resamplePcm16: round-trip preserves duration", () => {
  const up = resamplePcm16(tone(200), 8000, 16000);
  const down = resamplePcm16(up, 16000, 8000);
  assert.ok(Math.abs(durationMs(down, 8000) - 200) < 2);
});

test("pcmToWav/wavToPcm: header is well-formed and round-trips", () => {
  const pcm = tone(50);
  const wav = pcmToWav(pcm, 16000);
  assert.equal(wav.length, pcm.length + 44);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16000);       // sample rate
  assert.equal(wav.readUInt16LE(22), 1);           // mono
  assert.equal(wav.readUInt16LE(34), 16);          // bit depth
  assert.deepEqual(wavToPcm(wav), pcm);
});

test("wavToPcm: leaves headerless PCM alone", () => {
  const pcm = tone(20);
  assert.deepEqual(wavToPcm(pcm), pcm);
});

test("rms: silence is zero, tone is not", () => {
  assert.equal(rms(Buffer.alloc(1600)), 0);
  assert.ok(rms(tone(100)) > 0.1);
});

test("VAD: detects speech onset then end-of-turn after silence", () => {
  const vad = new VoiceActivityDetector({ sampleRate: 8000, silenceMs: 300 });
  const started = vad.push(tone(500));
  assert.equal(started.speechStarted, true);
  assert.equal(started.speechEnded, false);
  const ended = vad.push(silence(600));
  assert.equal(ended.speechEnded, true);
});

test("VAD: ignores a blip too short to be speech", () => {
  const vad = new VoiceActivityDetector({ sampleRate: 8000, minSpeechMs: 250 });
  assert.equal(vad.push(tone(60)).speechStarted, false);
});

test("VAD: does not fire on pure silence", () => {
  const vad = new VoiceActivityDetector({ sampleRate: 8000 });
  const r = vad.push(silence(2000));
  assert.equal(r.speechStarted, false);
  assert.equal(r.speechEnded, false);
});

test("VAD: adapts to a noisy line instead of treating hiss as speech", () => {
  const vad = new VoiceActivityDetector({ sampleRate: 8000 });
  const noise = Buffer.alloc(8000 * 2);
  for (let i = 0; i < 8000; i++) noise.writeInt16LE(Math.round((Math.random() - 0.5) * 900), i * 2);
  vad.push(noise);           // let the floor rise
  vad.push(noise);
  assert.equal(vad.push(noise).speechStarted, false, "steady line noise must not read as speech");
  assert.equal(vad.push(tone(400, 8000, 15000)).speechStarted, true, "real speech must still break through");
});

test("mulaw: round-trips within quantization error", () => {
  const pcm = tone(50, 8000, 8000);
  const back = mulawToPcm16(pcm16ToMulaw(pcm));
  assert.equal(back.length, pcm.length);
  let worst = 0;
  for (let i = 0; i < pcm.length / 2; i++) {
    worst = Math.max(worst, Math.abs(pcm.readInt16LE(i * 2) - back.readInt16LE(i * 2)));
  }
  assert.ok(worst < 600, `µ-law error too high: ${worst}`);
});

test("chunkBuffer: splits into frames, last one may be short", () => {
  const chunks = chunkBuffer(Buffer.alloc(1000), 320);
  assert.equal(chunks.length, 4);
  assert.equal(chunks[3].length, 40);
});

// --- exotel envelope -------------------------------------------------------

test("parseStreamEvent: reads a start event and its custom parameters", () => {
  const ev = parseStreamEvent({
    event: "start", stream_sid: "s1",
    start: { callSid: "c1", from: "09876543210", to: "01412345678", customParameters: { business: "sharma-dental" } },
  });
  assert.equal(ev.event, "start");
  assert.equal(ev.callSid, "c1");
  assert.equal(ev.streamSid, "s1");
  assert.equal(ev.business, "sharma-dental");
});

test("parseStreamEvent: decodes base64 media", () => {
  const pcm = tone(20);
  const ev = parseStreamEvent({ event: "media", media: { payload: pcm.toString("base64") } });
  assert.equal(ev.event, "media");
  assert.deepEqual(ev.payload, pcm);
});

test("parseStreamEvent: accepts a JSON string and tolerates junk", () => {
  assert.equal(parseStreamEvent('{"event":"stop"}').event, "stop");
  assert.equal(parseStreamEvent({}).event, "");
  assert.equal(parseStreamEvent(null).payload, null);
});

test("parseStreamEvent: finds fields under alternate names", () => {
  // Providers rename things between versions; the parser must cope.
  const ev = parseStreamEvent({ type: "media", payload: tone(10).toString("base64"), callSid: "x1" });
  assert.equal(ev.event, "media");
  assert.equal(ev.callSid, "x1");
  assert.ok(ev.payload.length > 0);
});

test("mediaFrame / clearFrame: correct outbound shapes", () => {
  const f = mediaFrame(tone(20), "s1");
  assert.equal(f.event, "media");
  assert.equal(f.stream_sid, "s1");
  assert.deepEqual(Buffer.from(f.media.payload, "base64"), tone(20));
  assert.equal(clearFrame("s1").event, "clear");
});

test("verifySharedSecret: accepts a match, rejects everything else", () => {
  assert.equal(verifySharedSecret("abc123", "abc123").valid, true);
  assert.equal(verifySharedSecret("wrong!", "abc123").valid, false);
  assert.equal(verifySharedSecret("short", "abc123").valid, false);   // length mismatch
  assert.equal(verifySharedSecret(null, "abc123").valid, false);
  assert.equal(verifySharedSecret("abc123", null).valid, false);      // unconfigured fails closed
});

test("normalizeExotelNumber: handles the formats Exotel reports", () => {
  assert.equal(normalizeExotelNumber("09876543210"), "+919876543210");
  assert.equal(normalizeExotelNumber("9876543210"), "+919876543210");
  assert.equal(normalizeExotelNumber("919876543210"), "+919876543210");
  assert.equal(normalizeExotelNumber("+91 98765 43210"), "+919876543210");
  assert.equal(normalizeExotelNumber(""), null);
});

test("connectToNumber / appFlowPlan: produce usable setup output", () => {
  const c = connectToNumber("+919876543210", { callerId: "+911412345678" });
  assert.equal(c.destination.numbers[0], "+919876543210");
  const plan = appFlowPlan({ business: "x", publicBaseUrl: "https://a.in", transferNumber: "+911" });
  assert.equal(plan.applets.length, 3);
  assert.match(plan.applets[1].url, /^wss:\/\/a\.in\/media\?business=x$/);
});

// --- providers -------------------------------------------------------------

test("providersFromEnv: fails closed with no keys, reports why", () => {
  const p = providersFromEnv({});
  assert.equal(p.ready, false);
  assert.equal(p.warnings.length, 3);
});

test("providersFromEnv: prefers Sarvam for Indic when available", () => {
  const p = providersFromEnv({ SARVAM_API_KEY: "k", OPENAI_API_KEY: "o" });
  assert.equal(p.stt.name, "sarvam-stt");
  assert.equal(p.tts.name, "sarvam-tts");
  assert.equal(p.ready, true);
});

test("providersFromEnv: falls back when Sarvam is absent", () => {
  const p = providersFromEnv({ DEEPGRAM_API_KEY: "d", OPENAI_API_KEY: "o" });
  assert.equal(p.stt.name, "deepgram-stt");
  assert.equal(p.tts.name, "openai-tts");
});

test("providersFromEnv: MOCK_PROVIDERS gives a complete working set", () => {
  const p = providersFromEnv({ MOCK_PROVIDERS: "1" });
  assert.equal(p.ready, true);
  assert.equal(p.mock, true);
});

// --- conversation ----------------------------------------------------------

async function convoFixture(script) {
  const { config } = await loadBusiness("sharma-dental");
  const store = createMemoryStore();
  const convo = new Conversation({
    config, store, sampleRate: 8000, callId: "t1", callerNumber: "+919876500011",
    providers: { stt: mockSTT({ script }), tts: mockTTS(), llm: mockLLM() },
  });
  return { convo, store, config };
}

test("Conversation: greets on start and emits audio", async () => {
  const { convo } = await convoFixture(["hi"]);
  const audio = [];
  convo.on("audio", (c) => audio.push(c));
  await convo.start();
  assert.match(convo.transcript[0].text, /Sharma Dental Care/);
  assert.ok(audio.length > 0, "greeting produced no audio");
  await convo.end();
});

test("Conversation: a caller turn runs a tool and answers", async () => {
  const { convo } = await convoFixture(["are you open right now"]);
  const tools = [];
  convo.on("tool", (t) => tools.push(t.name));
  await convo.start();
  await convo.pushAudio(tone(600));
  await convo.pushAudio(silence(900));
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(tools, ["check_hours"]);
  assert.ok(convo.transcript.some((t) => t.role === "caller"));
  await convo.end();
});

test("Conversation: capture_lead persists a normalized lead", async () => {
  const { convo, store } = await convoFixture(["i want a callback about an appointment"]);
  await convo.start();
  await convo.pushAudio(tone(600));
  await convo.pushAudio(silence(900));
  await new Promise((r) => setTimeout(r, 700));
  const leads = await store.listLeads("sharma-dental");
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone, "+919876543210");
  assert.equal(leads[0].call_id, "t1");
  await convo.end();
});

test("Conversation: barge-in cancels playback immediately", async () => {
  const { convo } = await convoFixture(["hello"]);
  let cancelled = false;
  convo.on("audio-cancel", () => { cancelled = true; });
  const speaking = convo._speak("This is a long sentence the caller will interrupt partway through.");
  await new Promise((r) => setTimeout(r, 60));
  await convo.pushAudio(tone(400));   // caller cuts in
  await speaking;
  assert.equal(cancelled, true, "barge-in did not cancel playback");
  await convo.end();
});

test("Conversation: ignores a blip too short to be a real utterance", async () => {
  const { convo } = await convoFixture(["should not be reached"]);
  await convo.start();
  const before = convo.transcript.length;
  await convo.pushAudio(tone(50));
  await convo.pushAudio(silence(900));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(convo.transcript.length, before);
  await convo.end();
});

test("Conversation: end() logs the call once and is idempotent", async () => {
  const { convo, store } = await convoFixture(["hi"]);
  await convo.start();
  await convo.end("caller_hung_up");
  await convo.end("caller_hung_up");
  const calls = await store.listCalls("sharma-dental");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, "caller_hung_up");
  assert.ok(calls[0].transcript.length > 0);
});

test("Conversation: an STT failure never produces dead air", async () => {
  const { config } = await loadBusiness("sharma-dental");
  const convo = new Conversation({
    config, store: createMemoryStore(), sampleRate: 8000,
    providers: {
      stt: { name: "boom", transcribe: async () => { throw new Error("stt down"); } },
      tts: mockTTS(), llm: mockLLM(),
    },
  });
  const said = [];
  convo.on("transcript", (t) => { if (t.role === "agent") said.push(t.text); });
  await convo.start();
  await convo.pushAudio(tone(600));
  await convo.pushAudio(silence(900));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(said.some((s) => /say it once more|didn't catch/i.test(s)), "no recovery prompt after STT failure");
  await convo.end();
});
