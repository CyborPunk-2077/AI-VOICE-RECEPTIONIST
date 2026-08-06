# Putting the agent on a real Indian number

End-to-end runbook: from nothing to a caller dialling an Indian mobile and
talking to your agent.

Budget roughly a week, most of which is waiting on Exotel provisioning.
Start that conversation first — everything else can be done while you wait.

## Why this shape

TRAI requires that domestic Indian call signalling and media originate from
infrastructure inside India, under an Indian licence. So:

```
caller's phone
   ↓  (Indian PSTN)
Exotel ExoPhone            ← UL-VNO licensed, native Airtel/Jio/Vi/BSNL
   ↓  (WebSocket, audio both ways)
your voice gateway         ← runs on an Indian VM (Mumbai/Delhi)
   ├── STT   Sarvam        ← Indic speech, handles Hindi/English mixing
   ├── LLM   OpenAI/Anthropic
   └── TTS   Sarvam        ← Indian voices and pronunciation
   ↓  (only when escalating)
Exotel Connect → the owner's mobile
```

Vapi is not in this path. It cannot lawfully be — see
[`india-telephony.md`](india-telephony.md).

Your gateway must run **inside India**. The STT/LLM/TTS calls it makes are
ordinary outbound HTTPS and are not part of the regulated call path, so
those providers can be anywhere.

## 1. Exotel account and number

1. Sign up at exotel.com — you'll need business KYC (GST or equivalent).
2. Buy an **ExoPhone** (a virtual Indian number).
3. Email **hello@exotel.com** and ask them to enable **Voicebot / media
   streaming** on your account. This is not self-serve, and it's the long
   pole — ask on day one.
4. From **API Settings**, note your API Key, API Token, Account SID, and
   subdomain.

## 2. A server inside India

Any Indian-region VM works — AWS `ap-south-1`, Azure Central India, DigitalOcean
Bangalore, Hetzner doesn't have an Indian region so skip it. 2 vCPU / 4GB is
plenty for a handful of concurrent calls.

You need a public HTTPS/WSS endpoint. Exotel will not connect to a bare IP or
a self-signed certificate. Caddy is the least painful way:

```
your.domain.in {
  reverse_proxy localhost:8080
}
```

For a first test you can use an ngrok tunnel, but latency to a foreign ngrok
edge is noticeable on a voice call — don't judge the agent's speed on it.

## 3. Keys

```bash
cp .env.example .env
```

Fill in, at minimum:

| Variable | Why |
|---|---|
| `SARVAM_API_KEY` | STT + TTS. Best Indic quality; one key covers both. |
| `OPENAI_API_KEY` | The LLM. Or `ANTHROPIC_API_KEY`. |
| `EXOTEL_WEBHOOK_SECRET` | Generate it yourself. Without it anyone who finds your URL can drive your agent. |
| `EXOTEL_API_KEY` / `_TOKEN` / `_ACCOUNT_SID` | Only needed for REST-initiated transfers. |
| `TELEPHONY_ENCODING` | `pcm` or `mulaw` — whichever your trunk hands over. Ask Exotel; see step 5. |

`.env` is read from the repo root by both servers. Two things worth knowing:

- A variable already set in your actual environment always wins, so Docker
  and systemd deployments behave the way you'd expect.
- Placeholders left over from `.env.example` (`YOUR_...`,
  `GENERATE_A_...`) are treated as **unset** rather than passed through.
  You get a red dot at boot instead of a call that dies halfway through
  because Sarvam was sent the literal string `YOUR_SARVAM_API_KEY`.

If you'd rather not spend anything yet, `--mock` runs the whole call path
with no API keys at all.

Then check what's still missing:

```bash
npm run doctor -- --live
```

## 4. Start the gateway

```bash
node apps/voice-gateway/server.mjs
# or, with no keys and no spend:
node apps/voice-gateway/server.mjs --mock
```

```
  ReceptionFlow voice gateway  :8080

  ● STT   sarvam-stt
  ● TTS   sarvam-tts
  ● LLM   openai-gpt-4o-mini
  ● Exotel REST configured
  ● Auth  on
  ● Audio linear PCM @ 8000Hz  (TELEPHONY_ENCODING=pcm)
```

Any red dot means that piece isn't configured. `GET /health` says the same
thing in JSON.

## 5. Build the Exotel App flow

In Exotel: **App Bazaar → Create App**, then add applets in this order.

**Applet 1 — Passthru** (optional but recommended)

```
https://your.domain.in/exotel/incoming?business=sharma-dental&secret=YOUR_SECRET
```

Logs the call before the bot answers, and gives you a place to reject
blocked numbers later.

**Applet 2 — Voicebot** (the one that matters)

```
wss://your.domain.in/media?business=sharma-dental&secret=YOUR_SECRET
```

Audio format: **8kHz, 16-bit, mono PCM**. If Exotel gives you a G.711 µ-law
option instead, set `TELEPHONY_ENCODING=mulaw` and restart the gateway.

Confirm which one your account is actually on rather than guessing. A
mismatch is not silence and does not raise an error anywhere — it is
continuous loud static in both directions, because µ-law silence is `0xFF`
bytes, which read as a full-scale square wave if you interpret them as
linear PCM. The VAD then hears constant speech and endpointing never fires.

Verify it without dialling:

```bash
node apps/voice-gateway/server.mjs --mock
node scripts/simulate-call.mjs --encoding mulaw
```

`simulate-call.mjs` checks the frame size on the wire (160 bytes per 20ms
for µ-law, 320 for linear PCM) and fails loudly if the two sides disagree.

**Applet 3 — Connect** (only if the business transfers calls)

Point it at the number in that business's `escalation.transferNumber`, or
have it call:

```
https://your.domain.in/exotel/transfer?business=sharma-dental&secret=YOUR_SECRET
```

which returns the right number from the business JSON, so you never maintain
it in two places.

Finally: **Assign this App to your ExoPhone.**

The `?business=` parameter is how the gateway knows whose agent to run. It
comes from this configuration, never from the caller or the model — that's
what keeps one business's agent from ever answering as another's. **Give
every business its own ExoPhone and its own App.**

## 6. Test before you dial

```bash
# terminal 1
node apps/voice-gateway/server.mjs --mock

# terminal 2
node scripts/simulate-call.mjs --business sharma-dental
```

(`--mock` rather than `MOCK_PROVIDERS=1 node ...`, because the inline form
is a syntax error in cmd.exe and PowerShell.)

This impersonates Exotel's stream: connects, sends `start`, streams speech-like
audio, triggers endpointing, and hangs up. You should see the conversation in
terminal 1 and `PASS` in terminal 2.

It exercises the Exotel envelope, endpointing, tool calls, barge-in, and
teardown — everything except the carrier itself.

## 7. Dial it

Call your ExoPhone from any Indian mobile. Watch the gateway log, or open the
console's **Live calls** tab for a live transcript.

Try to break it, in this order:

1. Ask something answerable — "what time do you close?"
2. Ask something it shouldn't know — "do you do teeth whitening?" It should
   offer a callback, not invent an answer.
3. Interrupt it mid-sentence. It should stop immediately.
4. Switch to Hindi halfway through a sentence.
5. Ask for a human.
6. Say a phone number fast and mumbled. It should read it back.

Every failure here is fixed in the business JSON, not in code.

## Tuning

**It talks over me.** Barge-in relies on the `clear` frame reaching the
carrier. Confirm Exotel supports `clear` on your account; if not, reduce
`silenceMs` in the VAD so turns end sooner.

**It cuts me off mid-sentence.** Raise `silenceMs` (in
`packages/voice/audio.mjs`, `VoiceActivityDetector`) from 700ms to ~900ms.
Indian callers often pause mid-thought while composing an English sentence.

**Long silence before it answers.** That's STT + LLM + TTS serially. Use a
smaller model (`LLM_MODEL=gpt-4o-mini`), keep the business JSON tight, and
make sure the VM is in India — a foreign VM adds a round-trip on every
single frame.

**Hindi comes out wrong.** Check you're on Sarvam rather than the OpenAI
fallback. Try other `SARVAM_SPEAKER` voices; they differ a lot.

**It mishears numbers.** Expected on a bad line, which is why the agent
reads numbers back. Don't remove that instruction from the prompt.

## Cost, roughly

| | |
|---|---|
| ExoPhone rental | a few hundred ₹/month |
| Inbound minutes | well under ₹1/min |
| Indian VM | ₹800–2,000/month |
| STT + TTS + LLM | the bulk of per-minute cost; a few ₹/min |

Get exact numbers from each vendor before quoting a client — these move.

## Going live properly

- **Recording consent** — if you record, say so in the greeting. Put it in
  `agent.greeting` in the business JSON.
- **Inbound only.** Outbound calling in India means DLT registration and DND
  scrubbing. Don't repurpose this for campaigns without reading up first.
- **Set `EXOTEL_WEBHOOK_SECRET`.** Unset, the gateway accepts any caller.
- **Watch the first week of calls.** Read the transcripts in
  `data/calls.jsonl`. Every wrong answer is a missing FAQ or a missing
  `neverDiscuss` line — the fix is always the JSON.
