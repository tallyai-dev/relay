-- Relay migration 0014 — Eryn, the AI cold caller (2026-09-11).
--
--  1. leads.owner: who works the lead — 'rep' (a human) or 'agent' (Eryn).
--     Instagram leads and anyone who ever talked to a human stay 'rep'.
--  2. leads.line_type: Twilio Lookup result. Eryn only dials landline / voip;
--     mobiles go back to a rep's hand-dial list.
--  3. leads.dnc: "stop / remove me" → true. Blocks every dialer and every text.
--  4. leads.agent_*: attempt counter + next-eligible time for Eryn's retries.
--  5. agent_calls: one row per ElevenLabs conversation — placed, ended,
--     outcome, summary, transcript. The lead timeline (activities) gets a
--     compact entry when the post-call webhook lands.
--  6. agent_shifts: the running "Eryn's shift" — cap, counters, pause.
-- Idempotent: safe to re-run.

-- ── leads ────────────────────────────────────────────────────────────────────
alter table leads add column if not exists owner           text not null default 'rep'
  check (owner in ('rep','agent'));
alter table leads add column if not exists line_type       text;          -- landline | mobile | voip | unknown
alter table leads add column if not exists line_checked_at timestamptz;
alter table leads add column if not exists dnc             boolean not null default false;
alter table leads add column if not exists dnc_at          timestamptz;
alter table leads add column if not exists agent_attempts  int not null default 0;
alter table leads add column if not exists agent_last_at   timestamptz;
alter table leads add column if not exists agent_next_at   timestamptz;   -- not before this (retry spacing)

create index if not exists leads_agent_queue_idx on leads (owner, agent_next_at)
  where owner = 'agent' and dnc = false;

-- ── agent_calls ──────────────────────────────────────────────────────────────
create table if not exists agent_calls (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references leads(id) on delete cascade,
  rep_id           uuid references reps(id),          -- who pressed the button (null = shift runner)
  kind             text not null default 'cold' check (kind in ('cold','warm')),
  agent_id         text,                              -- ElevenLabs agent
  conversation_id  text unique,                       -- ElevenLabs conversation (webhook key)
  call_sid         text,                              -- Twilio CallSid
  from_number      text,
  to_number        text,
  status           text not null default 'queued'
                   check (status in ('queued','ringing','in_progress','ended','failed')),
  outcome          text,                              -- answered_interested | callback | gatekeeper | not_interested |
                                                      -- wrong_icp | dnc | voicemail | no_answer | unknown
  summary          text,
  transcript       jsonb,                             -- [{role, message, t}]
  data             jsonb,                             -- data_collection results (owner_name, hours, mobile, ...)
  duration_s       int,
  error            text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists agent_calls_lead_idx   on agent_calls (lead_id, created_at desc);
create index if not exists agent_calls_status_idx on agent_calls (status, started_at desc);

alter table agent_calls enable row level security;
drop policy if exists agent_calls_select on agent_calls;
create policy agent_calls_select on agent_calls for select to authenticated using (true);
-- Writes come from the API routes (service role) only.

-- ── agent_shifts ─────────────────────────────────────────────────────────────
create table if not exists agent_shifts (
  id          uuid primary key default gen_random_uuid(),
  rep_id      uuid references reps(id),               -- who started it
  status      text not null default 'running' check (status in ('running','paused','done')),
  cap         int  not null default 60,               -- max dials this shift
  dials       int  not null default 0,
  answered    int  not null default 0,
  paused_note text,                                   -- why it paused itself (e.g. 3 wrong-ICP in a row)
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  last_dial_at timestamptz
);
alter table agent_shifts enable row level security;
drop policy if exists agent_shifts_select on agent_shifts;
create policy agent_shifts_select on agent_shifts for select to authenticated using (true);

-- Realtime so the Eryn screen updates without polling (the app also polls).
do $$ begin
  alter publication supabase_realtime add table agent_calls;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table agent_shifts;
exception when duplicate_object then null; when undefined_object then null; end $$;
