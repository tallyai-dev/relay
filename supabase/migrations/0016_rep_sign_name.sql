-- Relay migration 0016 - optional sign-as name for templates (2026-09-16).
-- Templates no longer hardcode a founder name. Each rep may set a Sign as
-- name; blank means texts and emails speak as Tally. Idempotent.

alter table reps add column if not exists sign_name text;

-- The two live cadence texts that still named Seth now use the rep token.
update cadence_steps
   set template = replace(template, 'Seth here.', '{rep} here.')
 where template like '%Seth here.%';

update cadence_steps
   set template = replace(template, 'It''s Seth from Tally', 'It''s {rep} from Tally')
 where template like '%It''s Seth from Tally%';

-- Paste check: expect zero rows
select id, template from cadence_steps where template ilike '%seth%';
