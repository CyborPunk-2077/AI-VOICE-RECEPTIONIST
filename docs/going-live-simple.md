# Going live, in plain language

No jargon. What the phone part actually is, what it costs, and what you have
to do by hand.

---

## The short answer

**Do you need Exotel? No.**

You need *some* Indian phone company. Exotel is one option, and it's the most
expensive way to start (₹9,999 minimum). **Plivo** does the same job,
costs nothing up front, and you can sign up yourself in an afternoon.

**Do you need any of them right now? Also no.** Everything except the actual
phone line already works on your laptop, for free. More on that below.

---

## What this "telephony" thing even is

Your project has three parts:

1. **The brain** — decides what to say. This is the code in this folder.
2. **The voice** — turns speech into text and back. This is Sarvam and
   OpenAI. ✅ You've already done this part.
3. **The phone line** — connects a real caller's phone to your computer.
   This is the missing piece.

Part 3 can't be code. When someone dials a number, that call travels through
Airtel or Jio's actual physical network. You cannot write software that
receives a phone call out of thin air — you have to rent a phone number from
a company licensed to operate in India, and they hand the call to your
software.

That company is what Exotel/Plivo/Ozonetel are. They're the wire between
"someone dialled a number" and "your code answers."

**Why it must be an Indian company:** Indian law (TRAI) says calls between
Indian numbers must stay on Indian infrastructure. This is why the project
can't use Vapi — Vapi's servers are in America. It's a legal rule, not a
technical limit, and there's no clever way around it.

---

## What it costs

| Option | Up-front | Per minute | Sign-up | Good for |
|---|---|---|---|---|
| **Plivo** ⭐ | ₹0, pay-as-you-go | ~₹0.40–0.90 inbound | Self-serve, number in 1–2 days | **Starting out** |
| Exotel | **₹9,999** min. plan | ~₹0.50–1.00 inbound | Company KYC, then ask support to switch on voicebot | Bigger businesses wanting hand-holding |
| Ozonetel | Sales quote | — | 3–7 days | Existing call centres |
| Twilio | ₹0 | 2–3× the others in India | Self-serve | Only if you also serve other countries |

Rough running cost either way: **a few hundred rupees a month for the number,
under ₹1 per minute of calls.** Plus what Sarvam and OpenAI charge you for
the AI itself, which is separate and usage-based.

**Recommendation: start with Plivo.** It's free to open an account, it's the
standard choice for developer-built projects at your stage, and you can move
to Exotel later if you ever need their compliance paperwork service. You are
nowhere near needing that.

---

## Do this first — it's free and takes 2 minutes

Before spending a rupee, see the whole thing work. Open two terminals in this
folder.

**Terminal 1:**

```
npm run gateway
```

**Terminal 2:**

```
npm run simulate
```

Terminal 2 pretends to be a phone call: it dials in, says three things,
interrupts the agent mid-sentence, and hangs up. Terminal 1 shows you the
conversation as it happens.

This uses your real Sarvam and OpenAI keys. It is the complete system minus
the phone company. If this works, the only thing standing between you and a
real call is renting a number.

You can also talk to the agent by typing, in a browser:

```
npm run console
```

then open **http://localhost:3100**. It will ask for a password — that's the
`AGENT_SERVER_SECRET` line in your `.env` file. Copy the part after the `=`
and paste it in.

---

## When you're ready for a real number

Four things you must do by hand. Nothing here is code.

### 1. Rent a computer in India — ~₹800–1,500/month

The phone company needs to reach your code over the internet, and by law
that computer must sit in India.

Get the cheapest small server in an **Indian region**:

- AWS → region **Mumbai (ap-south-1)**
- DigitalOcean → **Bangalore**
- Azure → **Central India**

2 CPU / 4 GB is plenty. Copy this project folder onto it and run
`npm run gateway` there instead of on your laptop.

> Just testing? You can skip the server and use **ngrok** on your laptop
> (free). Calls will sound slightly laggy because the audio detours abroad —
> fine for proving it works, not fine for real customers.

### 2. Get a web address with a padlock — ~₹800/year

The phone company won't connect to a bare IP address. You need a domain name
(`myshop.in` or similar) pointing at that server, with HTTPS.

The easy way is a tool called **Caddy**, which gets the certificate for you
automatically. Two lines of config, in `docs/exotel-setup.md`.

### 3. Sign up with Plivo and buy a number

1. Go to plivo.com, create an account.
2. Buy an Indian phone number (they call it a DID). Takes 1–2 days to
   activate — Indian numbers need ID documents by law.
3. In their dashboard, point the number at your server's address.
4. From their settings page, copy your **Auth ID** and **Auth Token**.

**One question you must ask them** (support chat, takes 2 minutes):

> "Is my audio stream G.711 µ-law, or linear PCM?"

Write the answer down. If they say µ-law, add this line to your `.env` file:

```
TELEPHONY_ENCODING=mulaw
```

If they say PCM, change nothing. **Getting this wrong doesn't show an error —
the call just becomes loud static.** It's the single most annoying thing to
debug, so ask up front.

### 4. Fill in your business details

Open `businesses/sharma-dental.json` and replace it with the real business —
name, opening hours, services, prices, the phone number to transfer to when
someone asks for a human.

This file is the *only* thing you edit per business. The agent will only ever
say what's in here. It won't invent a price or a policy; when it doesn't
know something it takes a callback instead. That's deliberate.

Check your edits:

```
npm run check
```

---

## Honest heads-up about Plivo

This project currently has a ready-made connector for **Exotel** only.
Plivo speaks almost the same language — same idea, slightly different
labels for a few fields — so pointing it at Plivo needs a small adapter,
maybe a day's work.

So:

- **Want to spend nothing and don't mind that adapter** → Plivo. Tell me and
  I'll write it.
- **Want it to work today with zero code changes and don't mind ₹9,999** →
  Exotel.

Either way, nothing about the brain or the voice changes. That seam is the
whole reason the project is built the way it is.

---

## Your checklist

- [x] Sarvam key — done
- [x] OpenAI key — done
- [ ] Run `npm run gateway` + `npm run simulate` and watch it work — **free, do this now**
- [ ] Fill in your real business in `businesses/`
- [ ] Decide: Plivo (free, needs an adapter) or Exotel (₹9,999, works today)
- [ ] Rent an Indian server
- [ ] Domain + HTTPS
- [ ] Buy the number, ask the µ-law question
- [ ] Point the number at your server, dial it

Anything unclear at any step, ask.

---

## Handy commands

| Command | What it does |
|---|---|
| `npm run doctor` | Checks your setup and tells you what's missing |
| `npm run doctor -- --live` | Same, but strict about what a real call needs |
| `npm test` | Runs all 80 tests |
| `npm run console` | Browser console to chat with the agent |
| `npm run gateway` | The thing that answers calls |
| `npm run simulate` | Fake phone call, no phone needed |
| `npm run check` | Validates your business files |
