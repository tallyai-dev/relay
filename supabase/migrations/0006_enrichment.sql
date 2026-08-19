-- Lead enrichment: store the website Google Places returns (phone/city already
-- have columns). Nullable text, no default.
alter table leads add column if not exists website text;
