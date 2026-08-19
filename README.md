# Relay

Outbound **call / text / email dialer + CRM** for prospecting hair salons — a mix of a power-dialer (Salesloft/Outreach style) and a lightweight Salesforce. Built to book demos through massive, cadence-driven action.

Stack: **Next.js 14 (App Router, TS) · Supabase · Twilio · Netlify**. Theme: Azure (`#2563eb`).

> Runs with **zero config** on seeded mock data. Add env vars to switch on the real backend piece by piece.

---

## Quick start (local, no accounts needed)

```bash
npm install
npm run dev          # http://localhost:3000
```

You'll get the full Azure UI with a seeded book of salons. Click a salon → **Dialer**, hit **Flow Mode**, and run the loop: call → one-tap disposition → note → auto-advance. Text/email steps show an editable, name-merged preview before sending. (Calls/texts/emails are simulated until Twilio is wired.)

```bash
npm run build && npm run start   # production build
npm run typecheck                # tsc --noEmit
```

---

## Turning on the real backend

Copy `.env.example` → `.env.local` and fill in as you go. Nothing is required to run; each block activates a feature.

### 1. Supabase (data)
1. Create a project at supabase.com.
2. SQL editor → run `supabase/migrations/0001_init.sql`, then optionally `supabase/seed.sql`.
3. Paste `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

### 2. Twilio (voice + SMS)
1. `console.twilio.com` → grab `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`.
2. **API key/secret**: Account → API keys → create → `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`.
3. **TwiML App**: Voice → TwiML Apps → create; set its **Voice URL** to `{PUBLIC_BASE_URL}/api/voice/outbound`. Copy its SID → `TWILIO_TWIML_APP_SID`.
4. **Buy a number** → set `TWILIO_CALLER_ID` (E.164). ⚠️ *Seth: this is the number-provisioning step — we pick these together (area codes + A2P 10DLC).* On that number:
   - Voice webhook → `{PUBLIC_BASE_URL}/api/voice/inbound`
   - Messaging webhook → `{PUBLIC_BASE_URL}/api/sms/inbound`
5. **A2P 10DLC**: register the brand/campaign before sending SMS at volume (same process as Tally).
6. Set `FORWARD_TO_NUMBER` to your cell — inbound calls forward there when you don't answer in-app (the reliable-inbound MVP).

The browser dialer uses the **Twilio Voice JS SDK** with a token from `/api/voice/token`. (SDK wiring on the client is the first Phase-2 task — endpoints are ready.)

### 3. Email (inbound replies)
Postmark or SendGrid; point their inbound-parse webhook at `{PUBLIC_BASE_URL}/api/email/inbound`. Set `EMAIL_*` vars.

### 4. Deploy (Netlify)
Push to a repo, connect on Netlify (auto-detects Next via `@netlify/plugin-nextjs`), set all env vars in Site settings → Environment. Set `PUBLIC_BASE_URL` to the Netlify URL and update the Twilio webhooks to match. For local webhook testing use `ngrok http 3000` and set `PUBLIC_BASE_URL` to the ngrok URL.

---

## Layout

```
src/
  app/
    globals.css              Azure theme (ported from the approved prototype)
    layout.tsx  page.tsx     shell
    api/
      voice/token            mint Voice SDK access token
      voice/outbound         TwiML: dial out from the browser
      voice/inbound          TwiML: ring in-app, else forward to cell
      sms/inbound  sms/send   receive + send texts
      email/inbound          parse email replies
  lib/
    types.ts                 shared types
    cadence.ts               ★ cadence engine (next-action logic)
    seedData.ts              mock book for local dev
    supabase.ts  twilio.ts   clients (no-op without env)
  hooks/useRelay.ts          ★ Flow state machine (call→dispo→note→advance)
  components/RelayApp.tsx     UI: rail, leads, dialer, Flow bar, live call
supabase/
  migrations/0001_init.sql   schema
  seed.sql                   demo data
```

See `BUILD_PLAN.md` for what's done and what's next.
