-- Run once in the Supabase SQL editor (safe to re-run; needs no secrets).
-- pg_cron logs every run of the every-minute reminder job in cron.job_run_details; keep only 3 days.

select cron.unschedule('daybook-cron-cleanup') where exists (select 1 from cron.job where jobname = 'daybook-cron-cleanup');
select cron.schedule('daybook-cron-cleanup', '17 3 * * *', $$ delete from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '3 days' $$);

-- Clear the backlog now rather than waiting for the first nightly run.
delete from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '3 days';
