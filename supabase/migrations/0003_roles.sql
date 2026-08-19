-- Relay migration 0003 — roles + per-rep lead ownership.
-- Reps see only their own leads; admins see everything. First user to sign up
-- becomes admin. Unassigned leads (owner null) are a shared pool visible to all.

alter table reps add column if not exists role text not null default 'rep'
  check (role in ('admin','rep'));

-- Helpers run as SECURITY DEFINER so they bypass RLS (no recursion on reps).
create or replace function current_rep_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select id from reps where auth_user_id = auth.uid() limit 1
$$;

create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from reps where auth_user_id = auth.uid() and role = 'admin')
$$;

-- First signup becomes admin; everyone after is a rep.
create or replace function handle_new_user() returns trigger as $$
declare first_user boolean;
begin
  select count(*) = 0 into first_user from public.reps;
  insert into public.reps (auth_user_id, name, email, role)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
          new.email,
          case when first_user then 'admin' else 'rep' end)
  on conflict (auth_user_id) do nothing;
  return new;
end; $$ language plpgsql security definer;

-- ── Replace the team-wide policies with owner-scoped ones ────────────────────
drop policy if exists team_all on reps;
create policy reps_select on reps for select to authenticated
  using (auth_user_id = auth.uid() or is_admin());
create policy reps_update on reps for update to authenticated
  using (auth_user_id = auth.uid() or is_admin())
  with check (auth_user_id = auth.uid() or is_admin());
create policy reps_insert on reps for insert to authenticated
  with check (is_admin());

drop policy if exists team_all on leads;
create policy leads_rw on leads for all to authenticated
  using (owner_rep_id = current_rep_id() or owner_rep_id is null or is_admin())
  with check (owner_rep_id = current_rep_id() or owner_rep_id is null or is_admin());

drop policy if exists team_all on activities;
create policy activities_rw on activities for all to authenticated
  using (exists (select 1 from leads l where l.id = activities.lead_id
    and (l.owner_rep_id = current_rep_id() or l.owner_rep_id is null or is_admin())))
  with check (exists (select 1 from leads l where l.id = activities.lead_id
    and (l.owner_rep_id = current_rep_id() or l.owner_rep_id is null or is_admin())));

drop policy if exists team_all on contacts;
create policy contacts_rw on contacts for all to authenticated
  using (exists (select 1 from leads l where l.id = contacts.lead_id
    and (l.owner_rep_id = current_rep_id() or l.owner_rep_id is null or is_admin())))
  with check (exists (select 1 from leads l where l.id = contacts.lead_id
    and (l.owner_rep_id = current_rep_id() or l.owner_rep_id is null or is_admin())));

drop policy if exists team_all on messages;
create policy messages_rw on messages for all to authenticated
  using (lead_id is null or exists (select 1 from leads l where l.id = messages.lead_id
    and (l.owner_rep_id = current_rep_id() or l.owner_rep_id is null or is_admin())))
  with check (lead_id is null or exists (select 1 from leads l where l.id = messages.lead_id
    and (l.owner_rep_id = current_rep_id() or l.owner_rep_id is null or is_admin())));

drop policy if exists team_all on calls;
create policy calls_rw on calls for all to authenticated
  using (lead_id is null or exists (select 1 from leads l where l.id = calls.lead_id
    and (l.owner_rep_id = current_rep_id() or l.owner_rep_id is null or is_admin())))
  with check (lead_id is null or exists (select 1 from leads l where l.id = calls.lead_id
    and (l.owner_rep_id = current_rep_id() or l.owner_rep_id is null or is_admin())));

-- cadences + cadence_steps stay team-visible (global config) — their team_all
-- policies from 0002 remain in place.

-- Promote a teammate to admin later with:
--   update reps set role = 'admin' where email = 'name@example.com';
