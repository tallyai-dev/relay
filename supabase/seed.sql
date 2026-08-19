-- Relay — seed data (optional). Run after 0001_init.sql to populate a demo book.
-- Mirrors the seed used by the local mock data so prod looks like the prototype.

insert into cadences (id, name, is_default) values
  ('11111111-1111-1111-1111-111111111111', 'Cold Salon Outbound', true)
on conflict do nothing;

insert into cadence_steps (cadence_id, position, channel, wait_minutes, template, subject) values
  ('11111111-1111-1111-1111-111111111111', 0, 'call',  0,   null, null),
  ('11111111-1111-1111-1111-111111111111', 1, 'call',  0,   null, null),
  ('11111111-1111-1111-1111-111111111111', 2, 'text',  0,   'Hi {first_name} — Seth here. Quick idea for {salon}: an AI receptionist that answers your missed & after-hours calls so you stop losing bookings. Worth a 2-min look?', null),
  ('11111111-1111-1111-1111-111111111111', 3, 'email', 1440,'Hi {first_name} — noticed {salon} probably misses calls after you close. We set salons up with a 24/7 AI receptionist that answers and books them. 60-second demo inside — worth a look?', '{salon}: stop losing after-hours bookings')
on conflict do nothing;

insert into leads (salon, city, phone, stage, cadence_id, cadence_pos) values
  ('Luxe Hair Studio', 'Portland, ME', '+12075550142', 'working', '11111111-1111-1111-1111-111111111111', 1),
  ('The Mane Room', 'Boise, ID', '+12085550198', 'new', '11111111-1111-1111-1111-111111111111', 0),
  ('Shear Bliss Salon', 'Provo, UT', '+18015550110', 'hot', '11111111-1111-1111-1111-111111111111', 3),
  ('Copper + Comb', 'Tacoma, WA', '+12535550122', 'working', '11111111-1111-1111-1111-111111111111', 2),
  ('Golden Shears Co.', 'Meridian, ID', '+12085550165', 'hot', '11111111-1111-1111-1111-111111111111', 4)
on conflict do nothing;
