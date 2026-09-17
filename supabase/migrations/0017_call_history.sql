-- Relay migration 0017 - call history + call notes (2026-09-17).
-- Every call Relay places or receives gets a calls row (in-app, cell bridge,
-- inbound). dial_status and talk_s hold what happened on the salon side;
-- note / outcome / noted_at hold what the rep wrote from the Recent tab.
-- Idempotent.

alter table calls add column if not exists dial_status text;
alter table calls add column if not exists talk_s      integer;
alter table calls add column if not exists note        text;
alter table calls add column if not exists outcome     text;
alter table calls add column if not exists noted_at    timestamptz;
alter table calls add column if not exists noted_by    uuid;

create index if not exists calls_created_at_idx on calls (created_at desc);

-- Paste check: expect 6 rows
select column_name from information_schema.columns
 where table_name = 'calls'
   and column_name in ('dial_status','talk_s','note','outcome','noted_at','noted_by');
