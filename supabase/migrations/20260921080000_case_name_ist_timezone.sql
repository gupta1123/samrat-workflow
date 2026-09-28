begin;

-- packet_cases.created_at remains a timestamptz stored in UTC. The temporary
-- display name, however, is user-facing and must be formatted in local time.
-- PostgreSQL functions inherit the database session timezone unless they have
-- a function-local setting, which previously caused UTC text to be persisted.
alter function public.attach_case_uploads(uuid, uuid[], uuid, text, boolean)
  set timezone to 'Asia/Kolkata';

-- Repair only untouched temporary names. Completed cases normally have an
-- extracted supplier/reference name and are deliberately left unchanged.
update public.packet_cases
set display_name = 'Case · ' || to_char(
  created_at at time zone 'Asia/Kolkata',
  'DD Mon YYYY HH24:MI'
)
where display_name ~ '^Case · [0-9]{2} [A-Za-z]{3} [0-9]{4} [0-9]{2}:[0-9]{2}$';

commit;
