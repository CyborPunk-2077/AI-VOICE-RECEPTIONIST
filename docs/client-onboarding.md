# Onboarding a new business onto the ReceptionFlow template

This walks through turning the reusable template
(`config/vapi-system-prompt.md`, `config/vapi-tools.json`) plus a new
business's profile (`config/business-profile.example.json` is the
schema/example) into a working Vapi assistant for one client. No live
Vapi, phone, Twilio, WhatsApp, or Google Calendar credentials are
created by following this — every step below produces config you'd
apply once real accounts exist.

This process is manual right now (copy, fill in, paste). Automating it
— a script that renders the prompt and tool set directly from a
profile JSON — is a natural next step, not built in this phase.

## 1. Collect the business profile

Copy `config/business-profile.example.json` to a new file (e.g.
`business-profiles/<client-slug>.json` — this directory doesn't exist
yet, create it when you have a real second client) and fill in every
field from a conversation with the business owner:

**`business_id` in the profile is `businesses.business_slug` in Supabase.**
It's the same value end to end: what you type into the profile, what
gets rendered into the system prompt, what every Vapi tool call sends as
`business_id`, and what every n8n workflow resolves against
`businesses.business_slug` before touching any other table (see
`docs/n8n-setup.md` section 4). Pick it once, here, and it doesn't change.

| Field | What to ask the owner |
|---|---|
| `business_id` | Pick a short, unique slug (letters, numbers, hyphens). |
| `business_name`, `industry` | How they introduce themselves, and in a couple of words what kind of business this is. |
| `locale.languages_supported` | Which of Hindi, Hinglish, English their customers actually call in. Order matters — put their most common one first as `default_language`. |
| `contact` | Address as they'd want it read aloud, phone, and a one-sentence directions note (landmark, parking, floor). |
| `opening_hours` | Per-day hours, any lunch/break closure, and whether they're closed on a fixed day. Ask about public holidays too — the template only says this is *possible*, it doesn't guess dates. |
| `services` | Every service you want the assistant to discuss, with duration and, critically, whether the price is exact, a range, or not something they want quoted over the phone. |
| `price_policy` | A business-wide default and any disclaimer they want attached to price quotes. |
| `faqs` | Only questions they're comfortable being answered automatically — this becomes the approved list, and anything not here gets transferred or turned into a callback, never guessed. |
| `availability.source` | `google_calendar` if they'll connect a real calendar, `staff_roster` if availability is tracked some other way you'll build later, `not_tracked` if they don't track it digitally at all (very common for small businesses — this is a fully supported, first-class option, not a fallback to apologize for). |
| `availability.staff` | Names and roles of anyone callers might ask for by name. |
| `booking.enabled` + `bookable_services` | Whether this business wants live phone booking at all, and if so, which services (some businesses will want bookable simple services but require in-person consults for others — see the `svc-color` example in the example profile). |
| `callback.callback_number` | Where *the business* wants to be told about a new callback/lead request. |
| `transfer_rules.transfer_number` | The one human line calls get transferred to. There's no role-based routing in this template — one number per business. |
| `restricted_topics` | Anything they specifically don't want the assistant discussing, beyond the universal transfer triggers (medical/legal claims, guaranteed results, discounts, staff not listed, etc.). |

## 2. Create this business in Supabase

The n8n backend (`docs/n8n-setup.md`) resolves every tool call's
`business_id` against a real `businesses` row — there is no tool call
that works before this step. In the Supabase SQL editor, insert (values
below map directly from the profile fields in step 1):

```sql
with b as (
  insert into businesses (name, address, phone, timezone, hours_text, business_slug)
  values (
    '<business_name>', '<contact.address>', '<contact.phone_display>',
    '<locale.timezone>', '<a short human-readable hours summary>', '<business_id>'
  )
  returning id
)
insert into business_settings (
  business_id, industry, languages_supported, default_language, currency,
  directions_note, opening_hours, price_policy, booking_enabled,
  confirmation_channel, callback_number, callback_notify_channel,
  transfer_number, restricted_topics, availability_source, calendar_id
)
select
  id, '<industry>', '<locale.languages_supported as a JSON array>'::jsonb, '<locale.default_language>', '<locale.currency>',
  '<contact.directions_note>', '<opening_hours, in the shape docs/database.md documents>'::jsonb,
  '<price_policy>'::jsonb, <booking.enabled>,
  '<booking.confirmation_channel>', '<callback.callback_number>', '<callback.notify_channel>',
  '<transfer_rules.transfer_number>', '<restricted_topics as a JSON array>'::jsonb,
  '<availability.source>', '<a real Google Calendar id, or leave the REPLACE_WITH_ placeholder until one exists>'
from b;
```

Then insert each service from the profile's `services` array into
`services` (`price_disclosure`/`price_amount`/`price_range`/`bookable`
map directly), each `faqs` entry into `faqs`, and — if
`availability.source` is `staff_roster` — each `availability.staff`
entry into `staff` plus their weekly hours into `staff_availability`. See
`supabase/seed.sql` for a worked example using Lumen Salon, and
`docs/n8n-setup.md` section 7 for smaller gym/clinic examples covering
the other two `availability_source` values.

Without this step, every tool call for this business returns 404
`unknown_business` — there is nothing partially working to fall back on.

## 3. Render the system prompt

Open `config/vapi-system-prompt.md` and, working in a copy (don't edit
the template itself), replace every `{{variable}}` with that business's
value:

- `{{business_name}}` → `business_name`
- `{{business_id}}` → `business_id`
- `{{industry}}` → `industry`
- `{{languages_supported}}` → a short spoken list, e.g. "Hindi,
  Hinglish, and English" — built from `locale.languages_supported`

Paste the finished text into the new assistant's **System Prompt**
field (Vapi dashboard: Assistants → create assistant → Model tab).

## 4. Create this business's tools

Open `config/vapi-tools.json` in a copy and, for this business:

1. Replace every `https://REPLACE_WITH_YOUR_N8N_BASE_URL` with your
   n8n base URL. If one shared n8n instance serves every client (the
   intended design — see `docs/voice-agent.md`), this is the same
   value across all businesses; you're not standing up n8n per client.
2. Replace `transfer_to_human`'s destination:
   `+91REPLACE_WITH_HUMAN_TRANSFER_NUMBER` → this business's
   `transfer_rules.transfer_number`, and personalize the `message` if
   you want ("connecting you to Lumen Salon's team" instead of the
   generic wording).
3. Create each of the 7 tool objects for this business in Vapi
   (dashboard **Tools** page, or `POST /tool` per object — see
   `docs/voice-agent.md` section 2 for the exact steps), then attach
   all 7 to the assistant from step 3.

Every other tool field — parameter schemas, descriptions, `business_id`
requirement — is shared across every client and shouldn't need editing
per business. `business_id` itself isn't hardcoded into the tools; the
assistant supplies it on every call because the rendered system prompt
told it what its `business_id` is (step 3) — and, as of step 2, that
`business_id` actually resolves to something in Supabase.

## 5. Configure language and voice

Because this business's assistant needs to speak Hindi, Hinglish, and
English, set (Vapi dashboard, this assistant's **Transcriber** and
**Voice** sections — see `docs/voice-agent.md` for the source):

- **Transcriber**: Deepgram (Nova 2 or Nova 3) with language set to
  `Multi`, or Google STT with `Multilingual` — both auto-detect and
  handle code-switching, which matters for Hinglish. Don't use a
  transcriber that only supports one language at a time.
- **Voice**: Azure with `multilingual-auto`, or a primary voice plus
  fallback voices for the other languages this business supports.

If a business genuinely only ever gets English calls, a single-language
transcriber is fine — check with the owner rather than assuming.

## 6. Attach a phone number

Attach a Vapi phone number to this assistant (dashboard **Phone
Numbers**). This is the one step that unavoidably needs a real Vapi
account and, eventually, a real number — nothing before this point
does.

## 7. Test before going live

Use the checklist in `docs/voice-agent.md` section 5, substituting this
business's real services, hours, and restricted topics for the
examples there. You can also exercise the backend directly, without a
phone call, using the curl examples in `docs/n8n-setup.md` section 6
against this business's real `business_id`. Pay particular attention to:

- A price question for a `not_disclosed` service — the assistant must
  decline to estimate, not soften into a guess.
- A booking attempt on a non-bookable service (like `svc-color` in the
  example profile) — it should offer a callback, not silently allow a
  booking.
- If `availability.source` is `not_tracked`, every availability check
  should come back "not tracked" and pivot straight to a callback
  request — never a guessed time.
- One call in Hindi, one in English, and one that switches mid-call —
  confirm the assistant follows without asking the caller to repeat
  themselves in a different language.

## What this onboarding flow does not cover

- **Real SMS/WhatsApp notification.** `callback.notify_channel` and
  `booking.confirmation_channel` are recorded in Supabase (step 2) as
  this business's *preference*, but nothing sends anything yet — see the
  Twilio/WhatsApp placeholders noted in `docs/n8n-setup.md` and
  `docs/voice-agent.md`.
- **Role-based transfer routing.** `transfer_to_human` has exactly one
  destination number per business; there's no billing-vs-medical-vs-general
  split.
- **Automating steps 1–4.** This process is still manual (copy, fill in,
  paste, run SQL). A script that renders the prompt, tool set, and the
  Supabase inserts directly from one profile JSON is a natural next step,
  not built yet.

As of this phase, the multi-tenant n8n backend referenced throughout this
doc is real — every tool has a working workflow behind it, scoped to the
business you created in step 2 (see `docs/n8n-setup.md` for the full
tenant-isolation model), and the `calls` table accepts the broader
`log_call` vocabulary this template uses. What's listed above is what's
still genuinely missing, not a restatement of the backend gap.
