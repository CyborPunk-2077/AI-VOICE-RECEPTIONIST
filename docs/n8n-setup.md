# n8n setup (local)

Nine importable workflows live in `n8n/workflows/`. Together they are the
full multi-business backend the voice agent template calls (see
`docs/voice-agent.md` and `config/vapi-tools.json`).

| File | Webhook path | Purpose | Status |
|---|---|---|---|
| `get_business_info.json` | `POST /webhook/get-business-info` | This business's approved facts: name, hours, address, services, FAQs, booking status, restricted topics. | New |
| `get_service_or_price_info.json` | `POST /webhook/get-service-or-price-info` | Fuzzy-match one service and return its approved price (or "not disclosed"). | New |
| `get_availability.json` | `POST /webhook/get-availability` | Open slots for a service/staff member, branching on `availability_source` (`google_calendar` \| `staff_roster` \| `not_tracked`). | New |
| `create_booking.json` | `POST /webhook/create-booking` | Validate, de-duplicate, conflict-check, and write a booking. Calendar-optional per business. | Updated for multi-business |
| `create_callback_request.json` | `POST /webhook/create-callback-request` | Record a callback/lead request and return it for the business to follow up on. | New |
| `transfer_to_human.json` | `POST /webhook/transfer-to-human` | Decide whether an approved human transfer or a safe callback fallback applies, for a fixed set of universal reasons; log the decision. | New (Phase 5.6) |
| `log_call.json` | `POST /webhook/log-call` | Write a call record to Supabase, optionally linking it to a booking. | Updated for multi-business |
| `get_available_slots.json` | `POST /webhook/get-available-slots` | Legacy single-service Google Calendar slot search (Phase 3). Kept for backward compatibility; `get_availability` is what the current tool set calls. | Updated for multi-business |
| `send_confirmation.json` | `POST /webhook/send-confirmation` | Confirmation SMS — **placeholder Twilio node**, not wired to a real account. Standalone; `create_booking` does not call it automatically. | Updated for multi-business |

**`transfer_to_human.json` is a backend decision/logging endpoint, not a
live transfer mechanism.** In `config/vapi-tools.json`, `transfer_to_human`
is still a native Vapi `transferCall` tool with no `server.url` — Vapi
performs the actual call transfer itself, without calling any webhook (see
`docs/voice-agent.md`). This workflow exists so the transfer decision
(approved vs. callback fallback) and its reason can be computed and logged
against Supabase independently of that native mechanism; wiring the two
together — e.g. calling this webhook immediately before Vapi's
`transferCall` fires — is a live-integration task, not done in this phase.

**Every workflow now requires and validates `business_id`** (the
business's public `business_slug`, e.g. `lumen-salon-01`), resolves it to
an internal business uuid before touching any other table, and filters
every subsequent Supabase query by that resolved uuid — see "Tenant
isolation" below. **Nothing here is connected to Vapi, a phone number, or
real customer data.** Every credential, calendar id, and phone number in
these files is a `REPLACE_WITH_...` placeholder.

---

## 1. Prerequisites

- **Local n8n** running at `http://localhost:5678`. Either works:
  ```
  npx n8n
  # or
  docker run -it --rm -p 5678:5678 -v ~/.n8n:/home/node/.n8n docker.io/n8nio/n8n
  ```
- **Supabase**, migrated and seeded — run, in order, `supabase/migrations/0001_init.sql`,
  `supabase/migrations/0002_multi_business.sql`, then `supabase/seed.sql`
  (see `docs/database.md`). Without them, every workflow returns
  `unknown_business` (no `businesses` row matches the `business_id` you
  sent) or `not_configured`.
- **A Google account** with a throwaway calendar for test bookings, if
  you want to exercise the `google_calendar` availability path. Not
  required for `staff_roster` or `not_tracked` businesses.
- **Twilio is not required.** `send_confirmation` is built to fail
  gracefully without it.

### Environment variables n8n needs

```
SUPABASE_URL=YOUR_SUPABASE_PROJECT_URL
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
```

Set these **before starting n8n**. This is the **service-role** key, not
the publishable key the dashboard uses — RLS denies writes to anon, so
the service-role key is what lets n8n insert/update rows. Never put it in
`apps/dashboard/.env.local` or any file in this repo. If you have set
`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, unset it — with it on, `$env` returns
nothing and every Supabase call fails to authorise.

---

## 2. Import the nine workflows

Do this once per file, in any order: **⋯** menu → **Import from File...**,
pick one file from `n8n/workflows/`, **Ctrl/Cmd+S** to save. Repeat for
the other eight.

Expect these warnings on a fresh import — all are placeholders doing their
job:

- Google Calendar nodes (in `create_booking.json`, `get_available_slots.json`,
  `get_availability.json`) show **"Credentials not found"** until you add
  a credential (step 3).
- The Twilio node in `send_confirmation.json` shows the same.

`transfer_to_human.json` has no external credential to configure — it only
talks to Supabase.

Leave all nine workflows **inactive** until you've tested them by hand.

---

## 3. Credentials you must add manually

### Google Calendar OAuth2 — required only for `google_calendar` businesses

1. In Google Cloud Console: create a project, enable the **Google
   Calendar API**, and create an **OAuth client ID** of type *Web
   application*.
2. Add this redirect URI exactly:
   `http://localhost:5678/rest/oauth2-credential/callback`
3. In n8n: **Credentials → Add credential → Google Calendar OAuth2 API**.
   Paste the client id and secret, click **Sign in with Google**, and
   grant calendar access. Name it something recognisable, e.g.
   `ReceptionFlow Google Calendar`.
4. Open every Google Calendar node in `create_booking.json`,
   `get_available_slots.json`, and `get_availability.json` and select
   this credential from the **Credential** dropdown.

**The calendar itself is chosen per business, not per node.** Unlike
Phase 3 (where each Google Calendar node had a hardcoded calendar
selected in its own dropdown), these nodes now read `calendar_id`
dynamically from that business's `business_settings` row at runtime — the
node's **Calendar** field is set to **By ID** with an expression, so
there is nothing to pick from a list in the node UI itself. What you
configure per business is the Supabase row: create a calendar in Google
Calendar (e.g. **ReceptionFlow Test Calendar**, same as Phase 3), then
`UPDATE business_settings SET calendar_id = 'abc123...@group.calendar.google.com' WHERE business_id = (SELECT id FROM businesses WHERE business_slug = 'lumen-salon-01');`
(Google Calendar → **Settings for my calendars → [calendar] → Integrate
calendar → Calendar ID**).

The seeded Lumen Salon row ships with
`calendar_id = 'REPLACE_WITH_RECEPTIONFLOW_TEST_CALENDAR_ID'` — deliberately
not a real id, so a business you haven't pointed at a real calendar fails
loudly (`calendar_not_configured` / `calendar_unavailable`) rather than
silently falling back to something else.

### Twilio — not required, leave unconfigured

`send_confirmation`'s **Send SMS (Placeholder)** node ships with no
credential and `REPLACE_WITH_YOUR_TWILIO_FROM_NUMBER` as its from-number.
It runs with *On Error → Continue*, so it fails, the workflow carries on,
and the response says `"sent": false`. Do not add real Twilio credentials
yet — that's a later phase in `docs/todo.md`.

### Supabase — no credential needed

Reached through plain HTTP Request nodes using the `$env` variables from
step 1. Nothing to configure in the credentials UI.

### Header Auth — required on all nine webhooks (Phase 5.7)

Every workflow's **Webhook** trigger node now has
`authentication: headerAuth` set, referencing a credential id that ships
as the placeholder `REPLACE_WITH_YOUR_N8N_GATEWAY_HEADER_AUTH_CREDENTIAL`.
Until you create and select a real credential, **every one of these nine
webhooks rejects every request with 403** — including from n8n's own test
flows. This is intentional and is the mechanism that closes off direct
external use of the workflow URLs (see "Vapi tool gateway" below): only
the Next.js gateway, which sends this same secret on every forwarded
request, can successfully call them.

1. In n8n: **Credentials → Add credential → Header Auth**.
2. Set **Name** to a header name — this must exactly match
   `N8N_GATEWAY_HEADER_NAME` in the gateway's environment (default
   `x-receptionflow-gateway-secret`; see `.env.example`).
3. Set **Value** to a long random secret — this must exactly match
   `N8N_GATEWAY_SHARED_SECRET` in the gateway's environment. Generate it
   yourself (e.g. `openssl rand -hex 32`); it is not a value any external
   service provides.
4. Name the credential something recognisable, e.g.
   `ReceptionFlow Gateway Shared Secret`.
5. Open each of the nine workflows' **Webhook** node and select this
   credential from the **Credential** dropdown.
6. Save and re-test using the **test** webhook URLs — a request without
   the header (e.g. a bare `curl` with no extra header) should now return
   403; the same request with `-H "x-receptionflow-gateway-secret: <your secret>"`
   should behave as documented in section 6.

---

## 4. Tenant isolation — how every workflow enforces it

Every workflow follows the same pattern, in this order, before doing
anything business-specific:

1. **Validate input** — `business_id` (the public `business_slug`) must
   be present, plus whatever else that tool needs. Format-only checks
   happen here; anything requiring the business's own timezone happens
   after step 2.
2. **Resolve business** — `GET businesses?business_slug=eq.<business_id>`.
   No match → `404 unknown_business`, and the workflow stops. From here
   on, every node uses the **resolved internal uuid**, never the caller's
   raw `business_id` string, for every subsequent filter.
3. **Resolve settings** (most workflows) — `GET business_settings?business_id=eq.<uuid>`.
   A missing settings row is treated as "not configured yet" and falls
   back to the most conservative defaults (booking disabled, availability
   not tracked) rather than guessing.
4. **Every read/write from here is filtered by the resolved uuid** —
   `services`, `faqs`, `staff`, `staff_availability`, `appointments`,
   `calls`, and `callback_requests` queries all carry
   `business_id=eq.<uuid>` (or, for `staff_availability`, a `staff_id`
   already scoped to that business's own `staff` rows). A booking_id or
   staff name from one business can never resolve against another
   business's rows — e.g. `log_call`'s booking-link PATCH filters by both
   `id=eq.<booking_id>` **and** `business_id=eq.<uuid>`, so a `booking_id`
   copied from a different business's response silently fails to link
   (reported as `booking_link: "not_found"`) instead of attaching to the
   wrong business's appointment.

No workflow queries `services`, `appointments`, `calls`, `faqs`, `staff`,
`staff_availability`, or `callback_requests` without a `business_id`
filter derived from the resolved uuid.

### This is not production tenant isolation on its own — and why that's now a smaller gap

Everything above prevents one business's *data* from leaking into another
business's *response*, but only among requests that already reached n8n.
Historically (Phase 5.6 and earlier) every workflow trusted whatever
`business_id` string the request body carried, with nothing in front of
n8n confirming the caller was really Vapi acting for that business.

**As of Phase 5.7, two of the concrete gaps this section used to describe
are addressed, not just documented:**

1. **Vapi-to-n8n request authentication** — every one of these nine
   webhooks now requires n8n's Header Auth (see "Header Auth — required on
   all nine webhooks" above), checked against an internal secret only the
   gateway (`apps/dashboard/src/app/api/vapi/*`) knows. A request that
   doesn't carry that header — including one crafted by anyone who
   obtains one of these webhook URLs directly — is rejected with 403
   before any workflow logic runs at all.
2. **Server-side business mapping** — the gateway resolves `business_id`
   itself from Vapi's own call metadata (assistant id / phone number id,
   values the caller cannot influence) against the new
   `vapi_business_map` table (`supabase/migrations/0003_vapi_gateway.sql`),
   and only then calls n8n. The LLM is never even asked for `business_id`
   anymore — see `config/vapi-tools.json`'s `_phase_5_7_trust_model` and
   "Vapi tool gateway" below.

**What's still true, and still worth being precise about:** the n8n
workflows themselves are unchanged in this respect — if you called one
directly with the correct Header Auth secret and a `business_id` you
made up, it would still resolve and serve that business's data, exactly
as before. Header Auth proves "this request came through the gateway,"
not "this specific business_id is the one the gateway actually resolved
for this call" — that guarantee lives entirely in the gateway's own logic
(strip-and-replace, never merge), not in anything n8n can check. This is
a reasonable trust boundary (the gateway is the only thing that can reach
n8n's Header Auth-protected URLs at all), but it does mean the gateway's
own correctness is now where tenant isolation actually lives — see
"Vapi tool gateway" below for what it does and does not verify, and its
own explicit caveats about payload shapes unverified against a live Vapi
account.

---

## 5. Webhook URLs on localhost

| | URL shape | When it works |
|---|---|---|
| **Test** | `http://localhost:5678/webhook-test/<path>` | Only while you've clicked **Execute workflow** on that workflow — catches one request, then stops |
| **Production** | `http://localhost:5678/webhook/<path>` | Only while the workflow is **Active** |

```
http://localhost:5678/webhook/get-business-info
http://localhost:5678/webhook/get-service-or-price-info
http://localhost:5678/webhook/get-availability
http://localhost:5678/webhook/create-booking
http://localhost:5678/webhook/create-callback-request
http://localhost:5678/webhook/transfer-to-human
http://localhost:5678/webhook/log-call
http://localhost:5678/webhook/get-available-slots
http://localhost:5678/webhook/send-confirmation
```

Swap `/webhook/` for `/webhook-test/` while iterating — you get the full
node-by-node execution view. All are `POST` with `Content-Type: application/json`.

---

## 6. Example payloads (Lumen Salon)

`business_id` below is Lumen Salon's seeded slug, `lumen-salon-01`
(`availability_source: google_calendar`, `booking_enabled: true`). Dates
are examples — use a date inside your search window that isn't in the past.

### get_business_info

```bash
curl -s -X POST http://localhost:5678/webhook-test/get-business-info \
  -H 'Content-Type: application/json' \
  -d '{ "business_id": "lumen-salon-01" }'
```

Success (200): business name, industry, languages, timezone, contact,
opening hours, the active service list (name/duration/bookable, no
pricing), approved FAQs, `booking.enabled`, `availability_source`, and
`restricted_topics`. Unknown business → 404 `unknown_business`.

### get_service_or_price_info

```bash
curl -s -X POST http://localhost:5678/webhook-test/get-service-or-price-info \
  -H 'Content-Type: application/json' \
  -d '{ "business_id": "lumen-salon-01", "service_name": "the beard thing" }'
```

Fuzzy-matches `beard` against `Haircut and beard` (200, `found: true`,
`price_disclosure: "exact"`, `price_amount: 55`). Asking about `"hair
color"` returns `price_disclosure: "range"` with `price_range` and a
`disclaimer_note`, never a computed number. Asking about `"consultation"`
returns `price_disclosure: "not_disclosed"` with no amount or range at
all. A service that doesn't exist → 404 `unknown_service`, `found: false`.

### get_availability (google_calendar business)

```bash
curl -s -X POST http://localhost:5678/webhook-test/get-availability \
  -H 'Content-Type: application/json' \
  -d '{
    "business_id": "lumen-salon-01",
    "service_or_staff": "Haircut",
    "preferred_date": "2026-08-03",
    "preferred_time": "14:00"
  }'
```

Success (200): 2–3 slots with `"source": "google_calendar"`. Nothing free
in 14 days → 409 `no_slots_available`. Calendar not yet pointed at a real
id (still the seeded placeholder) → 502 `calendar_not_configured` — this
is expected until you follow step 3's `UPDATE` against a real calendar.

### create_booking

```bash
curl -s -X POST http://localhost:5678/webhook-test/create-booking \
  -H 'Content-Type: application/json' \
  -d '{
    "business_id": "lumen-salon-01",
    "customer_name": "Dana Reyes",
    "phone": "15035550142",
    "service": "Haircut",
    "selected_slot": { "start": "2026-08-03T14:00:00-07:00", "end": "2026-08-03T14:45:00-07:00" }
  }'
```

Success (200): `confirmed: true`, a `booking_id`, and the calendar event
id (once a real calendar is configured — otherwise this business's
booking still succeeds and writes to `appointments`, but `create_booking`
only reaches Google Calendar at all when `availability_source =
'google_calendar'` **and** a `calendar_id` is set; see "Booking is
calendar-optional" below). Same request twice → `"status": "already_booked"`,
same `booking_id`. Booking `"Hair color"` (seeded `bookable: false`) → 409
`service_not_bookable`. `phone` is loosely normalized — see "Known
simplifications."

### create_callback_request

```bash
curl -s -X POST http://localhost:5678/webhook-test/create-callback-request \
  -H 'Content-Type: application/json' \
  -d '{
    "business_id": "lumen-salon-01",
    "customer_name": "Jordan Lee",
    "phone": "15035550199",
    "reason": "Wants a hair colour consultation, prefers weekday evenings",
    "preferred_callback_time": "after 6pm"
  }'
```

Success (200): `received: true`, a `callback_id`, and `notify_channel`
from that business's settings — no real SMS/WhatsApp is sent (see "What's
deliberately not here").

### transfer_to_human

```bash
curl -s -X POST http://localhost:5678/webhook-test/transfer-to-human \
  -H 'Content-Type: application/json' \
  -d '{
    "business_id": "lumen-salon-01",
    "call_id": "00000000-0000-4000-8000-000000000000",
    "caller_number": "15035550142",
    "transfer_reason": "complaint"
  }'
```

`transfer_reason` must be one of `explicit_human_request`,
`emergency_or_distress`, `complaint`, `payment_dispute`, or
`unknown_or_sensitive_question` (a few natural-language variants like
`"human"`, `"emergency"`, `"billing_dispute"` are mapped onto these, same
pattern as `log_call`'s intent/outcome mapping) — anything else is 400
`invalid_input`, never approved.

Success (200) once Lumen Salon's `transfer_number` is set to something
other than the seeded `REPLACE_WITH_HUMAN_TRANSFER_NUMBER` placeholder:

```json
{
  "business_id": "lumen-salon-01",
  "call_id": "00000000-0000-4000-8000-000000000000",
  "decision": "transfer_approved",
  "reason": "complaint",
  "transfer_number": "+15035550100",
  "message": "Transfer approved for an approved reason. Connect the caller to this business's transfer number now.",
  "logged": "logged"
}
```

Against the seeded (placeholder) `transfer_number`, or any business with
no `business_settings` row at all, the response is still 200 but with
`"decision": "callback_fallback"`, `"transfer_number": null`, and a
message pointing at `create_callback_request` instead — this is a normal,
expected outcome, not an error. `logged` reflects whether `call_id`
matched an existing `calls` row for this business: `"logged"` (matched
and written to `call_events`), `"call_not_found"` (no matching row yet —
expected, since `transfer_to_human` usually fires before `log_call` has
created one), `"failed"` (matched but the write itself errored), or
`"skipped_non_uuid_call_id"` (the `call_id` sent wasn't UUID-shaped, so no
lookup was attempted). A missing `business_id`/`call_id`/`caller_number`,
or an unrecognised `transfer_reason` → 400 `invalid_input`. Unknown
`business_id` → 404 `unknown_business`.

### log_call

```bash
curl -s -X POST http://localhost:5678/webhook-test/log-call \
  -H 'Content-Type: application/json' \
  -d '{
    "business_id": "lumen-salon-01",
    "caller_number": "15035550142",
    "intent": "Booking",
    "outcome": "Booked",
    "call_summary": "Caller asked for a haircut Monday afternoon and booked 2:00 PM.",
    "booking_id": "00000000-0000-4000-8000-000000000000",
    "duration_seconds": 96
  }'
```

`intent`/`outcome` accept both the original salon vocabulary (`FAQ`,
`Booking`, `Transfer` / `FAQ Answered`, `Booked`, `Transferred`, `No
Match`) and the template's broader vocabulary (`Info`, `Callback` /
`Info Provided`, `Callback Requested`) — see `docs/database.md`. Anything
else is a 400, never guessed.

---

## 7. Manual test payloads — gym, clinic, salon

Salon (Lumen, `google_calendar`) is covered above. These two fictional
test businesses are **not** part of `supabase/seed.sql** — they're
throwaway fixtures for exercising the other two `availability_source`
branches by hand. Run the `insert` below in the Supabase SQL editor, test
against it, then delete it (`delete from businesses where business_slug =
'...'` cascades to its settings/services/staff rows).

### Gym — `staff_roster`

```sql
with b as (
  insert into businesses (name, address, phone, timezone, hours_text, business_slug)
  values ('PowerHouse Fitness', '12 MG Road, Bengaluru, Karnataka 560001', '+91REPLACE_WITH_TEST_PHONE',
          'Asia/Kolkata', 'Mon-Sat, 6:00 AM-9:00 PM', 'powerhouse-fitness-test')
  returning id
),
s as (
  insert into services (business_id, name, duration_minutes, price_disclosure, price_amount, bookable)
  select id, 'Personal Training Session', 60, 'exact', 800, true from b
  returning id
),
settings as (
  insert into business_settings (business_id, industry, booking_enabled, availability_source)
  select id, 'gym', true, 'staff_roster' from b
),
staff as (
  insert into staff (business_id, name, role, services)
  select b.id, 'Ravi', 'Trainer', jsonb_build_array(s.id) from b, s
  returning id
)
insert into staff_availability (business_id, staff_id, weekday, start_time, end_time)
select b.id, staff.id, wd.weekday, '06:00'::time, '20:00'::time
from b, staff, (values (1),(2),(3),(4),(5),(6)) as wd(weekday);
```

```bash
curl -s -X POST http://localhost:5678/webhook-test/get-availability \
  -H 'Content-Type: application/json' \
  -d '{ "business_id": "powerhouse-fitness-test", "service_or_staff": "Ravi", "preferred_date": "2026-08-03" }'
# -> 200, "source": "staff_roster", slots drawn from Ravi's weekly window minus existing appointments

curl -s -X POST http://localhost:5678/webhook-test/create-booking \
  -H 'Content-Type: application/json' \
  -d '{ "business_id": "powerhouse-fitness-test", "customer_name": "Test Caller", "phone": "919900011122",
       "service": "Personal Training Session", "selected_slot": "2026-08-03T07:00:00+05:30" }'
# -> 200, confirmed: true, calendar_event_id: null (no Google Calendar configured for this business)
```

### Clinic — `not_tracked`

```sql
with b as (
  insert into businesses (name, address, phone, timezone, hours_text, business_slug)
  values ('Sunrise Dental Clinic', '45 Park Street, Kolkata, West Bengal 700016', '+91REPLACE_WITH_TEST_PHONE',
          'Asia/Kolkata', 'Mon-Sat, 10:00 AM-6:00 PM', 'sunrise-dental-test')
  returning id
),
s as (
  insert into services (business_id, name, duration_minutes, price_disclosure, bookable)
  select id, 'Dental Checkup', 30, 'not_disclosed', true from b
)
insert into business_settings (business_id, industry, booking_enabled, availability_source, callback_number, callback_notify_channel)
select id, 'clinic', false, 'not_tracked', '+91REPLACE_WITH_TEST_PHONE', 'sms' from b;
```

```bash
curl -s -X POST http://localhost:5678/webhook-test/get-availability \
  -H 'Content-Type: application/json' \
  -d '{ "business_id": "sunrise-dental-test", "service_or_staff": "Dental Checkup", "preferred_date": "2026-08-03" }'
# -> 200, "source": "not_tracked", "available": false, "slots": [] -- never guesses a time

curl -s -X POST http://localhost:5678/webhook-test/create-booking \
  -H 'Content-Type: application/json' \
  -d '{ "business_id": "sunrise-dental-test", "customer_name": "Test Caller", "phone": "919900011122",
       "service": "Dental Checkup", "selected_slot": "2026-08-03T11:00:00+05:30" }'
# -> 403 booking_disabled -- this business has booking_enabled: false

curl -s -X POST http://localhost:5678/webhook-test/create-callback-request \
  -H 'Content-Type: application/json' \
  -d '{ "business_id": "sunrise-dental-test", "customer_name": "Test Caller", "phone": "919900011122",
       "reason": "Wants to book a checkup, clinic does not take phone bookings" }'
# -> 200, received: true -- the correct path for this business
```

Both fixtures also exercise the multi-tenant boundary: try `get_business_info`
or `get_availability` for `lumen-salon-01` right after inserting these and
confirm the response never contains PowerHouse or Sunrise data, and vice
versa.

---

## 8. Booking is calendar-optional per business

`create_booking` no longer assumes every business has Google Calendar
connected. After the duplicate check, it always checks the `appointments`
table itself for a time overlap for that business (this is the real
source of truth regardless of calendar), and **only** additionally
re-checks/writes to Google Calendar when
`business_settings.availability_source = 'google_calendar'` **and**
`calendar_id` is set. A `staff_roster` or `not_tracked` business with
`booking_enabled: true` can still take phone bookings — they're written
straight to `appointments` with `calendar_event_id: null`.

---

## 9. Manual end-to-end checklist

**Setup**

- [ ] `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` set in n8n's environment.
- [ ] All three SQL files run in order (`0001_init.sql`, `0002_multi_business.sql`, `seed.sql`).
- [ ] Supabase **Table Editor** shows one `businesses` row (`lumen-salon-01`), four `services` rows, one `business_settings` row, three `faqs`, two `staff`, and their `staff_availability` rows.
- [ ] All nine workflows imported and saved.
- [ ] Google credential created and selected on every Google Calendar node (only needed for the `google_calendar` path).
- [ ] Header Auth credential created and selected on all nine Webhook nodes (see "Header Auth" above) — every webhook returns 403 until this is done.

**Tenant isolation**

- [ ] `get_business_info` with an unregistered `business_id` → 404 `unknown_business`, not a 500 or a default business.
- [ ] Insert the gym and clinic fixtures above; confirm each business's `get_business_info`/`get_availability` responses never leak the other's data.
- [ ] `log_call` with a `booking_id` that belongs to a different business → `booking_link: "not_found"`, not linked.
- [ ] Remember (don't test — there's nothing to click) that all of the above is data-scoping, not caller authentication: see "This is not production tenant isolation" above.

**transfer_to_human**

- [ ] With Lumen Salon's seeded (placeholder) `transfer_number`: `transfer_reason: "complaint"` → 200, `decision: "callback_fallback"`, `transfer_number: null`.
- [ ] `UPDATE business_settings SET transfer_number = '+15035550100' WHERE business_id = (SELECT id FROM businesses WHERE business_slug = 'lumen-salon-01');`, repeat the same request → `decision: "transfer_approved"`, `transfer_number: "+15035550100"`.
- [ ] `transfer_reason: "not_a_real_reason"` → 400 `invalid_input`. Only the five approved categories are ever accepted.
- [ ] `call_id` set to a UUID that doesn't match any `calls` row → `logged: "call_not_found"`, decision still returned normally (this is the expected common case, not a failure).
- [ ] `call_id` set to a non-UUID string (e.g. `"not-a-uuid"`) → `logged: "skipped_non_uuid_call_id"`, decision still returned.
- [ ] Run `log_call` first, take its `call_id`, then call `transfer_to_human` with that same `call_id` → `logged: "logged"`, and a `call_events` row appears with `event_type = 'transfer_triggered'` and an `event_data` containing only `{ reason, decision }` — no phone number, no name.

**Happy path (Lumen Salon, after pointing `calendar_id` at a real test calendar)**

- [ ] `get_availability` for `Haircut` on an empty weekday returns 2–3 slots.
- [ ] `create_booking` with one of those slots returns `confirmed: true`.
- [ ] The event appears on the configured calendar; a row appears in `appointments` with a matching `calendar_event_id`.
- [ ] `log_call` with that `booking_id` returns `booking_link: "linked"`.

**Booking-optional / availability-source coverage**

- [ ] Gym fixture (`staff_roster`): `get_availability` returns slots sourced from `staff_availability`; `create_booking` succeeds with `calendar_event_id: null`.
- [ ] Clinic fixture (`not_tracked`, `booking_enabled: false`): `get_availability` returns `available: false`; `create_booking` returns 403; `create_callback_request` succeeds.

**Rejections**

- [ ] `create_booking` for `"Hair color"` (not bookable) → 409 `service_not_bookable`.
- [ ] `get_service_or_price_info` for a made-up service → 404 `unknown_service`.
- [ ] `log_call` with `"outcome": "kind of booked"` → 400. Unrecognised values are rejected, not coerced.

**Failure honesty**

- [ ] Temporarily break Supabase (`SUPABASE_URL=http://localhost:9`), run `create_booking` → 502, `confirmed: false`, and any calendar event it created is rolled back.
- [ ] Confirm no response anywhere in these failure cases contains `"confirmed": true`.

**Going live locally**

- [ ] Switch each workflow's **Active** toggle on and re-run one request per workflow against `/webhook/` (not `/webhook-test/`).
- [ ] Delete the gym/clinic test fixtures and any test rows from `appointments`/`calls`/`callback_requests` when done.

---

## 10. Vapi tool gateway (Phase 5.7)

`apps/dashboard/src/app/api/vapi/tool-calls` (and a second route,
`.../transfer-destination`, for the transfer-audit hook — see below) is a
Next.js Route Handler that sits between Vapi and these nine n8n webhooks.
It exists because "the caller supplies `business_id` and n8n trusts it" —
which is all section 4 could offer before this phase — is not enough for
a real deployment: the LLM must never be able to choose or override
`business_id`, `caller_number`, or `call_id`, and n8n itself has no way to
verify a request genuinely came from Vapi. Both are now the gateway's job.
It is server-only code (a Next.js Route Handler, never shipped to the
browser) and reads no secret from a `NEXT_PUBLIC_`-prefixed env var — see
`.env.example` for the full list it needs.

### Request flow

1. **Vapi calls the gateway**, not n8n directly. Every function tool in
   `config/vapi-tools.json` has `server.url` pointing at
   `.../api/vapi/tool-calls` (the same URL for all six — the gateway
   dispatches internally on `function.name`).
2. **The gateway verifies the request is really from Vapi** —
   `verifyVapiSignature` in `src/lib/vapi-gateway.ts` checks an
   HMAC-SHA256 signature (`VAPI_WEBHOOK_SECRET`) in constant time
   (`node:crypto`'s `timingSafeEqual`, so a wrong signature doesn't
   respond measurably faster or slower depending on how wrong), and, if a
   timestamp header is present, rejects anything older than
   `VAPI_SIGNATURE_MAX_SKEW_SECONDS` (default 300s) as an expired/replayed
   request. If `VAPI_WEBHOOK_SECRET` isn't configured at all, the gateway
   fails **closed** — every request gets 503, never silently unauthenticated.
3. **The gateway resolves the business itself** — `resolveBusinessFromVapiIdentity`
   reads the assistant id and/or phone number id out of Vapi's own call
   metadata (not the request body's claimed `business_id` — there isn't
   one anymore, see step 5) and looks it up in `vapi_business_map`
   (`supabase/migrations/0003_vapi_gateway.sql`) using the service-role
   Supabase client (`src/lib/supabase-admin.ts`). No match, for any
   reason (unmapped assistant/number, Supabase unreachable), means every
   tool call in the request gets a `business_not_mapped` result — never a
   default or guessed business.
4. **The gateway strips and replaces trusted fields** —
   `sanitizeToolArguments` unconditionally deletes `business_id`,
   `caller_number`, and `call_id` from whatever the LLM's tool-call
   arguments contained (they're not even in the tool's parameter schema
   anymore, so a well-behaved model won't send them — this strips them
   regardless, in case it does), then `buildN8nRequestBody` sets all three
   from the server-resolved values before forwarding.
5. **The gateway calls the correct n8n workflow** via `TOOL_ROUTES`
   (`get_business_info` → `get-business-info`, etc.), attaching the
   internal `N8N_GATEWAY_SHARED_SECRET` header n8n's Header Auth checks
   (section 3) — a request that reaches n8n without this header, from
   anywhere, is rejected before any workflow logic runs.
6. **The gateway returns Vapi's expected result shape** —
   `{ "results": [{ "toolCallId": "...", "result": "<json-or-plain-string>" }] }`,
   one entry per tool call in the request, with `toolCallId` copied
   exactly from the incoming call so Vapi can match each result back to
   the tool call that produced it.

### transfer_to_human stays native — the transfer-destination route is separate

`transfer_to_human` in `config/vapi-tools.json` is still a native Vapi
`transferCall` tool with a static fallback `destinations` number — Vapi
performs the actual call transfer itself, and (unlike the six `function`
tools above) it does not call the gateway to do so. What routes through
n8n's audited `transfer_to_human.json` workflow instead is a *second,
separate* route, `.../api/vapi/transfer-destination`, wired to the
assistant-level "ask my server for the transfer destination" mechanism
Vapi documents (commonly called a transfer-destination-request server
message; configured on the assistant itself in the Vapi dashboard, not
inside `config/vapi-tools.json`'s per-tool `server.url`). Same
authentication, same business resolution — then it calls
`n8n/workflows/transfer_to_human.json` for the actual approve/fallback
decision and only returns a transfer destination if that workflow
approved one.

**This is the one piece of this phase built against an unverified payload
shape.** `apps/dashboard/src/app/api/vapi/transfer-destination/route.ts`'s
file header spells out exactly what's assumed versus confirmed — no live
Vapi account exists in this repo to capture a real
transfer-destination-request payload against. What's load-bearing and
does NOT depend on getting that shape exactly right on the first try:
authentication, business resolution, and the fact that a transfer is
never approved without n8n's decision saying so.

### Configuration

See `.env.example` for the full list with comments
(`VAPI_WEBHOOK_SECRET`, `VAPI_SIGNATURE_HEADER`/`VAPI_TIMESTAMP_HEADER`/
`VAPI_SIGNATURE_MAX_SKEW_SECONDS`, `N8N_GATEWAY_SHARED_SECRET`/
`N8N_GATEWAY_HEADER_NAME`, `N8N_BASE_URL`). All of it is server-side only
— set it in `apps/dashboard/.env.local` (gitignored) or your deployment
platform's server env config, never in a `NEXT_PUBLIC_` variable.

### Mapping a business (`vapi_business_map`)

Before any call for a business can succeed, insert a mapping row (no
dashboard UI for this yet — direct SQL, same as the rest of onboarding):

```sql
insert into vapi_business_map (business_id, vapi_assistant_id, label)
values (
  (select id from businesses where business_slug = 'lumen-salon-01'),
  'REPLACE_WITH_REAL_VAPI_ASSISTANT_ID',
  'Lumen Salon primary assistant'
);
```

Use `vapi_phone_number_id` instead (or as well) if you'd rather map by
phone number id. Both columns are individually unique — the database
itself rejects mapping the same assistant or phone number id to two
businesses (`vapi_business_map_assistant_id_key` /
`_phone_number_id_key`), which is the "enforce uniqueness and prevent
cross-business access" requirement this table exists to satisfy.

### Testing without a live Vapi account

Everything below can be exercised with `curl` and a hand-computed HMAC
signature — none of it needs a real Vapi call.

**1. Invalid auth is rejected**

```bash
# No signature header at all -> 401 missing_signature
curl -s -i -X POST http://localhost:3000/api/vapi/tool-calls \
  -H 'Content-Type: application/json' \
  -d '{"message":{"type":"tool-calls","toolCalls":[]}}'

# Wrong signature -> 401 signature_mismatch
curl -s -i -X POST http://localhost:3000/api/vapi/tool-calls \
  -H 'Content-Type: application/json' \
  -H 'x-vapi-signature: 0000000000000000000000000000000000000000000000000000000000000000' \
  -d '{"message":{"type":"tool-calls","toolCalls":[]}}'
```

Compute a *correct* signature to see the difference (bash + openssl):

```bash
BODY='{"message":{"type":"tool-calls","toolCalls":[],"call":{"id":"11111111-1111-4111-8111-111111111111","assistantId":"REPLACE_WITH_MAPPED_ASSISTANT_ID","customer":{"number":"+15035550142"}}}}}'
SECRET="$VAPI_WEBHOOK_SECRET"
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -s -i -X POST http://localhost:3000/api/vapi/tool-calls \
  -H 'Content-Type: application/json' \
  -H "x-vapi-signature: $SIG" \
  -d "$BODY"
# -> 400 no_tool_calls (auth passed; there's nothing to route — expected for this empty example)
```

**2. A valid request routes only to its mapped business**

Sign a request whose `toolCalls` includes `get_business_info` and whose
`call.assistantId` matches a row you inserted into `vapi_business_map`.
Confirm the forwarded n8n response is for that exact business (check the
`business_id`/name fields in the JSON-encoded `result` string) — then
change nothing except the mapping row's `business_id` and repeat, and
confirm the response changes accordingly. No field in the request itself
should have needed to change.

**3. Attempts to supply another business_id are ignored**

Add `"business_id": "some-other-business-slug"` inside a tool call's
`function.arguments` in the signed payload above (recompute the
signature, since the body changed) and confirm the response is still for
the assistant-mapped business, not `"some-other-business-slug"` — the
gateway strips that key before it ever reaches n8n. Do the same with
`caller_number`/`call_id` inside `arguments` and confirm the forwarded
values still come from `message.call`, not from `arguments`.

**4. Direct n8n webhook access is rejected**

```bash
curl -s -i -X POST http://localhost:5678/webhook/get-business-info \
  -H 'Content-Type: application/json' \
  -d '{"business_id":"lumen-salon-01"}'
```

→ 403 from n8n's Header Auth, before the workflow's own `business_id`
validation ever runs — this is true whether or not `lumen-salon-01`
would otherwise be a valid `business_id`, confirming the block is at the
authentication layer, not the application layer.

**5. Vapi tool response format is correct**

For any successfully-routed request, confirm the JSON response is
exactly `{ "results": [...] }`, each entry has both `toolCallId` (matching
the request's tool call id) and a string `result` (JSON-encoded if the
underlying n8n response was an object), and that a request with more than
one tool call in `toolCallList`/`toolCalls` produces one result per call,
in the gateway's processing order.

### Automated tests

`apps/dashboard/src/lib/vapi-gateway.test.ts` covers the pure logic
above — signature verification (valid, missing, wrong, expired,
malformed), argument sanitization (trusted keys always stripped,
non-object/string-JSON inputs handled), payload parsing, and tool
routing — without needing a running server, Supabase, or Vapi. Run it
with:

```bash
cd apps/dashboard
npm run test:gateway
```

This does not replace the manual `curl` checklist above, which is the
only way to exercise the actual HTTP layer (headers, status codes,
route wiring) end to end.

---

## What's deliberately not here

- **No live Vapi account.** The gateway is fully wired and testable with hand-signed `curl` requests (section 10), but nothing here has been exercised against a real Vapi call, and `transfer-destination`'s payload shape is explicitly unverified — see that route's file header.
- **No phone number and no live SMS/WhatsApp.** `send_confirmation`'s Twilio node is a stub; `callback_notify_channel`/`confirmation_channel` are recorded preferences, not working notifications.
- **No deployment config.** n8n's URLs are localhost only; the gateway's own base URL is whatever you run `npm run dev` on. `N8N_BASE_URL` and the gateway's own public URL are both still placeholders.
- **No real customer data.** Every example above uses a fictional name and number.
- **No dashboard UI for `vapi_business_map`.** Mapping a business is direct SQL (see "Mapping a business" above), matching how the rest of onboarding already works.
- **No role-based staff-to-service matching.** `staff.services` is advisory; `get_availability`'s `staff_roster` path matches a named staff member if one was given, otherwise unions every active staff member's availability rather than strictly filtering by service.

## Known simplifications

- **Country-agnostic phone normalization.** Phase 3 assumed a 10-digit US
  number and prefixed `+1`. That doesn't generalize to Indian or other
  international businesses, so `create_booking` and `create_callback_request`
  now just strip non-digits and prefix `+`, trusting the caller's digits
  already include a country code (7–15 digits total). This is a
  deliberate behavior change, not an oversight — a bare 10-digit Indian
  mobile number without `91` will normalize incorrectly. A future phase
  could add a per-business default country code to `business_settings`.
- **`staff_roster` availability doesn't enforce service-to-staff matching.**
  See "What's deliberately not here" above.
- **Business hours and price policy are `jsonb`, not validated beyond
  their CHECK constraints.** A business owner (or, right now, whoever
  runs the seed/onboarding SQL) is trusted to enter a well-formed
  `opening_hours`/`price_policy` shape; a malformed one falls back to
  workflow defaults rather than erroring loudly.
- **The duplicate check is exact-match** on phone + service + slot start,
  scoped to the resolved business. A caller booking 2:00 PM and then
  2:15 PM the same day gets two bookings, which is correct — they are
  different appointments.
- **`email` is never stored.** `appointments` has no email column.
