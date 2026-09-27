begin;

create or replace function public.recover_stale_case_jobs() returns void language plpgsql set search_path='' as $$
declare j record;
begin
 for j in select id,locked_by from public.packet_processing_jobs where status='running' and locked_at<now()-interval '2 minutes' loop
   perform public.fail_case_job(j.id,j.locked_by,'The analysis worker stopped reporting activity. Samrat scheduled an automatic retry.',true);
 end loop;
end $$;

revoke all on function public.recover_stale_case_jobs() from public,anon,authenticated;
grant execute on function public.recover_stale_case_jobs() to service_role;

commit;
