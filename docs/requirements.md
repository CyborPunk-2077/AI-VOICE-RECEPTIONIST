# Requirements

## Overview

ReceptionFlow is a portfolio project simulating an AI phone receptionist for a single-location salon, plus a dashboard for reviewing calls and bookings. The salon, its services, and its staff are fictional.

## Scope

One location. One phone number. Three bookable services. A fixed, approved set of FAQs. No multi-location, multi-language, or payment processing in scope.

## Functional requirements

### Call handling
- Answer inbound calls to the salon's phone number.
- Greet the caller and identify the salon.
- Understand caller intent: FAQ question, booking request, or request for a human.

### FAQ handling
- Answer only from a fixed, approved FAQ list (e.g., hours, location, parking, walk-ins, cancellation policy). The exact FAQ list is defined by the salon owner persona and stored as config, not improvised by the model.
- If a question falls outside the approved list, the agent must not guess — it should offer to transfer to a human or take a message.

### Availability & booking
- Check real-time availability against Google Calendar for the requested service.
- Support booking exactly one of three services (e.g., Haircut, Color, Blowout — final names/durations are configurable, not hardcoded into the voice flow logic).
- Collect the minimum info needed to book: caller name, callback number, requested service, preferred date/time.
- Confirm the booked slot back to the caller verbally before ending the call.
- Prevent double-booking; if the requested slot is unavailable, offer the nearest alternatives.

### Confirmation
- Send a booking confirmation after a successful booking (SMS via Twilio, only if email/other channel isn't sufficient — see architecture doc for the decision).
- Confirmation includes service, date/time, and location.

### Logging
- Every call is logged: timestamp, caller number, intent, outcome (FAQ answered / booked / transferred / no-match), and duration.
- Every booking is linked to its originating call log entry.

### Transfer to human
- Any of the following triggers a transfer: caller explicitly asks for a person, question is outside the approved FAQ list and can't be resolved, booking can't be completed after reasonable attempts, or the caller sounds distressed/urgent (e.g., complaint, emergency-adjacent language).
- If no human is available, the agent takes a message and logs it as "needs follow-up."

### Dashboard
- View call log (list + detail) with intent, outcome, and transcript/summary.
- View bookings (upcoming and past) tied to calendar.
- View which FAQs are being asked most, and any "no-match" questions the agent couldn't answer (useful for expanding the approved FAQ list later).
- Single-user or simple auth is sufficient (this is a portfolio piece, not multi-tenant SaaS).

## Non-functional requirements

- **Latency:** voice responses should feel conversational — no long dead air during FAQ or availability lookups.
- **Reliability:** calendar and booking checks must not double-book; failures should degrade to "let me transfer you" rather than a bad booking.
- **Privacy:** caller phone numbers and call transcripts are stored in Supabase with access restricted to the dashboard's authenticated owner. No data is sent to third parties beyond what's required by Vapi/Twilio/Google Calendar to function.
- **Auditability:** every automated decision (booked, transferred, FAQ answered, no-match) must be traceable in the call log.
- **Cost awareness:** since this is a portfolio project, avoid designs that require always-on paid infrastructure beyond the free/low tiers of the chosen stack where feasible.

## Out of scope

- Multiple locations or staff-specific booking.
- Payments or deposits.
- Rescheduling/cancellation via voice (may be a stretch goal, not core).
- Multi-language support.
- Real customer data — all data used in demos/testing is synthetic.

## Open questions

- Final list of three services and their durations/pricing (placeholder values until decided).
- Final approved FAQ list content.
- Business hours and timezone for the fictional salon.
- Whether SMS confirmation is required for every booking or only when requested (affects Twilio usage/cost).
