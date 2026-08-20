-- Cadence completion: stamp a lead when it finishes its whole cadence so the
-- salon view can show a "Complete" badge with which cadence and the finish date.
alter table leads add column if not exists cadence_completed_at   timestamptz;
alter table leads add column if not exists cadence_completed_name text;
