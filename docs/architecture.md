# Architecture

## Components

| Component | Role |
|---|---|
| **Vapi** | Voice AI layer. Answers the call, runs the conversation (STT → LLM → TTS), and calls out to tools/webhooks for FAQ lookup, availability checks, and booking. |
| **n8n** | Orchestration layer. Exposes webhooks that Vapi calls mid-conversation; handles FAQ lookup, Google Calendar availability/booking, writing to Supabase, and triggering Twilio SMS. |
| **Google Calendar** | Source of truth for availability and bookings. One calendar (or one calendar per service) represents the salon's schedule. |
| **Supabase** | Persistent storage: call logs, booking records, FAQ config, service config, transfer/escalation records. Also backs dashboard auth. |
| **Next.js dashboard** | Reads from Supabase to show calls, bookings, and FAQ analytics to the salon owner. |
| **Twilio** | SMS only — used for booking confirmations or human-transfer fallback notices, if email/voice confirmation isn't sufficient. Not used for voice. |

## Why this split

Vapi owns the real-time conversation; it should stay thin and call out to n8n for anything that touches data (calendar, database, SMS) rather than embedding that logic in the voice agent config. n8n is the single integration hub so Calendar/Supabase/Twilio credentials live in one place, not scattered across the voice platform and the dashboard. Supabase is the shared source of truth that both n8n (writer) and the dashboard (reader) use, so the dashboard never talks to Calendar or Vapi directly.

## Call flow

1. Caller dials the salon number → Vapi answers.
2. Vapi's system prompt classifies intent: FAQ, booking, or "needs a human."
3. **FAQ path:** Vapi calls an n8n webhook with the question → n8n matches against the approved FAQ table in Supabase → returns the approved answer (or "no match") → Vapi speaks it or escalates to transfer.
4. **Booking path:** Vapi calls an n8n webhook with requested service + time window → n8n checks Google Calendar for availability → returns open slots → Vapi confirms a slot with the caller → Vapi calls n8n again to write the booking → n8n creates the Google Calendar event, writes a booking row in Supabase, and triggers a Twilio SMS confirmation.
5. **Transfer path:** Vapi (or n8n, if a downstream step fails) triggers a transfer to a human number. n8n logs the transfer reason to Supabase.
6. **Always:** at call end, Vapi (via n8n) writes a call log row to Supabase — timestamp, caller number, intent, outcome, duration, and transcript/summary.
7. Dashboard (Next.js + Supabase client) reads call logs, bookings, and FAQ "no-match" stats for display.

## Data model (sketch)

Not final — to be defined in detail during implementation. Expected tables:

- **calls** — id, started_at, ended_at, caller_number, intent, outcome, transcript_summary, transfer_reason (nullable)
- **bookings** — id, call_id (fk), service_id (fk), customer_name, customer_phone, start_time, end_time, calendar_event_id, status
- **services** — id, name, duration_minutes, description (exactly 3 rows)
- **faqs** — id, question, approved_answer, active
- **faq_misses** — id, call_id (fk), question_asked, created_at (for identifying gaps in FAQ coverage)

## Integration boundaries

- **Vapi ↔ n8n:** Vapi tool/function calls hit n8n webhook URLs. n8n returns structured JSON Vapi can speak from.
- **n8n ↔ Google Calendar:** OAuth-based calendar API access, scoped to a single calendar.
- **n8n ↔ Supabase:** service-role access for writes (calls, bookings, faq_misses); read access for FAQ/service config.
- **n8n ↔ Twilio:** outbound SMS only, triggered after a confirmed booking or an unresolved transfer.
- **Dashboard ↔ Supabase:** read access (and limited writes, e.g., editing the FAQ list) via Supabase client, gated by auth.

## Environments & secrets

All credentials (Vapi, n8n, Supabase, Google, Twilio) will be stored as environment variables once accounts exist — never committed. See `.gitignore` and `CLAUDE.md`.
