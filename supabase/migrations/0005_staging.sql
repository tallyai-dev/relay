-- Lead staging: imported leads sit in a pool (deployed=false) until the rep
-- deploys a batch into a cadence. Existing leads default to deployed=true so
-- they stay in the active pipeline. New CSV/extension imports set deployed=false.
alter table leads add column if not exists deployed boolean not null default true;
create index if not exists idx_leads_deployed on leads(deployed);
