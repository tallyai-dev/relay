-- Instagram warm leads: salons that DM'd asking for a demo.
-- Adds a handle + free-text context column to leads, and seeds the warm
-- "Instagram — warm demo" cadence (text-first, references their DM, then a
-- call while they're still warm — never opens with a cold call).

alter table leads add column if not exists handle text;  -- IG @handle
alter table leads add column if not exists notes  text;  -- enrichment context / their DM ask

insert into cadences (id, name, is_default) values
  ('22222222-2222-2222-2222-222222222222', 'Instagram — warm demo', false)
on conflict (id) do nothing;

insert into cadence_steps (cadence_id, position, channel, wait_minutes, template, subject) values
  ('22222222-2222-2222-2222-222222222222', 0, 'text', 0,
   'Hi{first_name}! It''s Seth from Tally — thanks for the DM about {salon}. Here''s that 2-min demo I mentioned: {demo_link}. Want me to give you a quick call today?', null),
  ('22222222-2222-2222-2222-222222222222', 1, 'call', 120, null, null),
  ('22222222-2222-2222-2222-222222222222', 2, 'text', 1440,
   'Morning{first_name} — still happy to show you how Tally answers {salon}''s missed & after-hours calls so you stop losing bookings. Grab a time here? {demo_link}', null),
  ('22222222-2222-2222-2222-222222222222', 3, 'email', 1440,
   'Hi{first_name} — you messaged us on Instagram about a demo for {salon}. Here''s the 60-second version: {demo_link}. It answers every call you miss and books straight into your calendar. Worth a look?',
   '{salon}: the AI receptionist demo you asked about'),
  ('22222222-2222-2222-2222-222222222222', 4, 'call', 1440, null, null)
on conflict (cadence_id, position) do nothing;
