-- ReceptionFlow — Vapi gateway business mapping (Phase 5.7)
-- Adds the one piece of server-side trust the n8n workflows alone can't
-- provide: a durable mapping from a Vapi-side identity (assistant id
-- and/or phone number id — values Vapi itself attaches to a call, which
-- the caller cannot influence) to exactly one business. The Next.js
-- gateway (apps/dashboard/src/app/api/vapi/*) resolves business_id from
-- this table using trusted call metadata, never from anything the LLM or
-- caller supplied — see docs/n8n-setup.md "Tenant isolation" for the
-- full trust model this closes.
--
-- Run this once, after 0001_init.sql and 0002_multi_business.sql, in the
-- Supabase SQL editor. Additive; nothing is dropped or renamed.

create table if not exists vapi_business_map (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  -- Vapi's assistant id and/or phone number id (both opaque strings Vapi
  -- assigns, e.g. "asst_..." / a phone number's own uuid — exact shape
  -- depends on Vapi's current API and isn't invented here). At least one
  -- must be set; a row can set both if this business's assistant is only
  -- ever reached via one specific number, for a slightly tighter check.
  vapi_assistant_id text,
  vapi_phone_number_id text,
  label text, -- optional human note, e.g. "Lumen Salon primary line"
  created_at timestamptz not null default now(),
  constraint vapi_business_map_has_identifier
    check (vapi_assistant_id is not null or vapi_phone_number_id is not null)
);

-- One business per identifier, enforced at the database level (not just
-- application logic): the same Vapi assistant or phone number can never
-- be mapped to two different businesses. A business MAY have more than
-- one row (e.g. two phone numbers routing to the same business), so
-- uniqueness is per-identifier, not per-business.
create unique index if not exists vapi_business_map_assistant_id_key
  on vapi_business_map(vapi_assistant_id) where vapi_assistant_id is not null;
create unique index if not exists vapi_business_map_phone_number_id_key
  on vapi_business_map(vapi_phone_number_id) where vapi_phone_number_id is not null;
create index if not exists vapi_business_map_business_id_idx
  on vapi_business_map(business_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — deliberately NOT the "public read" posture every
-- other table in this schema uses. Assistant/phone-number identifiers are
-- not secrets, but they are the exact join key an attacker would want in
-- order to guess which business_id maps to which live phone number, and
-- there is no dashboard feature that needs to read this table with the
-- anon/publishable key. RLS is enabled with NO select policy for
-- anon/authenticated, so it denies all access by default; only the
-- service-role key (used server-side by the Next.js gateway, same key
-- n8n already uses — see docs/n8n-setup.md) can read or write it.
-- ---------------------------------------------------------------------------
alter table vapi_business_map enable row level security;
-- No policies created on purpose — see comment above.
