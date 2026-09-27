begin;

-- Starting analysis is one database transaction: an active job and a
-- Processing case are returned together. If an older deployment ever left an
-- active job attached to a Draft case, an idempotent retry repairs the case
-- before returning instead of silently reporting that analysis started.
create or replace function public.enqueue_case_analysis(
  p_user uuid,
  p_case uuid,
  p_options jsonb
) returns jsonb language plpgsql set search_path='' as $$
declare
  c public.packet_cases;
  j public.packet_processing_jobs;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));

  select * into c
  from public.packet_cases
  where id=p_case and owner_user_id=p_user and deleted_at is null
  for update;
  if not found then raise exception 'Case not found.'; end if;

  select * into j
  from public.packet_processing_jobs
  where case_id=p_case and status in ('queued','running')
  order by created_at desc
  limit 1;

  if found then
    update public.packet_cases
    set status='processing',
        processing_meta=processing_meta||jsonb_build_object(
          'lastProcessingError',null,
          'analysisQueuedAt',coalesce(processing_meta->'analysisQueuedAt',to_jsonb(now()))
        )
    where id=p_case
    returning * into c;

    return jsonb_build_object('case',to_jsonb(c),'job',to_jsonb(j));
  end if;

  if coalesce((c.processing_meta->'splitAnalysis'->>'groupCount')::integer,0)>1 then
    raise exception 'This is a split case. Create a new case with only its corrected documents to avoid duplicating sibling cases.';
  end if;
  if not exists(select 1 from public.packet_case_files where case_id=p_case) then
    raise exception 'Add documents before starting analysis.';
  end if;
  if (select count(*) from public.packet_processing_jobs where owner_user_id=p_user and created_at>now()-interval '1 day')>=40 then
    raise exception 'Daily analysis limit reached (40). Try again tomorrow.';
  end if;
  if (select count(*) from public.packet_processing_jobs where owner_user_id=p_user and status in ('queued','running'))>=3 then
    raise exception 'Three cases are already processing. Wait for one to finish.';
  end if;

  insert into public.packet_processing_jobs(
    case_id,
    owner_user_id,
    stage,
    result
  ) values(
    p_case,
    p_user,
    'Queued for review',
    p_options
  ) returning * into j;

  update public.packet_cases
  set status='processing',
      processing_meta=processing_meta||jsonb_build_object(
        'lastProcessingError',null,
        'analysisQueuedAt',now()
      )
  where id=p_case
  returning * into c;

  insert into public.case_review_events(
    case_id,
    owner_user_id,
    action,
    details
  ) values(
    p_case,
    p_user,
    'analysis_queued',
    jsonb_build_object('jobId',j.id,'options',p_options)
  );

  return jsonb_build_object('case',to_jsonb(c),'job',to_jsonb(j));
end $$;

revoke all on function public.enqueue_case_analysis(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_case_analysis(uuid,uuid,jsonb) to service_role;

commit;
