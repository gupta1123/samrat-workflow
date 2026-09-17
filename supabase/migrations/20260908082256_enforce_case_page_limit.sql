begin;

alter table public.storage_assets
  add column page_count integer check (page_count between 1 and 40);

-- Images always represent one uploaded page. PDF counts are populated only after
-- the API reads and verifies the immutable object bytes.
update public.storage_assets
set page_count = 1
where mime_type <> 'application/pdf';

create or replace function public.attach_case_uploads(p_user uuid,p_upload_ids uuid[],p_case_id uuid default null,p_mode text default 'append',p_allow_duplicate boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare c public.packet_cases; dupe public.packet_cases; fingerprint text; consumed uuid; asset_count integer; chosen uuid; total_pages integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
 if cardinality(p_upload_ids) not between 1 and 20 or p_mode not in ('append','overwrite') then raise exception 'Invalid upload request.'; end if;
 select count(*),string_agg(content_sha256,':' order by content_sha256) into asset_count,fingerprint from public.storage_assets where id=any(p_upload_ids) and owner_user_id=p_user;
 if asset_count<>cardinality(p_upload_ids) then raise exception 'Upload not found.'; end if;
 -- Lost-response retry: return the same case if this exact batch was already committed.
 select consumed_case_id into consumed from public.storage_assets where id=p_upload_ids[1];
 if consumed is not null and (p_case_id is null or p_case_id=consumed) and not exists(select 1 from public.storage_assets where id=any(p_upload_ids) and consumed_case_id is distinct from consumed) then
   select * into c from public.packet_cases where id=consumed and owner_user_id=p_user and deleted_at is null;
   if found then return jsonb_build_object('case',to_jsonb(c)); end if;
 end if;
 if exists(select 1 from public.storage_assets where id=any(p_upload_ids) and (consumed_case_id is not null or created_at<now()-interval '24 hours')) then raise exception 'This upload has expired or was already used. Select the files again.'; end if;
 if exists(select 1 from public.storage_assets where id=any(p_upload_ids) and page_count is null) then raise exception 'Upload page validation is incomplete. Select the files again.'; end if;
 if (select count(distinct lower(original_name)) from public.storage_assets where id=any(p_upload_ids))<>asset_count then raise exception 'Each file needs a different name.'; end if;
 if p_case_id is null then
   if not p_allow_duplicate then
     select * into dupe from public.packet_cases where owner_user_id=p_user and upload_fingerprint=fingerprint and deleted_at is null order by created_at limit 1;
     if found then return jsonb_build_object('duplicateCase',jsonb_build_object('id',dupe.id,'displayName',dupe.display_name,'status',dupe.status,'createdAt',dupe.created_at)); end if;
   end if;
   insert into public.packet_cases(owner_user_id,display_name,upload_fingerprint,processing_meta) values(p_user,'Case · '||to_char(now(),'DD Mon YYYY HH24:MI'),fingerprint,'{"draft":true}') returning * into c;
 else
   select * into c from public.packet_cases where id=p_case_id and owner_user_id=p_user and deleted_at is null for update;
   if not found then raise exception 'Case not found.'; end if;
   if coalesce((c.processing_meta->'splitAnalysis'->>'groupCount')::integer,0)>1 then raise exception 'This is a split case. Create a new case with only its corrected documents to avoid changing sibling reviews.'; end if;
   if c.status='processing' then raise exception 'Wait for the current analysis to finish before changing files.'; end if;
 end if;
 chosen=c.id;
 if p_mode='overwrite' then delete from public.packet_case_files where case_id=chosen and lower(original_name) in(select lower(original_name) from public.storage_assets where id=any(p_upload_ids)); end if;
 if exists(select 1 from public.packet_case_files f join public.storage_assets a on lower(a.original_name)=lower(f.original_name) where f.case_id=chosen and a.id=any(p_upload_ids)) then raise exception 'A file with that name already exists. Choose overwrite or rename the file.'; end if;
 insert into public.packet_case_files(case_id,storage_asset_id,original_name,content_sha256,storage_path,mime_type,size_bytes)
 select chosen,id,original_name,content_sha256,storage_path,mime_type,size_bytes from public.storage_assets where id=any(p_upload_ids);
 if (select count(*)>20 or sum(size_bytes)>104857600 from public.packet_case_files where case_id=chosen) then raise exception 'A case supports up to 20 files and 100 MB total.'; end if;
 if exists(select 1 from public.packet_case_files f join public.storage_assets a on a.id=f.storage_asset_id where f.case_id=chosen and a.page_count is null) then raise exception 'Case page validation is incomplete. Try again.'; end if;
 select coalesce(sum(a.page_count),0)::integer into total_pages from public.packet_case_files f join public.storage_assets a on a.id=f.storage_asset_id where f.case_id=chosen;
 if total_pages>40 then raise exception 'These files contain % pages. A case can contain a maximum of 40 pages. Remove at least % % and try again.', total_pages, total_pages-40, case when total_pages-40=1 then 'page' else 'pages' end; end if;
 update public.storage_assets set consumed_case_id=chosen where id=any(p_upload_ids);
 update public.packet_cases set status='draft',upload_count=(select count(*) from public.packet_case_files where case_id=chosen),
 upload_fingerprint=(select string_agg(content_sha256,':' order by content_sha256) from public.packet_case_files where case_id=chosen),
 processing_meta=processing_meta||jsonb_build_object('draft',true,'lastProcessingError',null) where id=chosen returning * into c;
 insert into public.case_review_events(case_id,owner_user_id,action,details) values(chosen,p_user,'files_added',jsonb_build_object('count',asset_count,'mode',p_mode,'pageCount',total_pages));
 return jsonb_build_object('case',to_jsonb(c));
end $$;

revoke all on function public.attach_case_uploads(uuid,uuid[],uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.attach_case_uploads(uuid,uuid[],uuid,text,boolean) to service_role;

commit;
