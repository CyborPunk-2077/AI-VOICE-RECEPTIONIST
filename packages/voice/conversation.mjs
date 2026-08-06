// The conversation engine: one instance per live call.
//
// Owns the loop that makes a voice agent feel like a person rather than an
// IVR: listen -> detect end of turn -> transcribe -> think -> speak, with
// the caller able to cut in at any moment.
//
// Transport-agnostic. It receives PCM and emits PCM plus events; it knows
// nothing about Exotel, WebSockets, or HTTP. That's what lets the same
// engine serve a real phone call and the browser test console.
//
// The three things that decide whether callers find this tolerable:
//
//   1. Endpointing — deciding they've finished speaking. Too eager and you
//      interrupt them mid-thought; too slow and the call feels dead. Handled
//      by the VAD's silence hangover.
//   2. Barge-in — when they talk over the agent, the agent must stop
//      immediately. Nothing makes a bot feel more robotic than monologuing
//      through an interruption.
//   3. Filler on slow turns — a tool call plus an LLM round-trip can take a
//      couple of seconds, and silence on a phone line reads as a dropped
//      call. We say something short first.

import { EventEmitter } from "node:events";
import { VoiceActivityDetector, durationMs, chunkBuffer } from "./audio.mjs";
import { buildSystemPrompt, buildGreeting, toolDefinitions, runTool } from "../agent-core/index.mjs";

const FILLERS = [
  "One moment.",
  "Let me check that.",
  "Just a second.",
];

export class Conversation extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.config      business config from agent-core
   * @param {object} o.providers   { stt, tts, llm }
   * @param {object} o.store       lead/call store
   * @param {number} o.sampleRate  telephony sample rate (usually 8000)
   */
  constructor({ config, providers, store, sampleRate = 8000, callId = null, callerNumber = null, maxTurns = 40 }) {
    super();
    this.config = config;
    this.providers = providers;
    this.store = store;
    this.sampleRate = sampleRate;
    this.callId = callId;
    this.callerNumber = callerNumber;
    this.maxTurns = maxTurns;

    this.vad = new VoiceActivityDetector({ sampleRate });
    this.messages = [{ role: "system", content: buildSystemPrompt(config) }];
    this.transcript = [];
    this.tools = toolDefinitions(config);

    this.buffer = [];        // PCM captured for the current utterance
    this.speaking = false;   // agent is currently talking
    this.thinking = false;   // a turn is being processed
    this.ended = false;
    this.turns = 0;
    this._speechToken = 0;   // bumped to cancel in-flight playback
    this.startedAt = Date.now();
  }

  /** Speak the greeting. Call once when the call connects. */
  async start() {
    const greeting = buildGreeting(this.config);
    this.messages.push({ role: "assistant", content: greeting });
    this._record("agent", greeting);
    this.emit("transcript", { role: "agent", text: greeting });
    await this._speak(greeting);
    this.emit("ready");
  }

  /**
   * Feed inbound caller audio. Safe to call with any chunk size.
   * This is the hot path — it must stay cheap and never block on the network.
   */
  async pushAudio(pcm) {
    if (this.ended) return;

    const { speechStarted, speechEnded } = this.vad.push(pcm);

    // Barge-in: the caller started talking while the agent was speaking.
    // Cut the agent off immediately and start capturing.
    if (speechStarted && this.speaking) {
      this._cancelSpeech();
      this.emit("barge-in");
    }

    if (this.vad.speaking || speechStarted) this.buffer.push(pcm);

    if (speechEnded) {
      const utterance = Buffer.concat(this.buffer);
      this.buffer = [];
      // Guard against the VAD firing on a cough or a line pop.
      if (durationMs(utterance, this.sampleRate) >= 300) {
        await this._handleTurn(utterance);
      }
    }
  }

  async _handleTurn(pcm) {
    if (this.thinking || this.ended) return;
    this.thinking = true;
    const t0 = Date.now();

    try {
      const { text, language } = await this.providers.stt.transcribe(pcm, {
        sampleRate: this.sampleRate,
        languages: this.config.profile.languages ?? ["hi", "en"],
      });

      if (!text) { this.thinking = false; return; } // silence or noise
      this._record("caller", text);
      this.emit("transcript", { role: "caller", text, language, ms: Date.now() - t0 });

      this.messages.push({ role: "user", content: text });

      if (++this.turns > this.maxTurns) {
        await this._say("I'm sorry, I'm having trouble helping over the phone. Let me have someone call you back.");
        return this.end("max_turns");
      }

      await this._think();
    } catch (err) {
      this._fail(err);
      // Never let an API failure produce dead air.
      await this._say("Sorry, I didn't catch that. Could you say it once more?");
    } finally {
      this.thinking = false;
    }
  }

  /** One LLM turn, following tool calls until the model produces speech. */
  async _think(depth = 0) {
    if (depth > 3) {
      return this._say("Let me take your details and have someone call you back about that.");
    }

    const reply = await this.providers.llm.chat({ messages: this.messages, tools: this.tools });

    if (reply.toolCalls?.length) {
      // Tool round-trips are slow enough to be audible. Say something first.
      const filler = FILLERS[Math.floor(Math.random() * FILLERS.length)];
      const fillerPromise = this._speak(filler);

      this.messages.push({
        role: "assistant",
        content: reply.text || null,
        tool_calls: reply.toolCalls.map((c) => ({
          id: c.id, type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      });

      for (const call of reply.toolCalls) {
        const result = await runTool(call.name, call.arguments, {
          config: this.config, store: this.store,
          callId: this.callId, callerNumber: this.callerNumber,
        });
        this.emit("tool", { name: call.name, arguments: call.arguments, result });
        this.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });

        if (call.name === "transfer_call" && result.transfer) {
          await fillerPromise;
          await this._say(result.say);
          this.emit("transfer", { destination: result.destination, reason: result.reason });
          return this.end("transferred");
        }
      }

      await fillerPromise;
      return this._think(depth + 1);
    }

    if (reply.text) await this._say(reply.text);
  }

  async _say(text) {
    if (!text || this.ended) return;
    this.messages.push({ role: "assistant", content: text });
    this._record("agent", text);
    this.emit("transcript", { role: "agent", text });
    await this._speak(text);
  }

  /**
   * Synthesize and emit audio in small chunks.
   *
   * Chunking matters for two reasons: carriers expect a steady frame size
   * rather than one huge write, and it gives barge-in a place to take
   * effect — we check the cancellation token between chunks, so an
   * interrupted agent goes quiet within ~20ms instead of finishing the
   * sentence.
   */
  async _speak(text) {
    const token = ++this._speechToken;
    this.speaking = true;
    try {
      const { pcm } = await this.providers.tts.synthesize(text, {
        language: (this.config.profile.languages ?? ["hi"])[0],
        sampleRate: this.sampleRate,
      });
      if (token !== this._speechToken || this.ended) return; // cancelled while synthesizing

      const frame = Math.floor(this.sampleRate * 0.02) * 2; // 20ms
      for (const chunk of chunkBuffer(pcm, frame)) {
        if (token !== this._speechToken || this.ended) return;
        this.emit("audio", chunk);
        // Pace playback to real time so we don't flood the carrier's jitter
        // buffer, which would make barge-in impossible.
        await sleep(20);
      }
    } catch (err) {
      this._fail(err);
    } finally {
      if (token === this._speechToken) this.speaking = false;
    }
  }

  _cancelSpeech() {
    this._speechToken++;
    this.speaking = false;
    this.emit("audio-cancel");
  }

  _record(role, text) {
    this.transcript.push({ role, text, at: new Date().toISOString() });
  }

  /**
   * Node's EventEmitter *throws* an "error" event that has no listener.
   * On a live call that would turn a recoverable STT hiccup into a crashed
   * process and a dropped caller, so we never emit it unguarded.
   */
  _fail(err) {
    if (this.listenerCount("error") > 0) this.emit("error", err);
    else console.error(`[conversation] ${err?.message ?? err}`);
  }

  /** Ends the call and writes the log. Idempotent. */
  async end(reason = "completed") {
    if (this.ended) return;
    this.ended = true;
    this._cancelSpeech();

    const entry = {
      business: this.config.slug,
      call_id: this.callId,
      caller_number: this.callerNumber,
      reason,
      turns: this.turns,
      duration_seconds: Math.round((Date.now() - this.startedAt) / 1000),
      transcript: this.transcript,
      at: new Date().toISOString(),
    };
    try { await this.store.logCall(entry); } catch { /* logging must never break a call */ }

    this.emit("ended", entry);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
