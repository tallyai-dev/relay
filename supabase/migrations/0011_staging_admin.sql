-- Staging is admin-only. Reps keep seeing their own leads plus the unassigned
-- ACTIVE pool, but leads still sitting in staging (deployed = false) are now
-- visible only to admins. Deploying with an "Assign to" rep sets owner_rep_id,
-- so a batch can go straight into Kade's name.
drop policy if exists leads_rw on leads;
create policy leads_rw on leads for all to authenticated
  using (
    is_admin()
    or owner_rep_id = current_rep_id()
    or (owner_rep_id is null and deployed = true)
  )
  with check (
    is_admin()
    or owner_rep_id = current_rep_id()
    or (owner_rep_id is null and deployed = true)
  );
