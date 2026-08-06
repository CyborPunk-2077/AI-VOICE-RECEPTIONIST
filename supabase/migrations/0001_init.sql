-- ReceptionFlow — initial schema
-- Fictional salon portfolio project. Public demo: no auth, read-only via RLS.
-- Run this once in the Supabase SQL editor (see docs/database.md).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------
create table if not exists businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null,
  phone text not null,
  timezone text not null default 'America/Los_Angeles',
  hours_text text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- services (exactly 3 rows for this demo, enforced by app/seed, not the DB)
-- ---------------------------------------------------------------------------
create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists services_business_id_idx on services(business_id);

-- ---------------------------------------------------------------------------
-- calls
-- ---------------------------------------------------------------------------
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  caller_name text,
  caller_number text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer,
  intent text check (intent in ('FAQ', 'Booking', 'Transfer')),
  outcome text check (outcome in ('FAQ Answered', 'Booked', 'Transferred', 'No Match')),
  summary text,
  transfer_reason text,
  created_at timestamptz not null default now()
);

create index if not exists calls_business_id_started_at_idx on calls(business_id, started_at desc);

-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  service_id uuid not null references services(id) on delete restrict,
  call_id uuid references calls(id) on delete set null,
  customer_name text not null,
  customer_phone text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  status text not null default 'Confirmed' check (status in ('Confirmed', 'Completed', 'Cancelled')),
  calendar_event_id text,
  created_at timestamptz not null default now(),
  constraint appointments_end_after_start check (end_time > start_time)
);

create index if not exists appointments_business_id_start_time_idx on appointments(business_id, start_time);
create index if not exists appointments_service_id_idx on appointments(service_id);
create index if not exists appointments_call_id_idx on appointments(call_id);

-- ---------------------------------------------------------------------------
-- call_events — granular, auditable trail for each automated decision
-- (faq_answered, faq_no_match, booking_attempt, booking_confirmed,
--  transfer_triggered, etc.) tied back to a call.
-- ---------------------------------------------------------------------------
create table if not exists call_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  event_type text not null,
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists call_events_call_id_idx on call_events(call_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Public fictional demo: anyone with the publishable (anon) key can read.
-- No insert/update/delete policies are defined for anon/authenticated, so
-- writes are denied by default under RLS. Only the service-role key
-- (used server-side by n8n later, never by the dashboard) can write.
-- ---------------------------------------------------------------------------
alter table businesses enable row level security;
alter table services enable row level security;
alter table calls enable row level security;
alter table appointments enable row level security;
alter table call_events enable row level security;

create policy "Public read access" on businesses
  for select to anon, authenticated using (true);

create policy "Public read access" on services
  for select to anon, authenticated using (true);

create policy "Public read access" on calls
  for select to anon, authenticated using (true);

create policy "Public read access" on appointments
  for select to anon, authenticated using (true);

create policy "Public read access" on call_events
  for select to anon, authenticated using (true);
