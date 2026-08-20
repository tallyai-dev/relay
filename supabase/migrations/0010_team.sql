-- Team: give each rep (SDR) their own outbound phone number and an active flag.
-- Roles + per-rep lead ownership already exist (0003). Admins can update any rep
-- row under the existing reps RLS, so number/role/active assignment is done from
-- the client; only creating the auth login needs the service role (see
-- /api/team/create).
alter table reps add column if not exists phone_number text;
alter table reps add column if not exists active boolean not null default true;
