-- Relay migration 0013 — mobile flow + Instagram + callbacks (2026-09-10).
--
--  1. "Last rep" routing: when a salon calls the Relay number back, ring the
--     cell of whoever dialed her last (falls back to the owner, then everyone).
--  2. Callback reminders: a real time on the lead + a notified stamp so the
--     minute tick pushes exactly once.
--  3. Web push subscriptions per rep (PWA lock-screen reminders).
--  4. Instagram: the IGSID we DM through, the last inbound social touch (the
--     24-hour DM window), and a social_events log for every DM / comment.
--  5. 'dm' becomes a message + cadence channel.
-- Idempotent: safe to re-run.

-- ── leads ────────────────────────────────────────────────────────────────────
alter table leads add column if not exists last_rep_id          uuid references reps(id);
alter table leads add column if not exists last_rep_at          timestamptz;
alter table leads add column if not exists callback_at          timestamptz;
alter table leads add column if not exists callback_note        text;
alter table leads add column if not exists callback_notified_at timestamptz;
alter table leads add column if not exists ig_user_id           text;         -- Instagram-scoped user id (Messaging API recipient)
alter table leads add column if not exists last_social_at       timestamptz;  -- her last inbound DM/comment → 24h reply window

create index if not exists leads_callback_at_idx on leads (callback_at) where callback_at is not null;
-- UNIQUE: two webhook deliveries for the same person can never make two leads.
create unique index if not exists leads_ig_user_id_idx on leads (ig_user_id) where ig_user_id is not null;
create index if not exists leads_handle_lower_idx on leads (lower(handle)) where handle is not null;

-- ── reps ─────────────────────────────────────────────────────────────────────
-- forward_to (their cell, E.164) already exists from 0001 — the bridge dials it.
alter table reps add column if not exists call_mode text not null default 'bridge'
  check (call_mode in ('bridge','app'));
alter table reps add column if not exists push_subscriptions jsonb not null default '[]'::jsonb;

-- ── 'dm' channel ─────────────────────────────────────────────────────────────
alter table messages drop constraint if exists messages_channel_check;
alter table messages add constraint messages_channel_check
  check (channel in ('text','email','dm'));

alter table cadence_steps drop constraint if exists cadence_steps_channel_check;
alter table cadence_steps add constraint cadence_steps_channel_check
  check (channel in ('call','text','email','wait','dm'));

-- ── social_events ────────────────────────────────────────────────────────────
create table if not exists social_events (
  id            uuid primary key default gen_random_uuid(),
  platform      text not null check (platform in ('instagram','tiktok')),
  kind          text not null check (kind in ('dm','comment','mention','share')),
  external_id   text unique,                       -- Meta message mid / comment id (dedupes webhook retries)
  ig_user_id    text,                              -- sender IGSID (DMs)
  handle        text,                              -- @username when known
  text          text,
  post_id       text,
  post_url      text,
  lead_id       uuid references leads(id) on delete set null,
  rule          text,                              -- which keyword rule fired, if any
  auto_replied  boolean not null default false,
  received_at   timestamptz not null default now(),
  raw           jsonb
);
create index if not exists social_events_lead_idx on social_events (lead_id, received_at desc);

alter table social_events enable row level security;
drop policy if exists social_events_select on social_events;
create policy social_events_select on social_events for select to authenticated using (true);
-- Writes come from the webhook (service role) only.

-- Realtime for the Inbox: DM messages already ride the messages publication.
do $$ begin
  alter publication supabase_realtime add table social_events;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ── Instagram cadence: DM first when we can, text otherwise ──────────────────
-- Step 0 becomes a DM (falls back to text automatically when there is no
-- IGSID or the 24h window is closed — see src/lib/cadence.ts dmFallback).
update cadence_steps set channel = 'dm'
  where cadence_id = '22222222-2222-2222-2222-222222222222' and position = 0 and channel = 'text';
