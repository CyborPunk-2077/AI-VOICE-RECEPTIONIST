# Quickstart — from clone to talking agent

Two tracks. Track A needs nothing but Node and takes about a minute. Track B
puts the agent on a real phone line.

---

## Track A — see it working (1 minute, no accounts)

```bash
node scripts/doctor.mjs                   # is this clone healthy?
node scripts/build-agent.mjs --check      # validate every business config
node apps/agent-server/server.mjs         # start the console
```

Open http://localhost:3100. You can:

- switch between businesses and watch the whole agent change
- run `check_hours`, `capture_lead`, `transfer_call` and see exactly what the
  agent would say
- read and copy the generated system prompt
- see captured leads accumulate

No npm install. No API keys. No database.

### Add a business

```bash
cp businesses/_TEMPLATE.json businesses/verma-electronics.json
# edit it — name, hours, offerings, FAQs, transfer number
node scripts/build-agent.mjs verma-electronics
```

That's the entire onboarding process. There is no step two, and no code to
change. `--check` will tell you if anything's wrong or thin.

---

## Track B — put it on a phone

### 1. Generate the assistant

```bash
node scripts/build-agent.mjs sharma-dental -o
```

Writes `build/sharma-dental/`:

| File | What to do with it |
|---|---|
| `system-prompt.md` | paste into the assistant's system prompt |
| `vapi-assistant.json` | full assistant object — paste or POST to the API |
| `tools.json` | provider-neutral tool defs, if you're not using Vapi |

### 2. Expose the agent server

Vapi has to reach your tool webhook, so localhost won't do:

Put the secret in `.env` at the repo root — the server reads it from there,
and unlike `export` it works the same on Windows:

```
AGENT_SERVER_SECRET=<32+ random characters>
```

```bash
node apps/agent-server/server.mjs

ngrok http 3100        # in another terminal
```

Tool URL for this business:

```
https://<your-ngrok>.ngrok.io/api/tools?business=sharma-dental
```

The `?business=` is how the server knows which business a call belongs to.
It comes from the URL you configure — never from anything the model says —
so one business's agent can't act as another's. **Give every business its
own tool URL.**

Set the same `AGENT_SERVER_SECRET` as a header (`x-agent-secret`) in Vapi's
tool config. Without it the server accepts unauthenticated tool calls, which
is fine on localhost and not fine once ngrok is pointing at it.

### 3. Create the assistant in Vapi

Paste the prompt, set the tool URLs, pick a voice. Two settings worth care
for Indian callers:

- **Transcriber**: Deepgram Nova-2 with `language: "multi"`. Callers switch
  between Hindi and English inside one sentence; a monolingual model mangles
  it.
- **Voice**: audition several. This changes how the agent lands more than any
  prompt tweak. A voice that sounds wrong for the region undoes good writing.

### 4. Test in the browser first

Console → **Voice test** tab → paste your Vapi **public** key and assistant
ID → Start call. Talk to it. Try to break it: ask about a service that
doesn't exist, mumble a phone number, demand a human, switch to Hindi
mid-sentence.

Fix the business JSON, re-run `build-agent.mjs`, update the prompt, repeat.
**Do all your tuning here** — it's free and instant.

### 5. Get it onto a number

Read `docs/india-telephony.md` first. Short version: an Indian number cannot
attach to Vapi directly, for regulatory reasons.

For a supervised prototype on your friend's phone, use a foreign number plus
conditional forwarding:

```
**61*<the-vapi-number>#     forward when unanswered
##002#                       cancel all forwarding
```

Your friend is billed at ISD rates for every forwarded call, so treat this
as a demo, not a deployment. The compliant path is an Indian carrier
(Exotel vSIP) — see the doc.

---

## Where things live

```
businesses/          one JSON per business — the only file you edit per client
packages/agent-core/ prompt builder, tools, validation (no provider imports)
packages/env/        .env loader — nothing else in the repo reads .env
scripts/             build-agent.mjs — JSON to deployable agent
                     doctor.mjs — what's configured and what isn't
apps/agent-server/   tool webhooks + test console
data/                leads.jsonl, calls.jsonl (prototype storage)
```

## When to graduate off this

The prototype stack is files: `data/*.jsonl` for leads, JSON for config.
Deliberately so — it removes every setup step between you and a demo.

Move to the Supabase + n8n + dashboard stack already in this repo when you
hit any of:

- more than a handful of businesses to keep straight
- the owner wants to see leads without you sending them
- you need real appointment booking against a calendar
- two people are editing configs

The migrations in `supabase/migrations/` and the workflows in
`n8n/workflows/` are that path, already built. `packages/agent-core/store.mjs`
is a two-method interface specifically so swapping the file store for
Supabase is a one-file change.

## Troubleshooting

**Agent invents prices or services.** Something's missing from the business
JSON — it only knows what's in there. Add the offering or an FAQ. If it
should refuse, add a line to `policies.neverDiscuss`.

**Agent gives the wrong opening status.** Check `profile.timezone` is
`Asia/Kolkata` and that `hours` uses 24-hour `"HH:MM"`. Verify with the
`check_hours` button — it uses the same code path as a real call.

**Phone numbers rejected.** `normalizeIndianPhone` only accepts Indian
mobiles (10 digits starting 6-9, with or without +91/0). It returns null
rather than storing a wrong number, and the agent re-asks. For non-Indian
numbers, change `profile.timezone` away from `Asia/Kolkata`.

**Tool calls 401.** `AGENT_SERVER_SECRET` is set on the server but the
`x-agent-secret` header isn't set in Vapi, or they don't match.

**Nothing in the leads list.** Leads are per-business; check you're looking
at the same business the tool call used (`?business=` in the tool URL).
