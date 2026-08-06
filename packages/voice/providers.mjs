// Pluggable speech + language providers.
//
// Every provider implements one of three tiny interfaces:
//   STT: transcribe(pcm, { sampleRate, languages }) -> { text, language }
//   TTS: synthesize(text, { language, voice })      -> { pcm, sampleRate }
//   LLM: chat({ messages, tools })                  -> { text, toolCalls }
//
// Provider choice matters more in India than elsewhere. Callers code-switch
// Hindi/English mid-sentence, and models trained mostly on US English
// transcribe "do sau rupaye" as noise. Sarvam and Bhashini are trained on
// Indic speech specifically; Deepgram and OpenAI are decent multilingual
// fallbacks. Default order below reflects that.
//
// VERIFY AGAINST LIVE PROVIDER DOCS: request/response shapes are written to
// each provider's commonly documented API, but no account exists in this
// repo to test against. Endpoints and field names drift — check before you
// go live. What will not drift is the interface above, which is what the
// conversation engine depends on.

import { pcmToWav, wavToPcm, resamplePcm16 } from "./audio.mjs";

const TIMEOUT_MS = 15000;

async function post(url, { headers = {}, body, timeout = TIMEOUT_MS, raw = false }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
    }
    return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
  } finally {
    clearTimeout(t);
  }
}

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (v instanceof Blob) fd.append(k, v, "audio.wav");
    else fd.append(k, String(v));
  }
  return fd;
}

// ===========================================================================
// Speech to text
// ===========================================================================

/**
 * Sarvam AI — Indian provider, strongest option for Indic speech and
 * Hindi/English code-switching. `saarika` is their ASR family.
 */
export function sarvamSTT({ apiKey, model = "saarika:v2", baseUrl = "https://api.sarvam.ai" }) {
  return {
    name: "sarvam-stt",
    async transcribe(pcm, { sampleRate = 8000, languages = ["hi", "en"] } = {}) {
      const wav = pcmToWav(resamplePcm16(pcm, sampleRate, 16000), 16000);
      const json = await post(`${baseUrl}/speech-to-text`, {
        headers: { "api-subscription-key": apiKey },
        body: form({
          file: new Blob([wav], { type: "audio/wav" }),
          model,
          // "unknown" lets Sarvam auto-detect, which is what we want for a
          // caller who might open in either language.
          language_code: languages.length > 1 ? "unknown" : langTag(languages[0]),
        }),
      });
      return { text: (json.transcript ?? "").trim(), language: json.language_code ?? null };
    },
  };
}

/** Deepgram — good multilingual fallback, fast, handles telephony audio natively. */
export function deepgramSTT({ apiKey, model = "nova-2", baseUrl = "https://api.deepgram.com" }) {
  return {
    name: "deepgram-stt",
    async transcribe(pcm, { sampleRate = 8000, languages = ["hi", "en"] } = {}) {
      const q = new URLSearchParams({
        model,
        encoding: "linear16",
        sample_rate: String(sampleRate),
        channels: "1",
        smart_format: "true",
        // "multi" is what makes mid-sentence Hindi/English switching work.
        language: languages.length > 1 ? "multi" : languages[0],
      });
      const json = await post(`${baseUrl}/v1/listen?${q}`, {
        headers: { Authorization: `Token ${apiKey}`, "content-type": "audio/l16" },
        body: pcm,
      });
      const alt = json.results?.channels?.[0]?.alternatives?.[0];
      return { text: (alt?.transcript ?? "").trim(), language: json.results?.channels?.[0]?.detected_language ?? null };
    },
  };
}

/** OpenAI Whisper — universal fallback. Slower, but works with one key. */
export function openaiSTT({ apiKey, model = "whisper-1", baseUrl = "https://api.openai.com/v1" }) {
  return {
    name: "openai-stt",
    async transcribe(pcm, { sampleRate = 8000 } = {}) {
      const wav = pcmToWav(resamplePcm16(pcm, sampleRate, 16000), 16000);
      const json = await post(`${baseUrl}/audio/transcriptions`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form({ file: new Blob([wav], { type: "audio/wav" }), model }),
      });
      return { text: (json.text ?? "").trim(), language: json.language ?? null };
    },
  };
}

// ===========================================================================
// Text to speech
// ===========================================================================

/**
 * Sarvam TTS (`bulbul`) — Indian voices that pronounce Indian names, places,
 * and rupee amounts correctly. A US-trained voice reading "Malviya Nagar"
 * or "Chhattisgarh" is instantly wrong to a local caller, which is why this
 * is the default rather than a fallback.
 */
export function sarvamTTS({ apiKey, model = "bulbul:v2", speaker = "anushka", baseUrl = "https://api.sarvam.ai" }) {
  return {
    name: "sarvam-tts",
    async synthesize(text, { language = "hi", sampleRate = 8000 } = {}) {
      const json = await post(`${baseUrl}/text-to-speech`, {
        headers: { "api-subscription-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          inputs: [text],
          target_language_code: langTag(language),
          speaker,
          model,
          speech_sample_rate: 8000,
          enable_preprocessing: true, // normalizes numbers/dates into spoken Indic forms
        }),
      });
      const b64 = Array.isArray(json.audios) ? json.audios[0] : json.audio;
      if (!b64) throw new Error("sarvam-tts returned no audio");
      const pcm = wavToPcm(Buffer.from(b64, "base64"));
      return { pcm: resamplePcm16(pcm, 8000, sampleRate), sampleRate };
    },
  };
}

/** ElevenLabs — very natural, supports Hindi. Higher latency and cost. */
export function elevenLabsTTS({ apiKey, voiceId, model = "eleven_turbo_v2_5", baseUrl = "https://api.elevenlabs.io/v1" }) {
  return {
    name: "elevenlabs-tts",
    async synthesize(text, { sampleRate = 8000 } = {}) {
      // pcm_8000 avoids a resample and matches telephony exactly.
      const buf = await post(`${baseUrl}/text-to-speech/${voiceId}?output_format=pcm_8000`, {
        headers: { "xi-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
        raw: true,
      });
      return { pcm: resamplePcm16(buf, 8000, sampleRate), sampleRate };
    },
  };
}

/** OpenAI TTS — one-key fallback. Indian-language pronunciation is weaker. */
export function openaiTTS({ apiKey, model = "tts-1", voice = "nova", baseUrl = "https://api.openai.com/v1" }) {
  return {
    name: "openai-tts",
    async synthesize(text, { sampleRate = 8000 } = {}) {
      const buf = await post(`${baseUrl}/audio/speech`, {
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, voice, input: text, response_format: "pcm" }),
        raw: true,
      });
      // OpenAI PCM comes back at 24kHz.
      return { pcm: resamplePcm16(buf, 24000, sampleRate), sampleRate };
    },
  };
}

// ===========================================================================
// LLM
// ===========================================================================

/** OpenAI chat completions with tool calling. */
export function openaiLLM({ apiKey, model = "gpt-4o-mini", baseUrl = "https://api.openai.com/v1", temperature = 0.3 }) {
  return {
    name: `openai-${model}`,
    async chat({ messages, tools = [] }) {
      const body = { model, temperature, messages, max_tokens: 300 };
      if (tools.length) {
        body.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = "auto";
      }
      const json = await post(`${baseUrl}/chat/completions`, {
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const m = json.choices?.[0]?.message ?? {};
      return {
        text: (m.content ?? "").trim(),
        toolCalls: (m.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function?.name,
          arguments: safeParse(c.function?.arguments),
        })),
        raw: m,
      };
    },
  };
}

/** Anthropic messages API with tool use. */
export function anthropicLLM({ apiKey, model = "claude-sonnet-4-5", baseUrl = "https://api.anthropic.com/v1", temperature = 0.3 }) {
  return {
    name: `anthropic-${model}`,
    async chat({ messages, tools = [] }) {
      // Anthropic takes the system prompt as a top-level field, not a message.
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const convo = messages.filter((m) => m.role !== "system").map(toAnthropicMessage);

      const body = { model, system, messages: convo, max_tokens: 400, temperature };
      if (tools.length) {
        body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      }
      const json = await post(`${baseUrl}/messages`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const blocks = json.content ?? [];
      return {
        text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim(),
        toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} })),
        raw: json,
      };
    },
  };
}

function toAnthropicMessage(m) {
  if (m.role === "tool") {
    return { role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }] };
  }
  if (m.role === "assistant" && m.tool_calls?.length) {
    const content = [];
    if (m.content) content.push({ type: "text", text: m.content });
    for (const c of m.tool_calls) {
      content.push({ type: "tool_use", id: c.id, name: c.function.name, input: safeParse(c.function.arguments) });
    }
    return { role: "assistant", content };
  }
  return { role: m.role, content: m.content };
}

// ===========================================================================
// Mock providers
// ===========================================================================
//
// Let the whole call path run with no API keys and no spend. Not a toy:
// this is how you test endpointing, barge-in, tool calling, and the Exotel
// envelope — the parts that actually break — without a single billed
// request. Enable with MOCK_PROVIDERS=1.

export function mockSTT({ script = [] } = {}) {
  let i = 0;
  return {
    name: "mock-stt",
    async transcribe() {
      await sleep(120);
      const text = script[i % script.length] ?? "Hello";
      i++;
      return { text, language: "en-IN" };
    },
  };
}

export function mockTTS() {
  return {
    name: "mock-tts",
    async synthesize(text, { sampleRate = 8000 } = {}) {
      await sleep(80);
      // ~60ms of audio per word, as a quiet tone so playback pacing,
      // chunking, and barge-in cancellation are all exercised for real.
      const ms = Math.max(400, text.split(/\s+/).length * 60);
      const samples = Math.floor((sampleRate * ms) / 1000);
      const pcm = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i++) {
        pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 1200), i * 2);
      }
      return { pcm, sampleRate };
    },
  };
}

/**
 * Deterministic stand-in for an LLM. Pattern-matches the caller's words to
 * decide whether to answer or call a tool, so tool plumbing is exercised
 * end to end without a model.
 */
export function mockLLM() {
  return {
    name: "mock-llm",
    async chat({ messages, tools = [] }) {
      await sleep(150);
      const last = [...messages].reverse().find((m) => m.role === "user")?.content?.toLowerCase() ?? "";
      const has = (n) => tools.some((t) => t.name === n);
      const justRan = messages[messages.length - 1]?.role === "tool";

      if (justRan) {
        const result = safeParse(messages[messages.length - 1].content);
        return { text: result.say ?? "All done.", toolCalls: [] };
      }
      if (has("check_hours") && /open|close|timing|khul|band|time/.test(last)) {
        return { text: "", toolCalls: [{ id: "t1", name: "check_hours", arguments: {} }] };
      }
      if (has("transfer_call") && /human|person|manager|owner|doctor|baat kar/.test(last)) {
        return { text: "", toolCalls: [{ id: "t2", name: "transfer_call", arguments: { reason: "caller asked for a person" } }] };
      }
      if (has("capture_lead") && /call ?back|appointment|book|number|details/.test(last)) {
        return { text: "", toolCalls: [{ id: "t3", name: "capture_lead", arguments: { name: "Test Caller", phone: "9876543210", reason: last.slice(0, 60) || "enquiry" } }] };
      }
      return { text: "Sure — I can help with that. What would you like to know?", toolCalls: [] };
    },
  };
}

// ===========================================================================
// Assembly from environment
// ===========================================================================

/**
 * Builds the provider set from env, preferring Indian providers.
 * Returns { stt, tts, llm, warnings } — never throws, so the server can
 * boot, report clearly what's missing, and still serve the console.
 */
export function providersFromEnv(env = process.env) {
  const warnings = [];
  let stt = null, tts = null, llm = null;

  if (env.MOCK_PROVIDERS === "1" || env.MOCK_PROVIDERS === "true") {
    return {
      stt: mockSTT({ script: safeParse(env.MOCK_SCRIPT) ?? undefined }),
      tts: mockTTS(),
      llm: mockLLM(),
      warnings: ["MOCK_PROVIDERS is on — no real speech or model calls are being made."],
      ready: true,
      mock: true,
    };
  }

  if (env.SARVAM_API_KEY) stt = sarvamSTT({ apiKey: env.SARVAM_API_KEY });
  else if (env.DEEPGRAM_API_KEY) stt = deepgramSTT({ apiKey: env.DEEPGRAM_API_KEY });
  else if (env.OPENAI_API_KEY) stt = openaiSTT({ apiKey: env.OPENAI_API_KEY });
  else warnings.push("No STT provider — set SARVAM_API_KEY (best for Indic), DEEPGRAM_API_KEY, or OPENAI_API_KEY.");

  if (env.SARVAM_API_KEY) tts = sarvamTTS({ apiKey: env.SARVAM_API_KEY, speaker: env.SARVAM_SPEAKER || "anushka" });
  else if (env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID) tts = elevenLabsTTS({ apiKey: env.ELEVENLABS_API_KEY, voiceId: env.ELEVENLABS_VOICE_ID });
  else if (env.OPENAI_API_KEY) tts = openaiTTS({ apiKey: env.OPENAI_API_KEY });
  else warnings.push("No TTS provider — set SARVAM_API_KEY (best for Indic), ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, or OPENAI_API_KEY.");

  if (env.OPENAI_API_KEY) llm = openaiLLM({ apiKey: env.OPENAI_API_KEY, model: env.LLM_MODEL || "gpt-4o-mini" });
  else if (env.ANTHROPIC_API_KEY) llm = anthropicLLM({ apiKey: env.ANTHROPIC_API_KEY, model: env.LLM_MODEL || "claude-sonnet-4-5" });
  else warnings.push("No LLM provider — set OPENAI_API_KEY or ANTHROPIC_API_KEY.");

  return { stt, tts, llm, warnings, ready: Boolean(stt && tts && llm) };
}

// --- helpers ---------------------------------------------------------------

/** Sarvam and Bhashini want BCP-47-ish tags like "hi-IN". */
function langTag(code) {
  if (!code) return "hi-IN";
  if (code.includes("-")) return code;
  return `${code}-IN`;
}

function safeParse(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(v ?? "{}"); } catch { return {}; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
