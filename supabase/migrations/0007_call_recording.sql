-- Call recording + AI analysis: store the recording URL and full transcript on
-- the activity. duration_s already exists on activities. The AI summary reuses
-- the existing ai_note column; disposition reuses the existing column.
alter table activities add column if not exists recording_url text;
alter table activities add column if not exists transcript text;
