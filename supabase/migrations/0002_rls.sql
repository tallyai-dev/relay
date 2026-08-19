-- Relay — Row Level Security.
-- Model: small shared team (Seth + Justin) work one book together, so any
-- authenticated user has full access; anon is denied. Webhooks use the service
-- role key, which bypasses RLS. Tighten to per-rep ownership later by adding
-- `owner_rep_id = auth_rep()` predicates.

alter table reps          enable row level security;
alter table cadences      enable row level security;
alter table cadence_steps enable row level security;
alter table leads         enable row level security;
alter table contacts      enable row level security;
alter table activities    enable row level security;
alter table messages      enable row level security;
alter table calls         enable row level security;

do $$
declare t text;
begin
  foreach t in array array['reps','cadences','cadence_steps','leads','contacts','activities','messages','calls']
  loop
    execute format('drop policy if exists team_all on %I', t);
    execute format(
      'create policy team_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Auto-provision a rep row the first time a user signs up.
create or replace function handle_new_user() returns trigger as $$
begin
  insert into public.reps (auth_user_id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)), new.email)
  on conflict (auth_user_id) do nothing;
  return new;
end; $$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Enable Postgres realtime for the tables the UI subscribes to.
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table leads;
alter publication supabase_realtime add table activities;
