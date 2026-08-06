# Database setup

This dashboard reads from Supabase (Postgres) for the Overview, Calls, and
Appointments pages. Nothing else in this repo (Settings, auth, Twilio) is
connected yet — see `docs/todo.md` for what's next. n8n is connected: it
reads/writes this schema server-side using the service-role key, described
in `docs/n8n-setup.md`. As of Phase 5.7, the dashboard app's own server-side
code (not its pages — its API route handlers) is also connected: the Vapi
tool gateway under `apps/dashboard/src/app/api/vapi/` reads
`vapi_business_map` with that same service-role key — see "The Vapi
gateway's table" below and `docs/n8n-setup.md` section 10.

## 1. Run the migrations in Supabase

You need a Supabase project (create one at supabase.com if you haven't).
Then, in your project's **SQL Editor**, run these four files **in order**:

1. `supabase/migrations/0001_init.sql` — creates `businesses`, `services`,
   `calls`, `appointments`, and `call_events`, plus read-only Row Level
   Security policies appropriate for a public demo (anyone with the
   publishable key can `SELECT`; nothing can write except the service-role
   key).
2. `supabase/migrations/0002_multi_business.sql` — the multi-business
   backend. Adds `business_slug` (the public identifier every n8n webhook
   and Vapi tool call addresses a business by — `businesses.id` stays the
   internal primary key every other table's `business_id` points at),
   price/bookability columns on `services`, and five new tables:
   `business_settings`, `faqs`, `staff`, `staff_availability`, and
   `callback_requests`. It also widens the `calls` table's `intent`/`outcome`
   CHECK constraints to a superset of the original values (see "Widened
   `calls` vocabulary" below) and adds a nullable `staff_id` to
   `appointments`. It is additive and safe to run against a database that
   already has 0001 + the old seed applied — nothing is dropped or renamed.
3. `supabase/seed.sql` — inserts one fictional salon ("Lumen Salon") with
   its full multi-business shape: the business row (now with
   `business_slug = 'lumen-salon-01'`), four services (three bookable, one
   intentionally not — see below), a `business_settings` row, three
   approved FAQs, a two-person staff roster, and each staff member's
   weekly `staff_availability`. No calls, appointments, or
   callback_requests are seeded, so you'll see the dashboard's empty states
   until real rows exist. **No real customer data is ever included in this
   file.**
4. `supabase/migrations/0003_vapi_gateway.sql` — adds `vapi_business_map`,
   the table that maps a Vapi assistant id and/or phone number id to
   exactly one business. Needed before the Vapi tool gateway
   (`docs/n8n-setup.md` section 10) can resolve any business; the rest of
   this repo works without it.

Paste each file's contents into the SQL Editor and run it top to bottom, in
the order above — 0002 depends on 0001's tables existing, the seed depends
on 0002's `business_slug` column and new tables, and 0003 depends on 0001's
`businesses` table (it can technically run any time after 0001, but the
order above keeps things simple).

## 2. Schema overview

| Table | Purpose | Added in |
|---|---|---|
| `businesses` | One row per business: name, address, phone, timezone, and the public `business_slug` every tool call resolves against. | 0001 (`business_slug` added in 0002) |
| `services` | This business's services: name, duration, and (as of 0002) `price_disclosure`/`price_amount`/`price_range`/`bookable`. | 0001 (price/bookable columns in 0002) |
| `business_settings` | One row per business: locale, opening hours, price policy, booking/callback/transfer config, restricted topics, and `availability_source`. | 0002 |
| `faqs` | This business's approved FAQ list — anything not here is a "no match," never improvised. | 0002 |
| `staff` | Lightweight roster: name, role, and which services they're associated with. | 0002 |
| `staff_availability` | Recurring weekly windows per staff member, used when `availability_source = 'staff_roster'`. | 0002 |
| `callback_requests` | Leads/callbacks recorded by `create_callback_request` — not an appointment, no calendar event. | 0002 |
| `calls` | One row per phone call: intent, outcome, summary, duration. | 0001 (CHECK constraints widened in 0002) |
| `appointments` | Bookings: service, customer, time range, status, calendar event id, and (as of 0002) an optional `staff_id`. | 0001 (`staff_id` added in 0002) |
| `call_events` | Granular audit trail tied to a call. | 0001 |
| `vapi_business_map` | Maps a Vapi assistant id and/or phone number id to exactly one business — the Vapi tool gateway's only source of truth for `business_id`. | 0003 |

### The Vapi gateway's table (`vapi_business_map`)

Deliberately **not** public-read like every other table above. Every
other table in this schema has an anon-readable RLS policy (portfolio
demo posture — see "Row Level Security" in `0001_init.sql`); this one has
RLS enabled with **no policies at all**, so it denies all access by
default and only the service-role key can read or write it. Assistant and
phone-number ids aren't secrets on their own, but they're the exact join
key an attacker would want in order to map a business_id to a live phone
number, and no dashboard page needs to read this table.

Each of `vapi_assistant_id` and `vapi_phone_number_id` is individually
unique (partial unique indexes, `where ... is not null`) — the same
assistant or phone number can never be mapped to two different
businesses, enforced by the database, not just application code. A
business may have more than one row (e.g. two phone numbers routing to
the same business).

See `docs/n8n-setup.md` section 10 ("Vapi tool gateway") for how this
table is populated (direct SQL — no dashboard UI for it yet) and used at
request time.

### Why `business_slug` exists

`businesses.id` is a uuid — the internal primary key every other table's
`business_id` foreign key points at. It is never exposed to Vapi or typed
by a business owner. `business_slug` (e.g. `lumen-salon-01`) is the public,
human-chosen identifier every Vapi tool call and n8n webhook actually
carries as `business_id` in its request body. Every workflow resolves
`business_slug -> id` first, then filters every subsequent query by the
resolved uuid — see `docs/n8n-setup.md` for how this is enforced per
webhook.

### `business_settings.opening_hours` and `price_policy` shapes

Both are `jsonb`, matching the corresponding fields in
`config/business-profile.example.json`:

```json
// opening_hours
{
  "schedule": [
    { "day": "Monday", "closed": false, "open": "09:00", "close": "19:00" },
    { "day": "Sunday", "closed": true }
    // ... one entry per day
  ],
  "break": { "start": "14:00", "end": "15:00" }
}

// price_policy
{
  "default_disclosure": "exact",
  "disclaimer_note": "Prices may vary with hair length, product used, or stylist seniority."
}
```

An empty `{}` (the column default) means "not configured yet" — n8n
workflows fall back to a Mon–Sat 09:00–19:00, closed-Sunday default rather
than guessing a business's real hours; see `docs/n8n-setup.md`.

### `availability_source` and what each value means

| Value | What `get_availability` does |
|---|---|
| `google_calendar` | Reads busy events from `business_settings.calendar_id`, same algorithm as the legacy `get_available_slots`. |
| `staff_roster` | Matches a named (or, if none named, any active) staff member against `staff_availability`, minus conflicting `appointments`. |
| `not_tracked` | Always responds `available: false` with no slots — **never guesses a time**. The assistant is instructed to fall through to `create_callback_request`. |

### Widened `calls` vocabulary

0002 widens the `intent`/`outcome` CHECK constraints to a **superset** of
the original values — nothing is removed, so existing rows and any code
still sending the Phase-1 salon vocabulary keep working:

- `intent`: `FAQ`, `Booking`, `Transfer` (original) plus `Info`, `Callback` (new)
- `outcome`: `FAQ Answered`, `Booked`, `Transferred`, `No Match` (original) plus `Info Provided`, `Callback Requested` (new)

### Tenant isolation

Every table that carries business-specific data has a `business_id`
(or, for `staff_availability`/`callback_requests`, a `business_id` plus a
foreign key to a business-scoped parent row). Every n8n workflow resolves
`business_id` from the caller's `business_slug` before running any other
query, and every subsequent read/write is filtered by that resolved uuid —
see `docs/n8n-setup.md` for the enforcement details per webhook. No
workflow queries any table without a business filter.

As of Phase 5.7, `business_slug` itself is no longer taken on faith from
an arbitrary caller either: the Vapi tool gateway resolves it server-side
from `vapi_business_map`, using Vapi's own call metadata, before n8n is
ever called — see `docs/n8n-setup.md` sections 4 and 10 for the full
before/after picture and what still isn't verified against a live Vapi
account.

## 3. Add your Project URL and Publishable Key

In Supabase: **Project Settings → API**. Copy the **Project URL** and the
**Publishable key** (the public, anon-safe key — not the service-role key).

Paste them into `apps/dashboard/.env.local`, replacing the placeholders:

```
NEXT_PUBLIC_SUPABASE_URL=YOUR_SUPABASE_PROJECT_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

This file is gitignored — your keys never get committed. `.env.example` at
the repo root documents the same variables without real values, for
reference.

If you're also setting up the Vapi tool gateway (`docs/n8n-setup.md`
section 10), add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to this
same `.env.local` file too — the gateway's route handlers need
service-role access to read `vapi_business_map`, which the publishable
key above cannot see. Both are already documented in `.env.example`;
before this phase they were only ever needed by n8n's own environment.

## 4. Confirm the connection works

From `apps/dashboard`:

```
npm install
npm run dev
```

Open `/overview`, `/calls`, or `/appointments`:

- If the URL/key are still placeholders or wrong, you'll see an in-page
  error state explaining that Supabase isn't configured — no crash.
- If they're correct but a table has no rows (e.g. `calls` before any
  seeded activity), you'll see an empty state instead of a blank page.
- Once the migrations and seed have run, `/appointments` should show the
  seeded services even before any bookings exist.

If something looks wrong, check the Supabase project's **Table Editor** to
confirm the migrations and seed actually ran, and double-check you copied
the *Publishable* key, not the service-role key (the dashboard never uses
the service-role key).

## 5. Known limitations

- The dashboard's queries (`apps/dashboard/src/lib/queries.ts`) still read
  every row across all businesses — there is no business-scoped dashboard
  view or auth yet (see `docs/todo.md`). This is a demo/read-only-anon
  posture already in place since Phase 1; it hasn't changed here.
- `callback_requests` carries fictional caller-contact fields under the
  same public-read RLS policy `calls`/`appointments` already used in 0001.
  No real customer data is ever seeded, so this remains safe for a
  portfolio project, but it is not a pattern to copy into a real product.
- No dashboard UI exists yet for managing `vapi_business_map` rows —
  mapping a business to a Vapi assistant/phone number is direct SQL (see
  `docs/n8n-setup.md` section 10), same as the rest of onboarding.
