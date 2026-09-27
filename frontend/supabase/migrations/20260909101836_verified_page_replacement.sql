begin;

create table public.packet_file_revisions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  case_file_id uuid not null references public.packet_case_files(id) on delete cascade,
  source_mismatch_id uuid references public.packet_mismatches(id) on delete set null,
  previous_asset_id uuid not null references public.storage_assets(id),
  candidate_asset_id uuid not null references public.storage_assets(id),
  replacement_asset_id uuid not null references public.storage_assets(id),
  page_number integer not null check (page_number > 0),
  review_details jsonb not null default '{}',
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(replacement_asset_id)
);

create index packet_file_revisions_case_created
  on public.packet_file_revisions(case_id, created_at desc, id);
create index packet_file_revisions_file_created
  on public.packet_file_revisions(case_file_id, created_at desc, id);

alter table public.packet_file_revisions enable row level security;
revoke all on public.packet_file_revisions from anon, authenticated;
grant all on public.packet_file_revisions to service_role;

create function public.commit_verified_page_replacement(
  p_user uuid,
  p_case uuid,
  p_case_file uuid,
  p_expected_asset uuid,
  p_candidate_asset uuid,
  p_replacement_asset uuid,
  p_mismatch uuid,
  p_page_number integer,
  p_review jsonb,
  p_options jsonb
) returns jsonb language plpgsql set search_path='' as $$
declare
  c public.packet_cases;
  f public.packet_case_files;
  candidate public.storage_assets;
  replacement public.storage_assets;
  previous_page_count integer;
  revision public.packet_file_revisions;
  j public.packet_processing_jobs;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));

  select * into c
  from public.packet_cases
  where id=p_case and owner_user_id=p_user and deleted_at is null
  for update;
  if not found then raise exception 'Case not found.'; end if;
  if c.status in ('accepted','rejected') then
    raise exception 'A finalized case cannot be changed.';
  end if;
  if c.status='processing' or exists(
    select 1 from public.packet_processing_jobs
    where case_id=p_case and status in ('queued','running')
  ) then
    raise exception 'Wait for the current analysis to finish before replacing a page.';
  end if;
  if coalesce((c.processing_meta->'splitAnalysis'->>'groupCount')::integer,0)>1 then
    raise exception 'This is a split case. Create a new case with the corrected documents to avoid changing sibling reviews.';
  end if;
  if p_page_number < 1 then raise exception 'Invalid replacement page.'; end if;
  if not exists(
    select 1 from public.packet_mismatches
    where id=p_mismatch and case_id=p_case and field_name='documentReadability'
  ) then
    raise exception 'The document-reading warning is no longer active. Refresh the case.';
  end if;

  select * into f
  from public.packet_case_files
  where id=p_case_file and case_id=p_case and storage_asset_id=p_expected_asset
  for update;
  if not found then
    raise exception 'The source file changed before the replacement was saved. Refresh and try again.';
  end if;

  select a.page_count into previous_page_count
  from public.storage_assets a
  where a.id=f.storage_asset_id;
  if previous_page_count is null or p_page_number > previous_page_count then
    raise exception 'The affected page is outside the stored file.';
  end if;

  select * into candidate
  from public.storage_assets
  where id=p_candidate_asset and owner_user_id=p_user
  for update;
  if not found or candidate.consumed_case_id is not null or candidate.page_count<>1 then
    raise exception 'Choose one unused image or one-page PDF as the replacement.';
  end if;

  select * into replacement
  from public.storage_assets
  where id=p_replacement_asset and owner_user_id=p_user
  for update;
  if not found or replacement.consumed_case_id is not null then
    raise exception 'The verified replacement file is no longer available.';
  end if;
  if replacement.page_count is null or replacement.page_count<>previous_page_count then
    raise exception 'The replacement changed the packet page count and was not saved.';
  end if;

  if (select count(*) from public.packet_processing_jobs where owner_user_id=p_user and created_at>now()-interval '1 day')>=40 then
    raise exception 'Daily analysis limit reached (40). Try again tomorrow.';
  end if;
  if (select count(*) from public.packet_processing_jobs where owner_user_id=p_user and status in ('queued','running'))>=3 then
    raise exception 'Three cases are already processing. Wait for one to finish.';
  end if;

  insert into public.packet_file_revisions(
    case_id, case_file_id, source_mismatch_id, previous_asset_id,
    candidate_asset_id, replacement_asset_id, page_number, review_details,
    created_by
  ) values(
    p_case, f.id, p_mismatch, f.storage_asset_id,
    candidate.id, replacement.id, p_page_number, p_review, p_user
  ) returning * into revision;

  update public.packet_case_files
  set storage_asset_id=replacement.id,
      original_name=replacement.original_name,
      content_sha256=replacement.content_sha256,
      storage_bucket=replacement.storage_bucket,
      storage_path=replacement.storage_path,
      mime_type=replacement.mime_type,
      size_bytes=replacement.size_bytes
  where id=f.id;

  update public.storage_assets
  set consumed_case_id=p_case
  where id in (candidate.id,replacement.id);

  insert into public.packet_processing_jobs(case_id,owner_user_id,stage,result)
  values(
    p_case,
    p_user,
    'Queued after verified page replacement',
    p_options||jsonb_build_object('replacementRevisionId',revision.id)
  ) returning * into j;

  update public.packet_cases
  set status='processing',
      upload_fingerprint=(
        select string_agg(content_sha256,':' order by content_sha256)
        from public.packet_case_files where case_id=p_case
      ),
      processing_meta=processing_meta||jsonb_build_object(
        'draft',false,
        'lastProcessingError',null,
        'lastPageReplacement',jsonb_build_object(
          'revisionId',revision.id,
          'pageNumber',p_page_number,
          'sourceFileName',f.original_name,
          'queuedAt',now()
        )
      )
  where id=p_case returning * into c;

  insert into public.case_review_events(case_id,owner_user_id,action,details)
  values(
    p_case,
    p_user,
    'document_page_replaced',
    jsonb_build_object(
      'revisionId',revision.id,
      'pageNumber',p_page_number,
      'sourceFileName',f.original_name,
      'mismatchId',p_mismatch,
      'jobId',j.id,
      'review',p_review
    )
  );

  return jsonb_build_object(
    'case',to_jsonb(c),
    'job',to_jsonb(j),
    'revisionId',revision.id
  );
end $$;

revoke all on function public.commit_verified_page_replacement(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.commit_verified_page_replacement(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,jsonb,jsonb)
  to service_role;

create or replace function public.orphan_uploads()
returns table(id uuid,storage_path text) language sql stable set search_path='' as $$
select a.id,a.storage_path
from public.storage_assets a
where a.created_at<now()-interval '25 hours'
  and not exists(select 1 from public.packet_case_files f where f.storage_asset_id=a.id)
  and not exists(
    select 1 from public.packet_file_revisions r
    where a.id in (r.previous_asset_id,r.candidate_asset_id,r.replacement_asset_id)
  )
order by a.created_at
limit 100;
$$;

revoke all on function public.orphan_uploads() from public,anon,authenticated;
grant execute on function public.orphan_uploads() to service_role;

commit;
