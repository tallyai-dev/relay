-- Relay migration 0004 — disposition-based branching on cadence steps.
-- Each Call step can route the six call outcomes (no_answer, voicemail,
-- wrong_number, booked, callback, not_interested) to an action:
--   {"type":"continue"} | {"type":"send","channel":"text|email"}
-- | {"type":"wait","days":N} | {"type":"stop","stage":"new|working|hot|won|cold"}
-- Stored as JSONB; null = use the app's sensible defaults.
alter table cadence_steps add column if not exists branches jsonb;
