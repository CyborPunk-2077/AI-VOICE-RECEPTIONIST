-- ReceptionFlow — seed data
-- One fictional salon ("Lumen Salon") with the full multi-business shape:
-- business_slug, business_settings, approved FAQs, a small staff roster,
-- and each staff member's weekly availability. No calls, appointments, or
-- callback_requests are seeded so the dashboard's empty states are still
-- visible on first connect, and no real customer data is included anywhere
-- in this file. Run this once, after 0001_init.sql and 0002_multi_business.sql,
-- in the Supabase SQL editor.
--
-- Lumen Salon is the only business this repo seeds. docs/n8n-setup.md has
-- separate, non-seeded example payloads for a fictional gym and clinic —
-- those are curl bodies for manually exercising the other two
-- availability.source branches (staff_roster, not_tracked), not rows
-- inserted here.

with new_business as (
  insert into businesses (name, address, phone, timezone, hours_text, business_slug)
  values (
    'Lumen Salon',
    '214 Birch Street, Portland, OR 97205',
    '(503) 555-0148',
    'America/Los_Angeles',
    'Mon–Sat, 9:00 AM–7:00 PM (closed Sunday)',
    'lumen-salon-01'
  )
  returning id
),
new_services as (
  insert into services (business_id, name, duration_minutes, description, price_disclosure, price_amount, price_range, bookable)
  select id, v.name, v.duration_minutes, v.description, v.price_disclosure, v.price_amount, v.price_range, v.bookable
  from new_business,
    (values
      ('Haircut', 45, 'Wash, cut, and style with a senior stylist.', 'exact', 40::numeric, null, true),
      ('Haircut and beard', 60, 'Haircut plus beard trim and shape-up.', 'exact', 55::numeric, null, true),
      ('Consultation', 30, 'One-on-one consultation to plan a cut, color, or style change.', 'not_disclosed', null::numeric, null, true),
      ('Hair color', 90, 'Global or partial color; product and technique vary by hair length and condition.', 'range', null::numeric, '$120-$350', false)
    ) as v(name, duration_minutes, description, price_disclosure, price_amount, price_range, bookable)
  returning id, name
),
business_settings_row as (
  insert into business_settings (
    business_id, industry, languages_supported, default_language, currency,
    directions_note, opening_hours, price_policy, booking_enabled,
    confirmation_channel, callback_number, callback_notify_channel,
    transfer_number, restricted_topics, availability_source, calendar_id
  )
  select
    id,
    'salon',
    '["English"]'::jsonb,
    'English',
    'USD',
    'Street parking only; look for the green awning next to the coffee shop.',
    '{
      "schedule": [
        { "day": "Monday", "closed": false, "open": "09:00", "close": "19:00" },
        { "day": "Tuesday", "closed": false, "open": "09:00", "close": "19:00" },
        { "day": "Wednesday", "closed": false, "open": "09:00", "close": "19:00" },
        { "day": "Thursday", "closed": false, "open": "09:00", "close": "19:00" },
        { "day": "Friday", "closed": false, "open": "09:00", "close": "19:00" },
        { "day": "Saturday", "closed": false, "open": "09:00", "close": "19:00" },
        { "day": "Sunday", "closed": true }
      ],
      "break": null
    }'::jsonb,
    '{ "default_disclosure": "exact", "disclaimer_note": "Prices may vary with hair length, product used, or stylist seniority." }'::jsonb,
    true,
    'sms',
    'REPLACE_WITH_BUSINESS_NOTIFY_NUMBER',
    'sms',
    'REPLACE_WITH_HUMAN_TRANSFER_NUMBER',
    '["medical, allergy, or health claims about any product or treatment", "legal advice", "guaranteed results of any service", "discounts or pricing not listed in services or price_policy", "anything about staff not listed in the roster"]'::jsonb,
    'google_calendar',
    'REPLACE_WITH_RECEPTIONFLOW_TEST_CALENDAR_ID'
  from new_business
  returning business_id
),
faqs_rows as (
  insert into faqs (business_id, question, answer)
  select id, v.question, v.answer
  from new_business,
    (values
      ('Do you accept card payments?', 'Yes, we accept cash and all major cards.'),
      ('Do you take walk-ins?', 'Yes, walk-ins are welcome, but booking ahead means less waiting.'),
      ('Is parking available?', 'Parking is on the street only; there is no dedicated lot.')
    ) as v(question, answer)
  returning id
),
new_staff as (
  insert into staff (business_id, name, role, services)
  select
    nb.id,
    v.name,
    v.role,
    (
      select coalesce(jsonb_agg(ns.id), '[]'::jsonb)
      from new_services ns
      where ns.name = any (v.service_names)
    )
  from new_business nb,
    (values
      ('Priya', 'Senior Stylist', array['Haircut', 'Haircut and beard', 'Hair color']),
      ('Arjun', 'Stylist', array['Haircut', 'Consultation'])
    ) as v(name, role, service_names)
  returning id, name
)
insert into staff_availability (business_id, staff_id, weekday, start_time, end_time)
select nb.id, ns.id, wd.weekday, '10:00'::time, '18:00'::time
from new_business nb
cross join new_staff ns
cross join (values (1), (2), (3), (4), (5), (6)) as wd(weekday); -- Monday(1)-Saturday(6); matches opening_hours above
