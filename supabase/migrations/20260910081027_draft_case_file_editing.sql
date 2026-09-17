begin;

-- Draft packet edits are committed in one short transaction so the browser
-- cannot leave the visible file list out of sync with the case that will be
-- analyzed. The API resolves the authenticated owner before invoking this
-- service-role-only function.
create function public.edit_draft_case_file(
  p_user uuid,
  p_case uuid,
  p_file uuid,
  p_action text,
  p_upload uuid default null
) returns jsonb language plpgsql set search_path='' as $$
declare
  c public.packet_cases;
  current_file public.packet_case_files;
  candidate public.storage_assets;
  total_files integer;
  total_bytes bigint;
  total_pages integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));

  select * into c
  from public.packet_cases
  where id=p_case and owner_user_id=p_user and deleted_at is null
  for update;
  if not found then raise exception 'Case not found.'; end if;
  if c.status<>'draft'
     or c.processing_meta->>'draft' is distinct from 'true'
     or exists(select 1 from public.packet_processing_jobs where case_id=p_case)
     or exists(select 1 from public.packet_documents where case_id=p_case) then
    raise exception 'Documents can only be changed before analysis starts.';
  end if;
  if p_action not in ('remove','replace') then
    raise exception 'Invalid draft file action.';
  end if;

  select * into current_file
  from public.packet_case_files
  where id=p_file and case_id=p_case
  for update;
  if not found then raise exception 'Document not found. Refresh and try again.'; end if;

  if p_action='replace' then
    if p_upload is null then raise exception 'Choose a replacement document.'; end if;
    select * into candidate
    from public.storage_assets
    where id=p_upload and owner_user_id=p_user
    for update;
    if not found then raise exception 'Replacement upload not found.'; end if;
    if candidate.consumed_case_id is not null
       or candidate.created_at<now()-interval '24 hours' then
      raise exception 'This replacement upload has expired or was already used. Select it again.';
    end if;
    if candidate.page_count is null then
      raise exception 'Replacement page validation is incomplete. Select the file again.';
    end if;
    if exists(
      select 1 from public.packet_case_files
      where case_id=p_case
        and id<>p_file
        and lower(original_name)=lower(candidate.original_name)
    ) then
      raise exception 'A file with that name already exists. Rename the replacement and try again.';
    end if;
    if exists(
      select 1
      from public.packet_case_files f
      join public.storage_assets a on a.id=f.storage_asset_id
      where f.case_id=p_case and a.page_count is null
    ) then
      raise exception 'Case page validation is incomplete. Try again.';
    end if;

    select count(*)::integer,
           coalesce(sum(case when f.id=p_file then candidate.size_bytes else f.size_bytes end),0)::bigint,
           coalesce(sum(case when f.id=p_file then candidate.page_count else a.page_count end),0)::integer
      into total_files,total_bytes,total_pages
    from public.packet_case_files f
    join public.storage_assets a on a.id=f.storage_asset_id
    where f.case_id=p_case;

    if total_files>20 or total_bytes>104857600 then
      raise exception 'A case supports up to 20 files and 100 MB total.';
    end if;
    if total_pages>40 then
      raise exception 'These files contain % pages. A case can contain a maximum of 40 pages. Remove at least % % and try again.',
        total_pages,
        total_pages-40,
        case when total_pages-40=1 then 'page' else 'pages' end;
    end if;

    update public.packet_case_files
    set storage_asset_id=candidate.id,
        original_name=candidate.original_name,
        content_sha256=candidate.content_sha256,
        storage_bucket=candidate.storage_bucket,
        storage_path=candidate.storage_path,
        mime_type=candidate.mime_type,
        size_bytes=candidate.size_bytes
    where id=current_file.id;

    update public.storage_assets
    set consumed_case_id=p_case
    where id=candidate.id;

    update public.storage_assets
    set consumed_case_id=null
    where id=current_file.storage_asset_id
      and consumed_case_id=p_case
      and not exists(
        select 1 from public.packet_case_files
        where storage_asset_id=current_file.storage_asset_id
      );

    insert into public.case_review_events(case_id,owner_user_id,action,details)
    values(
      p_case,
      p_user,
      'draft_file_replaced',
      jsonb_build_object(
        'fileId',current_file.id,
        'previousName',current_file.original_name,
        'replacementName',candidate.original_name
      )
    );
  else
    delete from public.packet_case_files where id=current_file.id;

    update public.storage_assets
    set consumed_case_id=null
    where id=current_file.storage_asset_id
      and consumed_case_id=p_case
      and not exists(
        select 1 from public.packet_case_files
        where storage_asset_id=current_file.storage_asset_id
      );

    insert into public.case_review_events(case_id,owner_user_id,action,details)
    values(
      p_case,
      p_user,
      'draft_file_removed',
      jsonb_build_object('fileId',current_file.id,'fileName',current_file.original_name)
    );
  end if;

  update public.packet_cases
  set status='draft',
      upload_count=(select count(*) from public.packet_case_files where case_id=p_case),
      upload_fingerprint=(
        select string_agg(content_sha256,':' order by content_sha256)
        from public.packet_case_files where case_id=p_case
      ),
      processing_meta=processing_meta||jsonb_build_object('draft',true,'lastProcessingError',null)
  where id=p_case
  returning * into c;

  return jsonb_build_object('case',to_jsonb(c));
end $$;

revoke all on function public.edit_draft_case_file(uuid,uuid,uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.edit_draft_case_file(uuid,uuid,uuid,text,uuid)
  to service_role;

commit;
