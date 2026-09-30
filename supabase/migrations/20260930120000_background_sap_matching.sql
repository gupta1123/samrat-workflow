begin;

-- SAP matching can take longer than a web request because SAP Business One is
-- read through several paginated endpoints. Keep that work in the durable
-- Heroku worker and let the browser poll this small status/result row.
create table public.sap_match_jobs (
  case_id uuid primary key references public.packet_cases(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  stage text not null default 'Queued for SAP matching',
  result jsonb,
  error text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sap_match_jobs_queue_idx
  on public.sap_match_jobs(status,next_run_at,requested_at);

create trigger touch_sap_match_jobs before update on public.sap_match_jobs
  for each row execute function public.touch_updated_at();

alter table public.sap_match_jobs enable row level security;
revoke all on public.sap_match_jobs from anon, authenticated;
grant all on public.sap_match_jobs to service_role;

create function public.enqueue_sap_match(
  p_user uuid,
  p_case uuid,
  p_force boolean default false
) returns jsonb language plpgsql set search_path='' as $$
declare c public.packet_cases; j public.sap_match_jobs;
begin
  select * into c from public.packet_cases
    where id=p_case and owner_user_id=p_user and deleted_at is null for update;
  if not found then raise exception 'Case not found.'; end if;
  if c.status not in ('completed','accepted','rejected') then
    raise exception 'Analyze the case before matching it to SAP.';
  end if;

  select * into j from public.sap_match_jobs where case_id=p_case for update;
  if found and not p_force then return to_jsonb(j); end if;

  insert into public.sap_match_jobs(case_id,owner_user_id)
  values(p_case,p_user)
  on conflict(case_id) do update set
    owner_user_id=excluded.owner_user_id,
    version=public.sap_match_jobs.version+1,
    status='queued',
    stage='Queued for SAP matching',
    result=null,
    error=null,
    attempt_count=0,
    next_run_at=now(),
    locked_at=null,
    locked_by=null,
    requested_at=now(),
    started_at=null,
    finished_at=null
  returning * into j;
  return to_jsonb(j);
end $$;

create function public.claim_sap_match_job(
  p_case uuid,
  p_worker text
) returns jsonb language plpgsql set search_path='' as $$
declare j public.sap_match_jobs;
begin
  select * into j from public.sap_match_jobs
    where case_id=p_case and status='queued' and next_run_at<=now()
    for update skip locked;
  if not found then return null; end if;
  if not exists(select 1 from public.packet_cases where id=p_case and deleted_at is null) then
    update public.sap_match_jobs set status='cancelled',stage='Cancelled',finished_at=now()
      where case_id=p_case;
    return null;
  end if;
  update public.sap_match_jobs set
    status='running',
    stage='Reading SAP documents',
    attempt_count=attempt_count+1,
    locked_at=now(),
    locked_by=p_worker,
    started_at=coalesce(started_at,now()),
    finished_at=null
    where case_id=p_case
    returning * into j;
  return to_jsonb(j);
end $$;

create function public.complete_sap_match_job(
  p_case uuid,
  p_version integer,
  p_worker text,
  p_result jsonb
) returns void language plpgsql set search_path='' as $$
begin
  update public.sap_match_jobs set
    status='succeeded',
    stage='SAP match ready',
    result=p_result,
    error=null,
    locked_at=null,
    locked_by=null,
    finished_at=now()
  where case_id=p_case and version=p_version and status='running' and locked_by=p_worker;
end $$;

create function public.fail_sap_match_job(
  p_case uuid,
  p_version integer,
  p_worker text,
  p_error text,
  p_retry boolean default true
) returns void language plpgsql set search_path='' as $$
declare j public.sap_match_jobs; retry boolean;
begin
  select * into j from public.sap_match_jobs
    where case_id=p_case and version=p_version and status='running' and locked_by=p_worker
    for update;
  if not found then return; end if;
  retry=p_retry and j.attempt_count<j.max_attempts;
  update public.sap_match_jobs set
    status=case when retry then 'queued' else 'failed' end,
    stage=case when retry then 'Retrying SAP match' else 'SAP match failed' end,
    error=left(p_error,1000),
    next_run_at=case when retry then now()+interval '30 seconds' else next_run_at end,
    locked_at=null,
    locked_by=null,
    finished_at=case when retry then null else now() end
  where case_id=p_case and version=p_version;
end $$;

create function public.recover_stale_sap_match_jobs()
returns void language plpgsql set search_path='' as $$
declare j record;
begin
  for j in select case_id,version,locked_by from public.sap_match_jobs
    where status='running' and locked_at<now()-interval '10 minutes'
  loop
    perform public.fail_sap_match_job(
      j.case_id,j.version,j.locked_by,
      'The SAP matching worker stopped reporting activity. Samrat scheduled an automatic retry.',true
    );
  end loop;
end $$;

-- Analyze first, then match automatically. Existing reviewable cases are
-- queued lazily the first time their SAP tab is opened.
create function public.queue_sap_match_after_analysis()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.deleted_at is null and new.status in ('completed','accepted','rejected')
     and (old.status is distinct from new.status) then
    insert into public.sap_match_jobs(case_id,owner_user_id)
    values(new.id,new.owner_user_id)
    on conflict(case_id) do update set
      owner_user_id=excluded.owner_user_id,
      version=public.sap_match_jobs.version+1,
      status='queued',stage='Queued for SAP matching',result=null,error=null,
      attempt_count=0,next_run_at=now(),locked_at=null,locked_by=null,
      requested_at=now(),started_at=null,finished_at=null;
  end if;
  return new;
end $$;

create trigger queue_sap_match_after_analysis
  after update of status on public.packet_cases
  for each row execute function public.queue_sap_match_after_analysis();

-- A packet cannot be approved without the actual PO document. A PO reference
-- printed on an invoice is not enough to prove the order or its terms.
create function public.require_purchase_order_before_approval()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status='accepted' and old.status is distinct from 'accepted'
     and not exists(
       select 1 from public.packet_documents
       where case_id=new.id and document_type in ('Purchase Order','Amended Purchase Order')
     ) then
    raise exception 'Approval is blocked until the Purchase Order document is added and the case is analyzed again.';
  end if;
  return new;
end $$;

create trigger require_purchase_order_before_approval
  before update of status on public.packet_cases
  for each row execute function public.require_purchase_order_before_approval();

do $$ declare f record; begin
  for f in
    select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'enqueue_sap_match','claim_sap_match_job','complete_sap_match_job',
      'fail_sap_match_job','recover_stale_sap_match_jobs',
      'queue_sap_match_after_analysis','require_purchase_order_before_approval'
    )
  loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

commit;
