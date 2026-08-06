# Voice agent — reusable template for Indian local businesses

This is now a **reusable template**, not a single fixed assistant for
one fictional salon. It defines the system prompt, tools, and business
profile schema that any Indian local business (salon, clinic, gym,
coaching center, and so on) can be onboarded onto by filling in a
profile — see `docs/client-onboarding.md` for that process.

**Lumen Salon still appears in this repo, but only as fictional example
data** in `config/business-profile.example.json` and in examples below
— it is no longer hardcoded into the system prompt or tools. **No Vapi
account, phone number, Twilio, WhatsApp, Google Calendar, or other live
credentials exist.**

| File | What it is |
|---|---|
| `config/vapi-system-prompt.md` | Generic system prompt template — language handling, capabilities, booking-optional logic, universal transfer rules, never-invent rules. A handful of `{{variables}}` get filled in per business. |
| `config/vapi-tools.json` | Definitions for the 7 tools below. Cloned and lightly edited per business (server URL, transfer number) at onboarding. |
| `config/business-profile.example.json` | The schema every business profile follows, shown with Lumen Salon as example data. |
| `docs/client-onboarding.md` | Step-by-step: profile → rendered prompt → tools → phone number → test, for a new client. |

## 1. The seven tools

| Tool | Type | Backing n8n workflow | Status |
|---|---|---|---|
| `get_business_info` | `function` | `/webhook/get-business-info` | **New — no workflow built yet** |
| `get_service_or_price_info` | `function` | `/webhook/get-service-or-price-info` | **New — no workflow built yet** |
| `get_availability` | `function` | `/webhook/get-availability` | **New — no workflow built yet.** Closest existing relative: `n8n/workflows/get_available_slots.json`, which would need generalizing (staff-based lookups, an `availability.source` branch, a `business_id` filter) to serve this. |
| `create_booking_optional` | `function` | `/webhook/create-booking` | Reuses `n8n/workflows/create_booking.json` as-is in spirit; that workflow still assumes exactly one seeded business and has no `business_id` filter yet. |
| `create_callback_request` | `function` | `/webhook/create-callback-request` | **New — no workflow built yet.** |
| `log_call` | `function` | `/webhook/log-call` | Reuses `n8n/workflows/log_call.json`; its `intent`/`outcome` values and the `calls` table's `CHECK` constraint only allow the old salon-specific set — see "Known limitations." |
| `transfer_to_human` | `transferCall` (Vapi built-in) | — no webhook | Same mechanism as before; destination number is now per-business, not fixed. As of Phase 5.6, `n8n/workflows/transfer_to_human.json` exists as a separate backend decision/logging endpoint (`POST /webhook/transfer-to-human`) — it is not called by this tool or by Vapi's native transfer mechanism; see `docs/n8n-setup.md`. |

This phase's file list didn't include n8n workflow changes, so none
were made — the table above is deliberately explicit about what's
still a gap rather than implying these tools are fully wired end to
end. `docs/n8n-setup.md` documents the four *existing* workflows'
current (single-salon) behavior; it hasn't been updated for this phase.

### Why the old tool set changed shape

The single-salon version (`get_available_slots`, `create_booking`,
`send_confirmation`, `log_call`, `transfer_to_human`) assumed exactly
three fixed services with a hardcoded enum. None of that generalizes to
"any Indian local business," so:

- **No hardcoded service enum anywhere.** `service_name` /
  `service_or_staff` are free-text parameters now; the model learns
  what's actually offered from `get_business_info` at the start of the
  call and is instructed never to invent one that isn't in there.
- **Booking is conditional**, not assumed. `create_booking_optional`'s
  name says so directly, and the prompt gates it on
  `booking.enabled` from the profile. Businesses that don't want phone
  booking — or don't track availability at all
  (`availability.source: "not_tracked"`) — get `create_callback_request`
  instead, which is a first-class path, not a degraded fallback.
- **`send_confirmation` was dropped** as a separate Vapi-facing tool.
  A booking confirmation (SMS, WhatsApp, whatever a business prefers —
  see `booking.confirmation_channel` in the profile) is better handled
  inside `create_booking_optional`'s own backing workflow than as a
  second tool call the model has to remember to make. This is a
  deliberate behavior change from the earlier phase, not an oversight.
- **`get_business_info` is new** and is meant to be the *first* tool
  call on every call — it's how a template this generic gets its
  business-specific facts (hours, services, restricted topics) without
  any of that being baked into the shared prompt text.

## 2. Turning the template into one business's assistant

`docs/client-onboarding.md` has the full walkthrough. In short: fill in
a profile → render the prompt's `{{variables}}` → clone the tools file,
fix its URLs and transfer number → create the assistant and tools in
Vapi → attach a phone number. Where to paste real n8n URLs and the
local-vs-public-internet caveat are unchanged from before — see section
3 below.

### Two ways to supply per-business values (and why this doc picks one)

Vapi's dynamic variables (`{{variableName}}`, set via
`assistantOverrides.variableValues` on a call, or as defaults if you
resolve them from the inbound number before the call is answered) would
let one *shared* assistant serve many businesses live. That's a real
Vapi capability, but wiring "which business is this inbound call for"
into a variable-resolution step is a phone-number/webhook integration
this project hasn't built or verified. Rather than describe something
unverified, this template defaults to the simpler, fully-supported
path: **one rendered assistant per business**, created once at
onboarding with that business's values already baked into its own copy
of the prompt text. The `{{variable}}` markers in
`config/vapi-system-prompt.md` are still real Vapi syntax — if you
later build the live-variable-resolution piece, the same template file
works for that too without changes.

`transfer_to_human`'s destination number and every tool's `server.url`
are **not** template-able the same way — Vapi doesn't substitute
`{{variables}}` inside tool `destinations` or `server` config, only in
prompts and messages. Each business's tool set needs its own concrete
values there, which is why onboarding clones `vapi-tools.json` per
client rather than sharing one tool set with a live transfer-number
variable.

## 3. Where to paste real n8n URLs (unchanged from Phase 5)

Every `server.url` in `config/vapi-tools.json` is still
`https://REPLACE_WITH_YOUR_N8N_BASE_URL/webhook/<path>`. Create each
tool in Vapi (dashboard **Tools**, or `POST /tool`), then set the real
URL, keeping the `/webhook/<path>` suffix. See `docs/client-onboarding.md`
step 3 for the per-business specifics.

**Vapi's servers run in the cloud and cannot reach
`http://localhost:5678`.** If your n8n is local, tunnel it first:

```bash
ngrok http 5678
```

Use the resulting `https://....ngrok-free.app` as the base URL. It
changes on every restart unless you pay for a static domain. If you'd
rather not tunnel, point at a publicly hosted n8n instance instead — the
base URL changes, the `/webhook/<path>` suffixes stay the same.

## 4. Language and voice configuration

This template targets Hindi, Hinglish, and English callers. Vapi's own
guidance is specific about what's required — a generic "be
multilingual" instruction isn't enough; the system prompt has to name
the languages explicitly (this template already does, via
`{{languages_supported}}`), and the transcriber/voice providers matter:

- **Transcriber**: use a provider with real auto-detection and
  code-switching support — Deepgram (Nova 2/3, language set to `Multi`)
  or Google STT (`Multilingual` setting) are the ones Vapi documents as
  supporting this. Providers that only transcribe one fixed language at
  a time (several are single-language-only) won't handle a caller who
  drifts between Hindi and English mid-sentence, which is the normal
  case for Hinglish.
- **Voice**: Azure's `multilingual-auto` gives the broadest coverage, or
  configure a primary voice with fallback voices per language.

None of this is configured anywhere in this repo yet — it's dashboard
configuration you set per assistant at onboarding (`docs/client-onboarding.md`
step 4), not something expressible in `config/vapi-tools.json` or the
system prompt text itself.

## 5. Manual test checklist

Adapt this per business using its real services, hours, and restricted
topics — the specifics below use the example profile.

**Text-based (Vapi dashboard test chat)**

- [ ] Ask about hours or an address — answered only from
      `get_business_info`'s response, not restated from memory on a
      later question.
- [ ] Ask the price of a `not_disclosed` service (e.g. Consultation in
      the example profile) — assistant declines to estimate rather than
      offering a range.
- [ ] Ask for a service this business doesn't offer — assistant says so
      rather than assuming it exists.
- [ ] With `booking.enabled: true` and a bookable service: full booking
      flow, ending in "you're booked" only after `confirmed: true`.
- [ ] Ask to book a non-bookable service (e.g. Hair colour in the
      example profile) — assistant offers `create_callback_request`,
      not a booking.
- [ ] Say "let me speak to a person" — `transfer_to_human` fires
      immediately.
- [ ] Describe a complaint or a billing disagreement — transfers
      immediately, doesn't try to resolve it first.
- [ ] One call opened in Hindi, one in English, one that switches
      mid-call — assistant follows without asking the caller to repeat
      themselves.
- [ ] Every call variant above ends with exactly one `log_call`, with
      an accurate `intent`/`outcome`.

**Booking-disabled business**

- [ ] Set `booking.enabled: false` in a test profile and confirm the
      rendered prompt/assistant never attempts `create_booking_optional`
      — every booking-shaped request becomes a callback request instead.

**Failure honesty** (same rule as the n8n workflows enforce, see
`docs/n8n-setup.md`)

- [ ] Point `create_booking_optional`'s `server.url` at something
      unreachable and try to book — assistant must not claim success;
      confirm no Supabase row or calendar event exists afterward.

## 6. Known limitations

- **No multi-tenant n8n backend yet.** Every data tool takes
  `business_id`, but none of the four *existing* n8n workflows
  (`get_available_slots.json`, `create_booking.json`, `log_call.json`,
  plus the never-built `send_confirmation.json` path) read or filter on
  it — they assume the single seeded business from `supabase/seed.sql`.
  The three genuinely new tools (`get_business_info`,
  `get_service_or_price_info`, `create_callback_request`) and the
  generalized `get_availability` have no n8n workflow at all yet. This
  is real, scoped follow-up work, not a detail to gloss over.
- **The `calls` table's `CHECK` constraint doesn't accept the new
  `intent`/`outcome` values.** `supabase/migrations/0001_init.sql`
  only allows `FAQ`/`Booking`/`Transfer` and
  `FAQ Answered`/`Booked`/`Transferred`/`No Match`. This template's
  `log_call` uses a broader set (`Info`, `Callback`, etc.) that fits a
  general-purpose assistant better — a small migration to widen the
  constraint is needed before `log_call` will actually succeed for a
  non-salon business. Not done here; this task's file list didn't
  include Supabase migrations.
- **No real notification channel.** `callback.notify_channel` and
  `booking.confirmation_channel` in the business profile record a
  business's *preference* (SMS, WhatsApp, none) but nothing sends
  anything — no Twilio, no WhatsApp Business API integration exists.
  `create_callback_request` and `create_booking_optional`'s "notify the
  business" behavior is a placeholder describable in the profile, not a
  working notification.
- **One assistant per business, not one shared assistant.** See
  section 2 above — this is a deliberate, verified choice, not a
  temporary shortcut, but it does mean N businesses means N Vapi
  assistants and N tool-set clones to keep in sync if the template
  changes.
- **`transfer_to_human` still has exactly one destination per
  business.** No role-based routing (e.g. billing vs. medical vs.
  general).
- **Restricted topics are advisory to the model, not enforced in
  code.** `restricted_topics` in the profile is surfaced to the
  assistant via `get_business_info` and reinforced in the prompt, but
  nothing blocks the model from answering anyway if it doesn't comply —
  this is a prompting-layer safeguard, the same as the rest of the
  "never invent" rules.

## What's deliberately not here

- No Vapi account, assistant ID, phone number, or API key.
- No Twilio, WhatsApp Business API, or Google Calendar credentials.
- No real customer data anywhere in these files or their examples.
- No production n8n URLs or transfer numbers — every `server.url` and
  destination number is a placeholder filled in per business at
  onboarding, never checked into this repo with real values.
