// Telephony audio utilities: resampling, WAV wrapping, energy VAD, µ-law.
//
// Phone audio is 8kHz mono 16-bit PCM. Speech APIs mostly want 16kHz WAV.
// Almost every bug in a voice agent that manifests as "the STT returns
// garbage" is actually a sample-rate or endianness mismatch here, so this
// is kept explicit and separately testable rather than inlined.

/** Bytes per second of 16-bit mono PCM at a given rate. */
export const bytesPerSecond = (rate) => rate * 2;

/** Duration in ms of a 16-bit mono PCM buffer. */
export const durationMs = (buf, rate) => (buf.length / 2 / rate) * 1000;

/**
 * Linear resampler for 16-bit mono PCM.
 *
 * Linear interpolation is not the highest-quality method, but for the
 * 8k->16k upsample telephony needs it is inaudible to an STT model and
 * costs almost nothing. Do not use this for music.
 */
export function resamplePcm16(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const inSamples = Math.floor(input.length / 2);
  if (inSamples === 0) return Buffer.alloc(0);

  const ratio = toRate / fromRate;
  const outSamples = Math.floor(inSamples * ratio);
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = src - i0;
    const s0 = input.readInt16LE(i0 * 2);
    const s1 = input.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

/** Wraps raw PCM in a 44-byte WAV header. Most STT HTTP APIs want this. */
export function pcmToWav(pcm, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Strips a WAV header if present, returning raw PCM. */
export function wavToPcm(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
    off += 8 + size + (size % 2);
  }
  return buf.subarray(44);
}

/** Root-mean-square amplitude, 0..1. The basis of the VAD below. */
export function rms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/**
 * Energy-based voice activity detector with an adaptive noise floor.
 *
 * Why adaptive: Indian phone lines vary enormously — a caller on a busy
 * street, a landline with mains hum, and a good 4G VoLTE call have wildly
 * different noise floors. A fixed threshold either clips quiet speakers or
 * never triggers on noisy lines. This tracks the ambient level during
 * silence and requires speech to exceed it by a margin.
 *
 * Energy VAD is intentionally simple. It cannot tell speech from a barking
 * dog. It's here to decide "has the caller stopped talking" — endpointing —
 * not to transcribe. Upgrade to a neural VAD (Silero) if false triggers
 * become a real problem in the field.
 */
export class VoiceActivityDetector {
  constructor({
    sampleRate = 8000,
    frameMs = 20,
    silenceMs = 700,      // hangover before we call the turn finished
    minSpeechMs = 250,    // ignore coughs, clicks, line pops
    startMargin = 2.5,    // speech must be this many x the noise floor
    floorMin = 0.006,
  } = {}) {
    this.sampleRate = sampleRate;
    this.frameBytes = Math.floor((sampleRate * (frameMs / 1000))) * 2;
    this.silenceFrames = Math.ceil(silenceMs / frameMs);
    this.minSpeechFrames = Math.ceil(minSpeechMs / frameMs);
    this.startMargin = startMargin;
    this.floorMin = floorMin;

    this.noiseFloor = floorMin;
    this.speaking = false;
    this.speechFrames = 0;
    this.silentFrames = 0;
    this._tail = Buffer.alloc(0);
  }

  /**
   * Feed audio; returns events observed in this chunk.
   * @returns {{ speechStarted: boolean, speechEnded: boolean, level: number }}
   */
  push(chunk) {
    let buf = this._tail.length ? Buffer.concat([this._tail, chunk]) : chunk;
    let speechStarted = false, speechEnded = false, level = 0;

    let off = 0;
    for (; off + this.frameBytes <= buf.length; off += this.frameBytes) {
      const frame = buf.subarray(off, off + this.frameBytes);
      const e = rms(frame);
      level = Math.max(level, e);

      const isSpeech = e > Math.max(this.noiseFloor * this.startMargin, this.floorMin);

      if (isSpeech) {
        this.speechFrames++;
        this.silentFrames = 0;
        if (!this.speaking && this.speechFrames >= this.minSpeechFrames) {
          this.speaking = true;
          speechStarted = true;
        }
      } else {
        // Adapt the floor only while quiet, so we track the room and not
        // the caller's voice.
        this.noiseFloor = this.noiseFloor * 0.95 + e * 0.05;
        if (this.speaking) {
          this.silentFrames++;
          if (this.silentFrames >= this.silenceFrames) {
            this.speaking = false;
            this.speechFrames = 0;
            this.silentFrames = 0;
            speechEnded = true;
          }
        } else {
          this.speechFrames = 0;
        }
      }
    }

    this._tail = buf.subarray(off);
    return { speechStarted, speechEnded, level };
  }

  reset() {
    this.speaking = false;
    this.speechFrames = 0;
    this.silentFrames = 0;
    this._tail = Buffer.alloc(0);
  }
}

// --- G.711 µ-law -----------------------------------------------------------
// Some Indian carriers hand over µ-law rather than linear PCM. Cheap to
// support, painful to debug if you assume wrong (it sounds like loud static).

const MULAW_BIAS = 0x84;

export function mulawToPcm16(mulaw) {
  const out = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    let u = ~mulaw[i] & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    out.writeInt16LE(sign ? -sample : sample, i * 2);
  }
  return out;
}

export function pcm16ToMulaw(pcm) {
  const n = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    let s = pcm.readInt16LE(i * 2);
    const sign = s < 0 ? 0x80 : 0;
    if (s < 0) s = -s;
    if (s > 32635) s = 32635;
    s += MULAW_BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/** Splits a buffer into fixed-size chunks — carriers want steady frame sizes. */
export function chunkBuffer(buf, size) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, Math.min(i + size, buf.length)));
  return out;
}

/** Silence of a given duration, for padding and comfort noise. */
export const silence = (ms, rate = 8000) => Buffer.alloc(Math.floor((rate * ms) / 1000) * 2);
