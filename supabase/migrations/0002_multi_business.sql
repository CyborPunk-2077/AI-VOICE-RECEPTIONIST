-- ReceptionFlow — multi-business backend
-- Adds everything needed to serve more than one business from the same
-- Supabase project + n8n instance: a public slug businesses are addressed
-- by (the `business_id` every Vapi tool call carries), per-business
-- settings (locale, hours, booking/callback/transfer config, availability
-- source), approved FAQs, a lightweight staff roster + weekly
-- availability, and callback/lead requests. Also widens the `calls`
-- CHECK constraints so the generic intent/outcome values used by the
-- template's `log_call` tool (Info, Callback, Callback Requested, ...)
-- can be written safely, without dropping the original salon-specific
-- values already in use.
--
-- Run this once, after 0001_init.sql, in the Supabase SQL editor. It is
-- additive: nothing in 0001 is dropped or renamed, so existing rows and
-- the dashboard's existing reads keep working unchanged.

-- ---------------------------------------------------------------------------
-- businesses — add the public slug every n8n workflow resolves business_id
-- against. `id` (uuid) stays the internal primary key every other table's
-- business_id foreign key points at; `business_slug` is the human-chosen,
-- external identifier (e.g. "lumen-salon-blr-01") that Vapi tool calls
-- actually carry. Every workflow looks up business_slug -> id first, then
-- filters everything else by the resolved uuid -- callers never address a
-- row by its internal id directly.
-- ---------------------------------------------------------------------------
alter table businesses add column if not exists business_slug text;

-- Backfill the already-seeded demo business so this migration is safe to
-- run against a database that already has the Phase-1 seed applied. A
-- fresh install's supabase/seed.sql now sets this directly.
update businesses set business_slug = 'lumen-salon-01'
where business_slug is null and name = 'Lumen Salon';

-- Any other pre-existing business without a slug gets a generated
-- placeholder rather than blocking the migration; rename it before
-- pointing real tools at it.
update businesses set business_slug = 'business-' || substr(id::text, 1, 8)
where business_slug is null;

alter table businesses alter column business_slug set not null;
create unique index if not exists businesses_business_slug_key on businesses(business_slug);

-- ---------------------------------------------------------------------------
-- services — price + bookability fields the original schema didn't need
-- (Phase 1 had exactly three fixed, always-bookable services). The
-- template's get_service_or_price_info and create_booking_optional need
-- per-service price disclosure and a bookable flag (see svc-color in
-- config/business-profile.example.json — a real service that is
-- intentionally NOT phone-bookable).
-- ---------------------------------------------------------------------------
alter table services add column if not exists price_disclosure text not null default 'not_disclosed'
  check (price_disclosure in ('exact', 'range', 'not_disclosed'));
alter table services add column if not exists price_amount numeric;
alter table services add column if not exists price_range text;
alter table services add column if not exists bookable boolean not null default true;

-- ---------------------------------------------------------------------------
-- business_settings — one row per business. Everything here is
-- per-business *configuration* (as opposed to `businesses`, which is
-- basic identity: name/address/phone/timezone). Split out into its own
-- table so 0001's businesses shape doesn't need heavy alteration and so a
-- business can exist (e.g. mid-onboarding) before its settings are final.
-- ---------------------------------------------------------------------------
create table if not exists business_settings (
  business_id uuid primary key references businesses(id) on delete cascade,
  industry text,
  languages_supported jsonb not null default '["English"]'::jsonb,
  default_language text not null default 'English',
  currency text not null default 'INR',
  directions_note text,
  opening_hours jsonb not null default '{}'::jsonb,
  -- opening_hours shape: { "schedule": [ { "day": "Monday", "closed": false, "open": "09:00", "close": "19:00" }, ... 7 days ... ], "break": { "start": "14:00", "end": "15:00" } | null }
  -- An empty object means "not configured"; workflows fall back to a
  -- Mon-Sat 09:00-19:00, closed-Sunday default rather than guessing.
  price_policy jsonb not null default '{}'::jsonb,
  -- price_policy shape: { "default_disclosure": "exact" | "range" | "not_disclosed", "disclaimer_note": text | null }
  booking_enabled boolean not null default false,
  confirmation_channel text not null default 'none' check (confirmation_channel in ('sms', 'whatsapp', 'none')),
  callback_number text,
  callback_notify_channel text not null default 'none' check (callback_notify_channel in ('sms', 'whatsapp', 'none')),
  transfer_number text,
  restricted_topics jsonb not null default '[]'::jsonb,
  availability_source text not null default 'not_tracked'
    check (availability_source in ('google_calendar', 'staff_roster', 'not_tracked')),
  calendar_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- faqs — the approved, business-scoped FAQ list. Anything not here is a
-- "no match" the assistant must not improvise an answer to (see
-- config/vapi-system-prompt.md's never-invent rules).
-- ---------------------------------------------------------------------------
create table if not exists faqs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  question text not null,
  answer text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists faqs_business_id_idx on faqs(business_id) where active;

-- ---------------------------------------------------------------------------
-- staff — lightweight roster, used both to answer "is Priya free" style
-- questions and, for availability.source = staff_roster businesses, as
-- the basis for get_availability's slot computation. `services` is a
-- jsonb array of this business's services.id values this staff member
-- can be booked for; it's advisory (used for a best-effort filter, not a
-- hard constraint) since the template intentionally keeps staff-service
-- matching simple rather than a full scheduling system.
-- ---------------------------------------------------------------------------
create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  role text,
  services jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists staff_business_id_idx on staff(business_id) where active;

-- ---------------------------------------------------------------------------
-- staff_availability — recurring weekly windows per staff member.
-- weekday follows Luxon's convention used throughout the n8n Code nodes:
-- 1 = Monday ... 7 = Sunday (NOT Postgres's own dow numbering) so the
-- same number can be compared directly against `DateTime#weekday`
-- without a conversion step in every workflow.
-- ---------------------------------------------------------------------------
create table if not exists staff_availability (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  staff_id uuid not null references staff(id) on delete cascade,
  weekday integer not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  constraint staff_availability_end_after_start check (end_time > start_time)
);

create index if not exists staff_availability_business_staff_idx on staff_availability(business_id, staff_id);
create index if not exists staff_availability_weekday_idx on staff_availability(business_id, weekday);

-- ---------------------------------------------------------------------------
-- appointments — add an optional staff assignment so a staff_roster
-- business's bookings can be conflict-checked against that staff
-- member's own schedule, not just the business as a whole. Nullable:
-- google_calendar and not_tracked businesses never set it.
-- ---------------------------------------------------------------------------
alter table appointments add column if not exists staff_id uuid references staff(id) on delete set null;
create index if not exists appointments_staff_id_idx on appointments(staff_id) where staff_id is not null;

-- ---------------------------------------------------------------------------
-- callback_requests — create_callback_request's backing table. Not an
-- appointment (no time slot, no calendar event) -- a record that a human
-- at the business needs to follow up, with what the caller wants and how
-- to reach them.
-- ---------------------------------------------------------------------------
create table if not exists callback_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  call_id uuid references calls(id) on delete set null,
  customer_name text not null,
  customer_phone text not null,
  reason text not null,
  preferred_callback_time text,
  status text not null default 'Pending' check (status in ('Pending', 'Contacted', 'Closed')),
  created_at timestamptz not null default now()
);

create index if not exists callback_requests_business_id_idx on callback_requests(business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- calls — widen the intent/outcome CHECK constraints so the template's
-- broader vocabulary (Info, Callback, Callback Requested) can be written,
-- without removing the original salon-specific values already accepted.
-- This is a superset, not a replacement: existing rows and any code still
-- sending the original values keep working.
-- ---------------------------------------------------------------------------
alter table calls drop constraint if exists calls_intent_check;
alter table calls add constraint calls_intent_check
  check (intent in ('FAQ', 'Booking', 'Transfer', 'Info', 'Callback'));

alter table calls drop constraint if exists calls_outcome_check;
alter table calls add constraint calls_outcome_check
  check (outcome in ('FAQ Answered', 'Booked', 'Transferred', 'No Match', 'Info Provided', 'Callback Requested'));

-- ---------------------------------------------------------------------------
-- Row Level Security — same posture as 0001: public fictional demo, so
-- anon/authenticated can SELECT; only the service-role key (used
-- server-side by n8n, never by the dashboard) can write. No real
-- customer data is ever seeded, so this remains safe for a portfolio
-- project. callback_requests carries the same kind of fictional
-- caller-contact fields `calls`/`appointments` already expose under this
-- same policy in 0001 -- consistent, not a new exposure.
-- ---------------------------------------------------------------------------
alter table business_settings enable row level security;
alter table faqs enable row level security;
alter table staff enable row level security;
alter table staff_availability enable row level security;
alter table callback_requests enable row level security;

create policy "Public read access" on business_settings
  for select to anon, authenticated using (true);

create policy "Public read access" on faqs
  for select to anon, authenticated using (true);

create policy "Public read access" on staff
  for select to anon, authenticated using (true);

create policy "Public read access" on staff_availability
  for select to anon, authenticated using (true);

create policy "Public read access" on callback_requests
  for select to anon, authenticated using (true);
