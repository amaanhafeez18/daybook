-- Run once in the Supabase SQL editor (safe to re-run; needs no secrets).
-- Progress photos (Gym → Progress): kept in the attachments table with target_type 'progress' and
-- target_id = the day ('2026-10-21'). This only widens the allowed target types. Until it runs,
-- adding a progress photo explains that this update is needed; nothing else changes.

alter table public.attachments drop constraint if exists attachments_target_type_check;
alter table public.attachments add constraint attachments_target_type_check
  check (target_type in ('task', 'note', 'friend', 'progress'));

notify pgrst, 'reload schema';
