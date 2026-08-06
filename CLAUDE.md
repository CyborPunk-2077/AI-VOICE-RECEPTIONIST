# CLAUDE.md

Guidance for Claude when working in this repo.

## What this is

ReceptionFlow — an AI phone receptionist template for small businesses,
aimed at the Indian market. A caller phones a business; the agent answers
from that business's approved information, captures callbacks, and escalates
to a human. The goal is that onboarding a new business is editing **one JSON
file**, not writing code.

## Two stacks, know which one you're in

**Prototype stack (default — this is what runs today):**

```
businesses/*.json      one file per business, the whole onboarding surface
packages/agent-core/   prompt builder + tools + validation, zero deps
packages/env/          .env loader — the only thing that reads .env
scripts/build-agent.mjs  JSON → system prompt + assistant config
scripts/doctor.mjs     what's configured, what isn't, what to do about it
apps/agent-server/     tool webhooks + browser test console
data/*.jsonl           leads and call logs
```

Plain ESM, **zero dependencies**, runs on bare Node 18+. This is
intentional: no install step means no barrier between a clone and a working
demo. Don't add dependencies here without a real reason.

**Production stack (built, not live):**

```
apps/dashboard/        Next.js + Supabase dashboard, and the authenticated
                       Vapi→n8n gateway at src/app/api/vapi/*
supabase/migrations/   Postgres schema (0001–0003)
n8n/workflows/         9 orchestration workflows, Header Auth on every webhook
```

No external accounts exist — Vapi, Exotel, Twilio, Supabase, Google are all
placeholders. Don't assume any are configured.

## The constraint that shapes everything

**Indian phone numbers cannot attach to Vapi directly.** TRAI requires SIP
signalling and RTP media to originate inside India; Vapi runs in the US.
Regulatory, not technical.

Therefore: `packages/agent-core` must **never import anything
provider-specific**. Vapi lives in exactly two adapter spots —
`buildVapiAssistant()` in `scripts/build-agent.mjs`, and the webhook parser
in `apps/agent-server/server.mjs`. Keep it that way; swapping to Exotel or
Plivo should mean writing a third adapter, not touching agent logic.

See `docs/india-telephony.md` before doing anything telephony-related.

## Ground rules

- **The agent only says what's in the business JSON.** Never let it improvise
  prices, availability, policies, staff names, or medical/health claims. When
  it doesn't know, the correct behaviour is a callback, never a guess.
- **Trust boundary:** which business a call belongs to comes from
  configuration you control (the `?business=` tool URL, or `vapi_business_map`
  in the production stack) — never from the request body or anything the LLM
  can say. Same for caller number and call ID.
- **Prompts are generated, never hand-edited.** Change
  `packages/agent-core/prompt.mjs` or the business JSON, then re-run
  `build-agent.mjs`. Anything in `build/` is disposable output.
- **Write for voice, not chat.** No markdown, bullets, or emoji in agent
  output. Times as "6 PM" not "18:00", money as "1,200 rupees" not "₹1200",
  phone numbers digit by digit.
- **India defaults:** IST, INR, +91, Hindi/English code-switching. The core
  isn't India-only, but it defaults that way.
- Keep secrets out of the repo. `.env*` is gitignored. `AGENT_SERVER_SECRET`
  must be set before the agent server is exposed publicly.
- **Windows is a first-class dev environment.** Never write
  `FOO=1 node ...` in an npm script or a doc command — it's a syntax error
  in cmd.exe and PowerShell. Add a CLI flag instead, the way `--mock` shadows
  `MOCK_PROVIDERS=1`.
- **Placeholders are not values.** `packages/env/load.mjs` refuses to apply
  anything matching `YOUR_*`, `GENERATE_A_*`, or `REPLACE_WITH_*`, so a
  half-filled `.env` shows a red dot at boot instead of failing mid-call
  against a provider. Keep that property if you touch the loader.

## Before changing things

- Adding a business → copy `businesses/_TEMPLATE.json`, nothing else.
- Changing agent behaviour for everyone → `packages/agent-core/prompt.mjs`.
- Changing what a tool does → `packages/agent-core/tools.mjs`.
- New storage backend → implement the `store.mjs` interface (2 methods).

Run `node scripts/build-agent.mjs --check` after touching configs or
validation, and boot `apps/agent-server/server.mjs` to smoke-test tools.

## Style

- Prototype code: plain `.mjs`, zero deps, comments explaining *why*.
- Dashboard code: server components + Supabase, TypeScript strict.
- Keep n8n workflows and assistant configs as version-controlled JSON, not
  UI-only state.
