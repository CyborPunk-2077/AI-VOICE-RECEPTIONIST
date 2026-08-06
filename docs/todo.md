# Todo / Roadmap

Status as of the current build. This file used to be a phased plan for a
single salon where nothing was started. Most of it has since been built, and
the project's shape changed — multi-business, India-first, Exotel rather than
Vapi on the call path. Rewritten to match what's actually true.

To check your own clone at any time:

```bash
npm run doctor              # is this clone healthy?
npm run doctor -- --live    # what does a real call still need?
```

## Done

**Agent core** — provider-neutral prompt builder, tools, config validation.
Zero dependencies. `businesses/*.json` is the entire onboarding surface, and
`build-agent.mjs` turns one into a system prompt and assistant config.
33 tests.

**Voice pipeline** — STT/LLM/TTS adapters (Sarvam, Deepgram, ElevenLabs,
OpenAI, Anthropic, plus mocks), adaptive VAD endpointing, barge-in, µ-law and
linear PCM, IST-aware hours, rupees spoken as words. 31 tests.

**Exotel path** — voicebot stream handling, Passthru and Connect applets,
shared-secret auth on every endpoint, and `simulate-call.mjs`, which
exercises the whole call path with no phone and no API keys.

**Production stack (built, not connected)** — Next.js dashboard, Supabase
schema `0001`–`0003`, 9 n8n workflows, authenticated Vapi→n8n gateway.

## Blocked on accounts

None of these are code tasks. Each needs an account that does not exist yet.

- [ ] **Exotel** — business KYC, an ExoPhone, and a support request to enable
      Voicebot / media streaming. This is the long pole; start it first.
      Ask them whether your trunk hands over linear PCM or G.711 µ-law and
      set `TELEPHONY_ENCODING` to match. Guessing wrong is loud static, not
      an error, and nothing logs it.
- [ ] **An Indian VM** with a public HTTPS/WSS endpoint (`ap-south-1` or
      equivalent). TRAI requires the media path to originate in India.
- [ ] **Sarvam** API key (STT and TTS in one), plus **OpenAI** or
      **Anthropic** for the model.
- [ ] **Supabase** — only if you want the dashboard. Run migrations
      `0001`–`0003`, then `seed.sql`.
- [ ] **n8n** — only if you want the production orchestration stack.

Runbook for all of the above: [`exotel-setup.md`](exotel-setup.md).

## Real gaps, in rough priority order

- [ ] **The dashboard reads a different data source than the agent writes.**
      The prototype writes JSONL to `data/`; the dashboard reads Supabase.
      Nothing bridges the two, so a call taken by the prototype never shows
      up in the dashboard. Either implement `store.mjs` against Supabase
      (the interface is 2 methods) or write a `data/*.jsonl` importer.
- [ ] **The dashboard is single-business.** The agent core went
      multi-business; the dashboard still assumes one, with the name coming
      from `NEXT_PUBLIC_BUSINESS_NAME`. Fine for one client, wrong for the
      second.
- [ ] **No auth on the dashboard.** `docs/database.md` assumes a single
      owner and RLS that denies writes to the anon key — which is not the
      same as requiring a login to read. Add Supabase Auth before this holds
      anyone's real caller data.
- [ ] **No appointment booking in the prototype stack.** `agent-core`
      captures callbacks; booking exists only as n8n workflows against
      Supabase. A caller on the Exotel path cannot actually book.
- [ ] **No concurrency guard on booking.** Two callers asking for the same
      slot simultaneously is untested, and the double-booking check lives in
      an n8n workflow rather than a database constraint.
- [ ] **Call recording and consent.** Nothing records audio today. If that
      changes, disclosure at the start of the call is required — and it
      belongs in the greeting, in the business JSON, not in code.

## Nice to have

- [ ] Metrics: per-turn latency split across STT/LLM/TTS, barge-in rate, tool
      error rate. Latency is what callers actually notice, and it is
      currently unmeasured.
- [ ] FAQ-miss analytics. What callers asked that the business JSON could not
      answer is the single most valuable thing to show an owner.
- [ ] A second telephony adapter (Plivo or Ozonetel) to prove the seam in
      `packages/telephony/` is real.
- [ ] Per-business rate limiting on the tool webhooks.
- [ ] Demo recording and screenshots for the README.
