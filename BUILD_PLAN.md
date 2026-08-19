# Relay — build plan

Phased so each step ships something usable. ✅ = done in this scaffold.

## Phase 1 — Foundation ✅ (this repo)
- ✅ Next.js + TS + Netlify config; runs on seeded data with zero env.
- ✅ Supabase schema: reps, leads, contacts, activities, messages, calls, cadences, cadence_steps.
- ✅ Cadence engine (`src/lib/cadence.ts`): plan-per-stage, call-attempt math, outcome→advance rules, template merge.
- ✅ Twilio + email endpoints: voice token, outbound TwiML, inbound TwiML (forward-to-cell), SMS in/out, email inbound.
- ✅ Azure UI ported to React: rail, top scoreboard, Leads table, Dialer workspace, **Flow Mode** loop
  (call → live panel → End & log → one-tap disposition → connected outcomes → AI note + your note → auto-advance),
  text/email compose-before-send, queue check-off.

## Phase 2 — Persistence + real calls ✅ (mostly)
- ✅ Supabase data layer (`src/lib/repo.ts`): hydrate leads/activities, persist activity + stage writes; no-ops → mock fallback when unconfigured.
- ✅ Auth (`src/components/AuthGate.tsx`): Supabase Auth sign-in/up; demo mode when unconfigured.
- ✅ CSV lead import (`src/lib/csv.ts` + Import modal): header-aware parse → bulk insert (Supabase) / append (demo).
- ✅ Client Twilio Voice SDK (`src/lib/voice.ts`): `flowCall()` places a real WebRTC call via `/api/voice/token`; scripted sim fallback when unconfigured.
- ✅ `flowSend('text')` → best-effort `POST /api/sms/send`.
- [ ] `flowSend('email')` → add `/api/email/send` (provider) + wire.
- [ ] Realtime subscriptions (leads/messages) + RLS policies scoping data per rep.
- [ ] Reconcile optimistic activity IDs with DB IDs (own-note edits currently attach to latest row).

## Phase 3 — Two-way ✅ (mostly)
- ✅ **Inbox** (React): threads grouped by lead, conversation view, reply (text via `/api/sms/send`, email via `/api/email/send`), unread rail badge, realtime subscribe for inbound (`subscribeMessages`).
- ✅ **Inbound calls**: incoming banner via Twilio Voice `onIncoming` (+ Simulate button for demo); Answer opens the live panel and pauses/resumes Flow; Decline logs a missed call + drops a voicemail into the Inbox. `CallPanel` handles inbound + outbound.
- ✅ `/api/email/send` (Postmark/SendGrid) + wired to flow + inbox.
- ✅ RLS migration `0002_rls.sql` (team-shared policies, auto-provision rep on signup, realtime publication).
- [ ] Cadence builder (editable), Reports, Calendly booking, quote send (prototype designs exist).

## Phase 3.5 — Multi-tenant (team) ✅
- ✅ `reps.role` (admin | rep); first signup becomes admin (auth trigger).
- ✅ Per-rep RLS (migration `0003_roles.sql`, LIVE): reps see only their own leads (+ unassigned pool); admins see all. Child tables scoped by lead ownership. `current_rep_id()` / `is_admin()` helpers.
- ✅ App: `fetchMe`/`fetchReps`, Flow queue built from the rep's own book, Import "Assign to rep" selector (admin), role badge + sign-out.
- ✅ Live Supabase project provisioned (ref nebtfysgtnvdbtqcsmoq): migrations 0001–0003 + seed run; app wired via `.env.local`.
- [ ] Team management screen (invite reps, set roles, assign each a Twilio number).

## Phase 4 — Deploy + Mobile (PWA) + inbound-on-phone
- [ ] Installable PWA (manifest + service worker); web push for replies.
- [ ] Inbound: forward Relay number → cell (reliable MVP). Evaluate native/React Native + Twilio Voice SDK + CallKit only if in-app pocket ringing is needed.

## Phase 5 — Scale
- [ ] Cadence scheduler (due-action jobs) as Supabase cron/edge functions.
- [ ] Bulk CSV import + phone/email normalization (E.164).
- [ ] A2P 10DLC registration; per-rep numbers; call recording + real transcription/summary.

## Known notes
- `useRelay` holds state in memory (seed data) — intentional for Phase 1. Phase 2 swaps to Supabase.
- Inbox/Cadences/Reports/Mobile currently render a Phase-2 placeholder; their backend + prototype design already exist.
- Live-call transcript is scripted in Phase 1; real transcription lands in Phase 2/5.
