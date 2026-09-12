-- Relay migration 0015 — editable templates (2026-09-12).
-- The prospecting templates ship in code (src/lib/templates.ts). An admin can
-- rewrite any of them in Relay → Templates; the edit lands here, keyed
-- '<kind>:<key>' (text:na1, email:missed, product:nightdesk). Everything that
-- renders a template — the lead-card sheet, the email composer, Eryn's
-- follow-up texts — reads the override first and the code default otherwise.
-- Deleting a row = "reset to default". Idempotent.

create table if not exists template_overrides (
  key         text primary key,                 -- '<kind>:<key>'
  kind        text not null check (kind in ('text','email','product')),
  subject     text,                             -- emails / product emails only
  body        text not null,
  updated_by  uuid references reps(id),
  updated_at  timestamptz not null default now()
);

alter table template_overrides enable row level security;
drop policy if exists template_overrides_select on template_overrides;
create policy template_overrides_select on template_overrides for select to authenticated using (true);
drop policy if exists template_overrides_admin on template_overrides;
create policy template_overrides_admin on template_overrides for all to authenticated
  using (is_admin()) with check (is_admin());
