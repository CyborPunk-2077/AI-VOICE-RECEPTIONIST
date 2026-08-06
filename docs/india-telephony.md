# Getting an AI agent onto an Indian phone number

Read this before you promise anyone a live number. The constraint below is
regulatory, not technical, so no amount of clever engineering removes it.

## The constraint

**You cannot attach an Indian phone number to Vapi directly.**

TRAI rules require that for domestic Indian calls, both the SIP signalling
and the RTP audio originate from telecom infrastructure physically inside
India, operated under an Indian licence (UL / UL-VNO). Vapi's media servers
run in the US. Attempts to place or receive Indian PSTN calls through Vapi
typically fail outright (403-class errors), and where they appear to work,
they are not compliant.

This is not a Vapi-specific limitation — it applies to any foreign-hosted
voice platform. It's also why several international voice AI vendors
quietly don't sell into India.

What this means practically: **the voice platform and the telephony carrier
are two separate decisions in India**, and the carrier has to be Indian.

## The four paths

Ordered by how fast you can get moving.

### 1. Browser demo — today, free, no paperwork

The console at `apps/agent-server` lets anyone talk to the agent through a
laptop or phone browser mic. No number, no KYC, no carrier.

This is genuinely the right tool for selling. A shop owner does not care
whether the audio arrived over PSTN or WebRTC — they care whether the thing
sounds good and gets their callers' questions right. Put a laptop in front
of them and let them try to trip it up.

**Use for:** demos, prompt tuning, showing a business what they'd be buying.
**Can't do:** take real calls from real customers.

### 2. Foreign number + call forwarding — a weekend, works, feels slightly off

Buy a US/UK number (Twilio or Vapi's own), attach it to Vapi normally, then
set **conditional call forwarding** on the Indian mobile so unanswered calls
go to it.

On most Indian networks:

```
Forward when busy:        **67*<number>#
Forward when unanswered:  **61*<number>#
Forward when unreachable: **62*<number>#
Cancel all forwarding:    ##002#
```

The catch that matters: forwarding an Indian mobile to an international
number bills the *forwarding party* at ISD rates for the whole call. Your
friend pays, per minute, for every call the agent handles. Fine for a
prototype you're supervising, genuinely bad as a default.

Caller ID also often arrives mangled, so the agent may not reliably know who
is calling.

**Use for:** proving the end-to-end phone flow with a friendly number.
**Don't:** leave this running unattended on someone's real business line.

### 3. Indian carrier + Indian media anchor — the real production path

Take an Indian licensed provider for the PSTN leg, and give the foreign
voice platform an Indian-looking SIP/RTP endpoint to talk to.

- **Exotel** — UL-VNO licensed, native interconnects with Airtel/Jio/Vi/BSNL,
  INR billing, Virtual SIP Trunking (vSIP) for exactly this. Ask them to
  enable trunking and provision an ExoPhone; setup goes through their team
  rather than fully self-serve.
- **Plivo** — has a documented Vapi SIP integration, though Indian numbers
  still need the India-side media handling.
- **Ozonetel / Knowlarity** — similar licensed-operator positioning.

To keep Vapi in the loop you generally need a media anchor inside India
(Kamailio as SIP proxy + RTPEngine as media relay, on a Mumbai VM) so the
Indian carrier sees an Indian IP in both signalling and SDP. That's real
infrastructure work — days to weeks, plus a VM to babysit.

**Use for:** an actual paying customer.
**Cost:** number rental + per-minute + the VM + your time.

### 4. Skip the foreign platform — India-native voice AI

Some vendors run the whole stack in India and sell an AI-receptionist
product directly. Fastest route to compliant Indian calls, at the cost of
control over prompts, model choice, and margin.

Worth pricing out before committing to path 3 — if the business only needs a
receptionist and you don't need to own the stack, this can be the rational
answer.

## What this repo does about it

`packages/agent-core` deliberately imports **nothing** from Vapi. The
business config, prompt builder, and tool handlers are provider-neutral.

Vapi shows up in exactly two places:

- `scripts/build-agent.mjs` → `buildVapiAssistant()` — one adapter function
- `apps/agent-server/server.mjs` → `/api/tools` — parses Vapi's webhook shape

Moving to Exotel, Plivo, or an India-native platform means writing a second
adapter next to those two. The prompt, the business JSONs, the tool logic,
the escalation rules, and everything you tuned by listening to real calls
all carry over untouched.

That is the single most important design decision in this repo, and it
exists specifically because of the constraint at the top of this page.

## Recommended sequence

1. **Now** — browser demo. Tune prompts against real questions from a real
   business owner. Costs nothing, and this is where the quality actually
   comes from.
2. **When someone says yes** — path 2 with your friend's phone, supervised,
   for a few days. You'll discover what breaks on a real line: background
   noise, callers talking over the agent, accents, bad audio.
3. **When someone will pay** — start the Exotel conversation. Their
   provisioning takes real calendar time, so begin it before you need it.

Don't do 3 before 1. Most of what makes a voice agent good or bad is the
prompt and the escalation rules, and you can learn all of that for free.

## Also worth knowing

- **DND / TRAI commercial-call rules** apply to *outbound* calling and are
  strict. This repo is built for inbound only. Do not repurpose it for
  outbound campaigns without reading up on DLT registration first.
- **Call recording consent** — tell callers they're being recorded if you
  record. Add it to the greeting in the business JSON.
- **Latency** — a US-hosted agent answering an Indian caller adds a
  noticeable round-trip. Callers interpret delay as the agent being slow or
  confused, so keep prompt-side latency (tool calls) minimal. That's why the
  service catalogue lives in the prompt rather than behind a tool.

## Sources

- [Vapi — Indian phone number discussion](https://vapi.ai/community/m/1371357171526406216)
- [Vapi — Plivo SIP integration](https://docs.vapi.ai/advanced/sip/plivo)
- [Exotel — vSIP configuration guide for voice AI platforms](https://support.exotel.com/support/solutions/articles/3000133452-flow-and-api-configuration-guide-for-voice-ai-contact-centre-platforms-via-exotel-virtual-sip-trunk)
- [Exotel — India virtual phone numbers](https://exotel.com/indian-virtual-phone-number/)
- [Routing AI voice calls to India — media anchor approach](https://www.sakshamsharma.in/blogs/routing-ai-voice-calls-to-india/)
- [Telephony partner comparison for voice AI in India](https://caller.digital/blog/telephony-partner-voice-ai-india-plivo-exotel-ozonetel-knowlarity-twilio-2026)
- [Twilio — India regulatory guidelines](https://www.twilio.com/en-us/guidelines/in/regulatory)
- [Vapi — multilingual support](https://docs.vapi.ai/customization/multilingual)
- [Vapi — web calls](https://docs.vapi.ai/quickstart/web)
