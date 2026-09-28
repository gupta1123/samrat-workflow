begin;

-- A case with a durable queued/running job must never be presented as Draft.
-- The enqueue RPC already inserts the job and changes the case in one database
-- transaction; this invariant protects that relationship from later writes.
create function public.prevent_active_analysis_from_becoming_draft()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status='draft' and new.deleted_at is null and exists(
    select 1
    from public.packet_processing_jobs j
    where j.case_id=new.id and j.status in ('queued','running')
  ) then
    raise exception 'An active analysis cannot return to Draft.';
  end if;
  return new;
end $$;

create trigger prevent_active_analysis_draft
before update of status,deleted_at on public.packet_cases
for each row execute function public.prevent_active_analysis_from_becoming_draft();

-- Repair any inconsistent rows left by an interrupted older application request.
update public.packet_cases c
set status='processing'
where c.deleted_at is null
  and c.status='draft'
  and exists(
    select 1
    from public.packet_processing_jobs j
    where j.case_id=c.id and j.status in ('queued','running')
  );

revoke all on function public.prevent_active_analysis_from_becoming_draft() from public,anon,authenticated;
grant execute on function public.prevent_active_analysis_from_becoming_draft() to service_role;

commit;
