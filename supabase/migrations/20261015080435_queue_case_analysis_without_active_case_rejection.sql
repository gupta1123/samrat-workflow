begin;

-- Queue admission and worker capacity are different concerns. Keep the
-- existing daily safeguard, ownership checks and idempotency, but never reject
-- a saved case merely because other cases are queued or running.
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

  select * into c from public.packet_cases
  where id=p_case and owner_user_id=p_user and deleted_at is null
  for update;
  if not found then raise exception 'Case not found.'; end if;

  select * into j from public.packet_processing_jobs
  where case_id=p_case and status in ('queued','running')
  order by created_at desc limit 1;
  if found then
    update public.packet_cases
    set status='processing',
        processing_meta=processing_meta||jsonb_build_object(
          'lastProcessingError',null,
          'analysisQueuedAt',coalesce(processing_meta->'analysisQueuedAt',to_jsonb(now()))
        )
    where id=p_case returning * into c;
    return jsonb_build_object('case',to_jsonb(c),'job',to_jsonb(j));
  end if;

  if coalesce((c.processing_meta->'splitAnalysis'->>'groupCount')::integer,0)>1 then
    raise exception using message='This split case cannot be analyzed again as one packet.',
      detail='{"code":"analysis_split_case"}';
  end if;
  if not exists(select 1 from public.packet_case_files where case_id=p_case) then
    raise exception using message='Add documents before starting analysis.',
      detail='{"code":"analysis_documents_required"}';
  end if;
  if (select count(*) from public.packet_processing_jobs
      where owner_user_id=p_user and created_at>now()-interval '1 day')>=40 then
    raise exception using errcode='PT429',
      message='Daily analysis limit reached. Try again tomorrow.',
      detail='{"code":"analysis_daily_limit"}';
  end if;

  insert into public.packet_processing_jobs(case_id,owner_user_id,stage,result)
  values(p_case,p_user,'Queued for review',p_options) returning * into j;
  update public.packet_cases
  set status='processing',
      processing_meta=processing_meta||jsonb_build_object(
        'lastProcessingError',null,'analysisQueuedAt',now()
      )
  where id=p_case returning * into c;
  insert into public.case_review_events(case_id,owner_user_id,action,details)
  values(p_case,p_user,'analysis_queued',jsonb_build_object('jobId',j.id,'options',p_options));
  return jsonb_build_object('case',to_jsonb(c),'job',to_jsonb(j));
end $$;

-- Move the existing three-case capacity policy to claiming RUNNING work.
-- Extra jobs remain durably queued with no attempt/lease consumed. Both the
-- persistent worker and background functions use this same atomic claim.
create or replace function public.claim_case_job(p_job uuid,p_worker text)
returns jsonb language plpgsql set search_path='' as $$
declare
  j public.packet_processing_jobs;
  owner_id uuid;
begin
  select owner_user_id into owner_id from public.packet_processing_jobs where id=p_job;
  if not found then return null; end if;
  -- Same owner-lock order as enqueue: serialize capacity checks, then lock job.
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  select * into j from public.packet_processing_jobs
  where id=p_job and status='queued' and next_run_at<=now()
  for update skip locked;
  if not found then return null; end if;
  if not exists(select 1 from public.packet_cases where id=j.case_id and deleted_at is null) then
    update public.packet_processing_jobs set status='cancelled',finished_at=now() where id=j.id;
    return null;
  end if;
  if (select count(*) from public.packet_processing_jobs
      where owner_user_id=owner_id and status='running')>=3 then
    return null;
  end if;
  update public.packet_processing_jobs
  set status='running',attempt_count=attempt_count+1,
      locked_at=now(),locked_by=p_worker,
      started_at=coalesce(started_at,now()),stage='Preparing documents',progress=1
  where id=j.id returning * into j;
  return to_jsonb(j);
end $$;

revoke all on function public.enqueue_case_analysis(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_case_analysis(uuid,uuid,jsonb) to service_role;
revoke all on function public.claim_case_job(uuid,text) from public,anon,authenticated;
grant execute on function public.claim_case_job(uuid,text) to service_role;

commit;
