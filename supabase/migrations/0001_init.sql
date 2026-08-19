-- Relay — initial schema
-- Run in Supabase SQL editor (or `supabase db push`). Safe to re-run: uses IF NOT EXISTS.

create extension if not exists "pgcrypto";

-- ── Reps (your sales team) ───────────────────────────────────────────────────
create table if not exists reps (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,                     -- maps to supabase auth.users.id
  name          text not null,
  email         text unique,
  relay_number  text,                            -- their outbound/inbound Twilio number, E.164
  forward_to    text,                            -- personal cell for inbound forwarding, E.164
  created_at    timestamptz not null default now()
);

-- ── Cadences ─────────────────────────────────────────────────────────────────
create table if not exists cadences (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Ordered steps. channel: call | text | email | wait
-- branch rules are simple + interpreted by the cadence engine (see src/lib/cadence.ts):
--   calls_before_fallback controls "call twice, then text+email".
create table if not exists cadence_steps (
  id           uuid primary key default gen_random_uuid(),
  cadence_id   uuid not null references cadences(id) on delete cascade,
  position     int  not null,
  channel      text not null check (channel in ('call','text','email','wait')),
  wait_minutes int  not null default 0,
  template     text,                             -- text/email body template with {salon} {first_name}
  subject      text,                             -- email subject template
  unique (cadence_id, position)
);

-- ── Leads (salons) + contacts ────────────────────────────────────────────────
create table if not exists leads (
  id            uuid primary key default gen_random_uuid(),
  salon         text not null,
  city          text,
  phone         text,                            -- E.164 preferred
  email         text,
  booking_system text,
  source        text,
  stage         text not null default 'new' check (stage in ('new','working','hot','won','cold')),
  cadence_id    uuid references cadences(id),
  cadence_pos   int  not null default 0,         -- current step index within cadence
  owner_rep_id  uuid references reps(id),
  next_action_at timestamptz,                    -- when this lead is due again
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists contacts (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references leads(id) on delete cascade,
  name       text,
  role       text,                               -- Owner | Manager | Front desk
  phone      text,
  email      text,
  is_primary boolean not null default true
);

-- ── Activities (the unified timeline) ────────────────────────────────────────
-- Everything that happens to a lead: calls, texts, emails, notes, bookings.
create table if not exists activities (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references leads(id) on delete cascade,
  rep_id      uuid references reps(id),
  kind        text not null,                     -- call | text | email | note | book | quote | system
  direction   text check (direction in ('out','in')),
  disposition text,                              -- no_answer | voicemail | connected | booked | not_interested | ...
  ai_note     text,                              -- AI-generated summary
  own_note    text,                              -- rep's manual note
  body        text,                              -- message body / free text
  duration_s  int,
  created_at  timestamptz not null default now()
);

-- ── Messages (text + email threads for the Inbox) ────────────────────────────
create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references leads(id) on delete set null,
  contact_id  uuid references contacts(id) on delete set null,
  channel     text not null check (channel in ('text','email')),
  direction   text not null check (direction in ('out','in')),
  from_addr   text,
  to_addr     text,
  subject     text,
  body        text,
  provider_id text,                              -- Twilio/Postmark message id
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ── Calls (Twilio call records) ──────────────────────────────────────────────
create table if not exists calls (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid references leads(id) on delete set null,
  rep_id        uuid references reps(id),
  twilio_sid    text unique,
  direction     text check (direction in ('out','in')),
  from_number   text,
  to_number     text,
  status        text,                            -- queued | ringing | in-progress | completed | no-answer | busy
  duration_s    int,
  recording_url text,
  transcript    text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_leads_next_action on leads(next_action_at);
create index if not exists idx_leads_owner on leads(owner_rep_id);
create index if not exists idx_activities_lead on activities(lead_id, created_at desc);
create index if not exists idx_messages_lead on messages(lead_id, created_at desc);
create index if not exists idx_messages_unread on messages(is_read) where is_read = false;

-- updated_at trigger for leads
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;
drop trigger if exists trg_leads_updated on leads;
create trigger trg_leads_updated before update on leads
  for each row execute function set_updated_at();
