# ReceptionFlow

An AI phone receptionist you can put on any small business, built for
Indian businesses. Callers ask about hours, services, and prices; the agent
answers from that business's own approved information, takes callback
details, and hands off to a human when it should.

Onboarding a new business is **one JSON file**. No code changes.

```bash
node apps/agent-server/server.mjs      # → http://localhost:3100
```

No npm install, no API keys, no database. You'll be talking to a working
agent in about a minute. Start with
[`docs/prototype-quickstart.md`](docs/prototype-quickstart.md).

There are npm scripts too, if you'd rather not remember paths:

```bash
npm run console          # the test console, same as above
npm test                 # validate configs + 80 tests, no install needed
npm run doctor           # what's configured, what isn't, what to do about it
```

## Adding a business

```bash
cp businesses/_TEMPLATE.json businesses/verma-electronics.json
# fill in name, hours, offerings, FAQs, transfer number
node scripts/build-agent.mjs verma-electronics -o
```

That writes a ready-to-paste system prompt and assistant config. The two
example businesses — a dental clinic and a gym — are deliberately different
shapes, because nothing in the agent is clinic- or appointment-specific.

## Taking real calls on an Indian number

```bash
# no API keys, no phone, full call path
npm run gateway:mock                              # terminal 1
npm run simulate -- --business sharma-dental      # terminal 2
```

Then, before you dial anything real:

```bash
cp .env.example .env     # fill in Sarvam + OpenAI + Exotel
npm run doctor -- --live # says exactly what's still missing
```

The live path is **Exotel → your gateway → Sarvam/OpenAI → back**:

```
caller's phone
   ↓  Indian PSTN
Exotel ExoPhone          UL-VNO licensed, native Airtel/Jio/Vi/BSNL
   ↓  WebSocket, audio both ways
your voice gateway       runs on an Indian VM
   ├── STT   Sarvam      Indic speech, Hindi/English code-switching
   ├── LLM   OpenAI / Anthropic
   └── TTS   Sarvam      Indian voices and pronunciation
   ↓  only when escalating
Exotel Connect → the owner's mobile
```

**Vapi is not in this path, and can't be.** TRAI requires call signalling and
audio to originate inside India; Vapi runs in the US. That's regulatory, not
technical. Full runbook: [`docs/exotel-setup.md`](docs/exotel-setup.md).
Background and alternatives: [`docs/india-telephony.md`](docs/india-telephony.md).

Built in: barge-in (callers can interrupt), adaptive VAD endpointing tuned
for noisy Indian lines, Hindi/English code-switching, µ-law and linear PCM,
IST-aware opening hours, ₹ spoken as rupees, and phone numbers normalized
from the six shapes speech-to-text produces.

## Layout

```
businesses/            one JSON per business — the only per-client file
packages/agent-core/   prompt builder, tools, validation (provider-neutral)
packages/voice/        audio, STT/LLM/TTS providers, conversation engine
packages/telephony/    Exotel adapter
packages/ws/           zero-dep WebSocket server
packages/env/          .env loader (zero-dep; nothing else reads .env)
apps/voice-gateway/    answers real calls  ← the India path
apps/agent-server/     console + tool webhooks
scripts/               build-agent.mjs, simulate-call.mjs, doctor.mjs
data/                  leads.jsonl, calls.jsonl (gitignored — real caller data)

apps/dashboard/        Next.js dashboard  ─┐
supabase/migrations/   Postgres schema     ├─ optional production stack
n8n/workflows/         9 orchestration WFs ─┘
```

Nothing in `agent-core` imports a provider, so swapping Exotel for Plivo or
Ozonetel means one new adapter, not a rewrite.

## Stack

- **Agent core + voice pipeline** — plain ESM, zero dependencies
- **Telephony** — Exotel (India-compliant); adapter-swappable
- **Speech** — Sarvam (Indic), Deepgram / ElevenLabs / OpenAI fallbacks
- **Dashboard** — Next.js, TypeScript, Tailwind
- **Database** — Supabase (Postgres), optional

## Docs

- [`docs/going-live-simple.md`](docs/going-live-simple.md) — plain-language: what the phone part costs, and what you must do by hand
- [`docs/prototype-quickstart.md`](docs/prototype-quickstart.md) — start here
- [`docs/exotel-setup.md`](docs/exotel-setup.md) — go live on an Indian number
- [`docs/india-telephony.md`](docs/india-telephony.md) — why the architecture is shaped this way
- [`docs/requirements.md`](docs/requirements.md) — scope
- [`docs/architecture.md`](docs/architecture.md) — system design
- [`docs/database.md`](docs/database.md) — Supabase schema and setup
- [`docs/n8n-setup.md`](docs/n8n-setup.md) — workflows and the Vapi gateway
- [`docs/voice-agent.md`](docs/voice-agent.md) — prompt and tool design notes
- [`docs/todo.md`](docs/todo.md) — roadmap

## Status

Prototype stage. The agent core, config system, generator, and test console
work end to end today. The production stack (Supabase + n8n + dashboard +
authenticated gateway) is built but not wired to any live account — no Vapi,
Exotel, Twilio, or Google accounts exist in this repo, and all credentials
are placeholders.
