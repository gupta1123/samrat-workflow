-- Samrat Group: run once in the SQL Editor of a NEW, dedicated Supabase project.
-- No accounting, bridge, bank-import, or external ERP tables are created.
begin;

create table public.packet_cases (
 id uuid primary key default gen_random_uuid(), owner_user_id uuid not null references auth.users(id) on delete cascade,
 slug text not null default 'new-case', display_name text not null default 'New case', buyer_name text, po_number text, invoice_number text,
 status text not null default 'draft' check(status in ('draft','processing','completed','accepted','rejected','failed')),
 risk_score integer not null default 0 check(risk_score between 0 and 100), upload_count integer not null default 0,
 document_count integer not null default 0, mismatch_count integer not null default 0,
 upload_fingerprint text, processing_meta jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
 deleted_by_user_id uuid references auth.users(id) on delete set null
);
create index cases_owner_created on public.packet_cases(owner_user_id,created_at desc,id);
create index cases_owner_fingerprint on public.packet_cases(owner_user_id,upload_fingerprint) where deleted_at is null;
create index cases_owner_status on public.packet_cases(owner_user_id,status) where deleted_at is null;

create table public.storage_assets (
 id uuid primary key default gen_random_uuid(), owner_user_id uuid not null references auth.users(id) on delete cascade,
 storage_bucket text not null default 'packet-files' check(storage_bucket='packet-files'), storage_path text not null unique,
 original_name text not null, content_sha256 text not null check(content_sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes bigint not null check(size_bytes between 1 and 52428800), mime_type text not null,
 consumed_case_id uuid, created_at timestamptz not null default now()
);
create index assets_owner_created on public.storage_assets(owner_user_id,created_at);
create table public.packet_case_files (
 id uuid primary key default gen_random_uuid(), case_id uuid not null references public.packet_cases(id) on delete cascade,
 storage_asset_id uuid not null references public.storage_assets(id), original_name text not null,
 content_sha256 text not null, storage_bucket text not null default 'packet-files', storage_path text not null,
 mime_type text, size_bytes bigint, created_at timestamptz not null default now(), unique(case_id,original_name)
);
create index files_asset on public.packet_case_files(storage_asset_id);
create table public.packet_documents (
 id uuid primary key default gen_random_uuid(), case_id uuid not null references public.packet_cases(id) on delete cascade,
 client_document_id text not null, source_file_name text, source_hint text, document_type text not null,
 title text not null, page_count integer not null default 1 check(page_count>0), extracted_fields jsonb not null default '{}',
 markdown text not null default '', created_at timestamptz not null default now(), unique(case_id,client_document_id)
);
create table public.packet_mismatches (
 id uuid primary key default gen_random_uuid(), case_id uuid not null references public.packet_cases(id) on delete cascade,
 client_mismatch_id text not null, field_name text not null, values_json jsonb not null default '[]', analysis text, fix_plan text,
 resolution_status text not null default 'pending' check(resolution_status in ('pending','accepted','rejected')),
 resolved_at timestamptz, resolved_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(), unique(case_id,client_mismatch_id)
);
create table public.packet_processing_jobs (
 id uuid primary key default gen_random_uuid(), case_id uuid not null references public.packet_cases(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id) on delete cascade, job_type text not null default 'case_analysis',
 status text not null default 'queued' check(status in ('queued','running','succeeded','failed','cancelled')),
 attempt_count integer not null default 0, max_attempts integer not null default 2,
 progress integer not null default 0 check(progress between 0 and 100), stage text, error text, result jsonb not null default '{}',
 locked_at timestamptz, locked_by text, next_run_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index jobs_one_active_case on public.packet_processing_jobs(case_id) where status in ('queued','running');
create index jobs_case_created on public.packet_processing_jobs(case_id,created_at desc);
create index jobs_owner_created on public.packet_processing_jobs(owner_user_id,created_at);
create index jobs_queue on public.packet_processing_jobs(next_run_at) where status='queued';
create table public.case_review_events (
 id bigint generated always as identity primary key, case_id uuid not null,
 owner_user_id uuid not null references auth.users(id) on delete cascade, action text not null, details jsonb not null default '{}', created_at timestamptz not null default now()
);
create index events_case on public.case_review_events(case_id,created_at);
create index events_owner on public.case_review_events(owner_user_id);
create table public.field_settings (
 id uuid primary key default gen_random_uuid(), organization_id text not null default 'default', doc_type text not null,
 field_key text not null, enabled boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(organization_id,doc_type,field_key)
);
create table public.doc_type_settings (
 id uuid primary key default gen_random_uuid(), organization_id text not null default 'default', doc_type text not null,
 enabled boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(organization_id,doc_type)
);
create table public.comparison_field_groups (
 id uuid primary key default gen_random_uuid(), organization_id text not null default 'default', group_key text not null,
 label text not null, fields jsonb not null default '[]', enabled boolean not null default true, sort_order integer not null default 10,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(organization_id,group_key)
);
-- Uploaded bank statements are not part of the Samrat review workflow.
insert into public.doc_type_settings(doc_type,enabled) values ('Bank Statement',false);

create function public.touch_updated_at() returns trigger language plpgsql set search_path='' as $$
begin new.updated_at=now(); return new; end $$;
create trigger touch_cases before update on public.packet_cases for each row execute function public.touch_updated_at();
create trigger touch_jobs before update on public.packet_processing_jobs for each row execute function public.touch_updated_at();

-- All mutations go through the authenticated same-origin API. These functions are
-- SECURITY INVOKER and their EXECUTE grants are restricted to service_role below.
create function public.reserve_upload(p_id uuid,p_user uuid,p_path text,p_name text,p_size bigint,p_sha text,p_mime text)
returns void language plpgsql set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
 if (select count(*) from public.storage_assets where owner_user_id=p_user and created_at>now()-interval '1 day')>=200 then raise exception 'Daily upload limit reached. Try again tomorrow.'; end if;
 insert into public.storage_assets(id,owner_user_id,storage_path,original_name,size_bytes,content_sha256,mime_type) values(p_id,p_user,p_path,p_name,p_size,p_sha,p_mime);
end $$;

create function public.attach_case_uploads(p_user uuid,p_upload_ids uuid[],p_case_id uuid default null,p_mode text default 'append',p_allow_duplicate boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare c public.packet_cases; dupe public.packet_cases; fingerprint text; consumed uuid; asset_count integer; chosen uuid;
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
 update public.storage_assets set consumed_case_id=chosen where id=any(p_upload_ids);
 update public.packet_cases set status='draft',upload_count=(select count(*) from public.packet_case_files where case_id=chosen),
 upload_fingerprint=(select string_agg(content_sha256,':' order by content_sha256) from public.packet_case_files where case_id=chosen),
 processing_meta=processing_meta||jsonb_build_object('draft',true,'lastProcessingError',null) where id=chosen returning * into c;
 insert into public.case_review_events(case_id,owner_user_id,action,details) values(chosen,p_user,'files_added',jsonb_build_object('count',asset_count,'mode',p_mode));
 return jsonb_build_object('case',to_jsonb(c));
end $$;

create function public.case_counts(p_user uuid) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('total',count(*),'review',count(*) filter(where status='completed'),'processing',count(*) filter(where status='processing'),'accepted',count(*) filter(where status='accepted')) from public.packet_cases where owner_user_id=p_user and deleted_at is null;
$$;

create function public.decide_case(p_user uuid,p_case uuid,p_action text) returns jsonb language plpgsql set search_path='' as $$
declare c public.packet_cases;
begin
 select * into c from public.packet_cases where id=p_case and owner_user_id=p_user for update;
 if not found then raise exception 'Case not found.'; end if;
 if p_action in ('accept','reject') then
   if c.deleted_at is not null or c.status not in ('completed','accepted','rejected') then raise exception 'Only an analyzed case can be reviewed.'; end if;
   if p_action='accept' and exists(select 1 from public.packet_mismatches where case_id=p_case and resolution_status<>'accepted') then raise exception 'Review and accept every issue before accepting this case.'; end if;
   update public.packet_cases set status=case p_action when 'accept' then 'accepted' else 'rejected' end where id=p_case returning * into c;
 elsif p_action='recycle' then
   update public.packet_processing_jobs set status='cancelled',stage='Cancelled',finished_at=now(),locked_by=null where case_id=p_case and status in ('queued','running');
   update public.packet_cases set deleted_at=now(),deleted_by_user_id=p_user,status=case when status='processing' then 'draft' else status end where id=p_case returning * into c;
 elsif p_action='restore' then
   update public.packet_cases set deleted_at=null,deleted_by_user_id=null where id=p_case returning * into c;
 elsif p_action='delete' then
   if c.deleted_at is null then raise exception 'Move the case to the recycle bin before permanent deletion.'; end if;
   delete from public.packet_cases where id=p_case;
 else raise exception 'Invalid case action.';
 end if;
 insert into public.case_review_events(case_id,owner_user_id,action) values(p_case,p_user,p_action);
 return to_jsonb(c);
end $$;

create function public.resolve_mismatches(p_user uuid,p_case uuid,p_ids uuid[],p_decision text) returns jsonb language plpgsql set search_path='' as $$
declare c public.packet_cases; result jsonb; next_status text;
begin
 select * into c from public.packet_cases where id=p_case and owner_user_id=p_user and deleted_at is null for update;
 if not found or c.status not in ('completed','accepted','rejected') then raise exception 'This case is not ready for review.'; end if;
 if p_decision not in ('accepted','rejected') or cardinality(p_ids)<1 or (select count(*) from public.packet_mismatches where case_id=p_case and id=any(p_ids))<>cardinality(p_ids) then raise exception 'Invalid issues or decision.'; end if;
 update public.packet_mismatches set resolution_status=p_decision,resolved_at=now(),resolved_by=p_user where case_id=p_case and id=any(p_ids);
 next_status=case when not exists(select 1 from public.packet_mismatches where case_id=p_case and resolution_status<>'accepted') then 'accepted' else 'completed' end;
 update public.packet_cases set status=next_status where id=p_case;
 select jsonb_agg(jsonb_build_object('id',id,'resolutionStatus',resolution_status,'resolvedAt',resolved_at)) into result from public.packet_mismatches where case_id=p_case and id=any(p_ids);
 insert into public.case_review_events(case_id,owner_user_id,action,details) values(p_case,p_user,'issues_'||p_decision,jsonb_build_object('issueIds',p_ids));
 return jsonb_build_object('caseStatus',next_status,'mismatches',result);
end $$;

create function public.enqueue_case_analysis(p_user uuid,p_case uuid,p_options jsonb) returns jsonb language plpgsql set search_path='' as $$
declare c public.packet_cases; j public.packet_processing_jobs;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
 select * into c from public.packet_cases where id=p_case and owner_user_id=p_user and deleted_at is null for update;
 if not found then raise exception 'Case not found.'; end if;
 select * into j from public.packet_processing_jobs where case_id=p_case and status in ('queued','running');
 if found then return jsonb_build_object('case',to_jsonb(c),'job',to_jsonb(j)); end if;
 if coalesce((c.processing_meta->'splitAnalysis'->>'groupCount')::integer,0)>1 then raise exception 'This is a split case. Create a new case with only its corrected documents to avoid duplicating sibling cases.'; end if;
 if not exists(select 1 from public.packet_case_files where case_id=p_case) then raise exception 'Add documents before starting analysis.'; end if;
 if (select count(*) from public.packet_processing_jobs where owner_user_id=p_user and created_at>now()-interval '1 day')>=40 then raise exception 'Daily analysis limit reached (40). Try again tomorrow.'; end if;
 if (select count(*) from public.packet_processing_jobs where owner_user_id=p_user and status in ('queued','running'))>=3 then raise exception 'Three cases are already processing. Wait for one to finish.'; end if;
 insert into public.packet_processing_jobs(case_id,owner_user_id,stage,result) values(p_case,p_user,'Queued for review',p_options) returning * into j;
 update public.packet_cases set status='processing',processing_meta=processing_meta||jsonb_build_object('lastProcessingError',null) where id=p_case returning * into c;
 return jsonb_build_object('case',to_jsonb(c),'job',to_jsonb(j));
end $$;

create function public.claim_case_job(p_job uuid,p_worker text) returns jsonb language plpgsql set search_path='' as $$
declare j public.packet_processing_jobs;
begin
 select * into j from public.packet_processing_jobs where id=p_job and status='queued' and next_run_at<=now() for update skip locked;
 if not found then return null; end if;
 if not exists(select 1 from public.packet_cases where id=j.case_id and deleted_at is null) then
   update public.packet_processing_jobs set status='cancelled',finished_at=now() where id=j.id; return null;
 end if;
 update public.packet_processing_jobs set status='running',attempt_count=attempt_count+1,locked_at=now(),locked_by=p_worker,started_at=coalesce(started_at,now()),stage='Preparing documents',progress=1 where id=j.id returning * into j;
 return to_jsonb(j);
end $$;

create function public.fail_case_job(p_job uuid,p_worker text,p_error text,p_retry boolean default true) returns void language plpgsql set search_path='' as $$
declare j public.packet_processing_jobs; retry boolean;
begin
 -- Lock the case first, matching completion/deletion/review lock order.
 perform 1 from public.packet_cases where id=(select case_id from public.packet_processing_jobs where id=p_job) for update;
 select * into j from public.packet_processing_jobs where id=p_job and status='running' and locked_by=p_worker for update;
 if not found then return; end if;
 retry=p_retry and j.attempt_count<j.max_attempts;
 update public.packet_processing_jobs set status=case when retry then 'queued' else 'failed' end,stage=case when retry then 'Retry scheduled' else 'Analysis failed' end,error=left(p_error,1000),locked_by=null,locked_at=null,next_run_at=now()+interval '1 minute',finished_at=case when retry then null else now() end where id=p_job;
 update public.packet_cases set status=case when retry then 'processing' else 'failed' end,processing_meta=processing_meta||jsonb_build_object('lastProcessingError',left(p_error,1000)) where id=j.case_id;
end $$;

-- Prepare all model outputs first, then commit every document, issue and sibling
-- case in one transaction. A failed or superseded run cannot erase prior results.
create function public.complete_case_job(p_job uuid,p_worker text,p_groups jsonb,p_result jsonb) returns void language plpgsql set search_path='' as $$
declare j public.packet_processing_jobs; c public.packet_cases; g jsonb; d jsonb; m jsonb; target uuid; idx integer=0; source_meta jsonb;
begin
 select * into c from public.packet_cases where id=(select case_id from public.packet_processing_jobs where id=p_job) and deleted_at is null for update;
 if not found then raise exception 'Case no longer exists.'; end if;
 select * into j from public.packet_processing_jobs where id=p_job and status='running' and locked_by=p_worker for update;
 if not found then raise exception 'Processing lease was superseded.'; end if;
 if jsonb_array_length(p_groups)<1 then raise exception 'No analysis results.'; end if;
 source_meta=c.processing_meta;
 for g in select value from jsonb_array_elements(p_groups) loop
   idx=idx+1;
   if jsonb_array_length(g->'documents')<1 then raise exception 'No documents were extracted.'; end if;
   if idx=1 then target=c.id;
   else
     target=(g->>'id')::uuid;
     insert into public.packet_cases(id,owner_user_id) values(target,c.owner_user_id);
     insert into public.packet_case_files(case_id,storage_asset_id,original_name,content_sha256,storage_bucket,storage_path,mime_type,size_bytes)
     select target,storage_asset_id,original_name,content_sha256,storage_bucket,storage_path,mime_type,size_bytes from public.packet_case_files where case_id=c.id and original_name in(select jsonb_array_elements_text(g->'sourceFileNames'));
     if not found then raise exception 'Split case has no source files.'; end if;
   end if;
   delete from public.packet_documents where case_id=target;
   delete from public.packet_mismatches where case_id=target;
   for d in select value from jsonb_array_elements(g->'documents') loop
     insert into public.packet_documents(case_id,client_document_id,source_file_name,source_hint,document_type,title,page_count,extracted_fields,markdown)
     values(target,d->>'id',d->>'sourceFileName',d->>'sourceHint',d->>'type',d->>'title',(d->>'pages')::integer,d->'fields',coalesce(d->>'md',''));
   end loop;
   for m in select value from jsonb_array_elements(g->'mismatches') loop
     insert into public.packet_mismatches(case_id,client_mismatch_id,field_name,values_json,analysis,fix_plan)
     values(target,m->>'id',m->>'field',m->'values',m->>'analysis',m->>'fixPlan');
   end loop;
   update public.packet_cases set slug=g->'summary'->>'slug',display_name=g->>'displayName',buyer_name=g->'summary'->>'buyerName',
    po_number=g->'summary'->>'poNumber',invoice_number=g->'summary'->>'invoiceNumber',status='completed',risk_score=(g->'summary'->>'riskScore')::integer,
    document_count=jsonb_array_length(g->'documents'),mismatch_count=jsonb_array_length(g->'mismatches'),upload_count=(select count(*) from public.packet_case_files where case_id=target),
    processing_meta=(case when idx=1 then source_meta else '{}'::jsonb end)||g->'meta'||jsonb_build_object('draft',false,'analyzedAt',now(),'lastProcessingError',null)
    where id=target;
   insert into public.case_review_events(case_id,owner_user_id,action,details) values(target,c.owner_user_id,'analysis_completed',jsonb_build_object('jobId',j.id));
 end loop;
 update public.packet_processing_jobs set status='succeeded',stage='Completed',progress=100,result=result||p_result,error=null,finished_at=now(),locked_by=null where id=p_job;
end $$;

create function public.recover_stale_case_jobs() returns void language plpgsql set search_path='' as $$
declare j record;
begin
 for j in select id,locked_by from public.packet_processing_jobs where status='running' and locked_at<now()-interval '20 minutes' loop
   perform public.fail_case_job(j.id,j.locked_by,'Processing timed out. Use fewer pages if this repeats.',true);
 end loop;
end $$;

create function public.save_review_settings(p_fields jsonb,p_docs jsonb,p_groups jsonb) returns void language plpgsql set search_path='' as $$
declare r jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('samrat-review-settings',0));
 delete from public.field_settings where organization_id='default';
 delete from public.doc_type_settings where organization_id='default';
 delete from public.comparison_field_groups where organization_id='default';
 for r in select value from jsonb_array_elements(p_fields) loop
   insert into public.field_settings(doc_type,field_key,enabled) values(r->>'doc_type',r->>'field_key',(r->>'enabled')::boolean);
 end loop;
 for r in select value from jsonb_array_elements(p_docs) loop
   insert into public.doc_type_settings(doc_type,enabled) values(r->>'doc_type',(r->>'enabled')::boolean);
 end loop;
 insert into public.doc_type_settings(doc_type,enabled) values('Bank Statement',false) on conflict(organization_id,doc_type) do update set enabled=false;
 for r in select value from jsonb_array_elements(p_groups) loop
   insert into public.comparison_field_groups(group_key,label,fields,enabled,sort_order) values(r->>'groupKey',r->>'label',r->'fields',(r->>'enabled')::boolean,(r->>'sortOrder')::integer);
 end loop;
end $$;

create function public.orphan_uploads() returns table(id uuid,storage_path text) language sql stable set search_path='' as $$
select a.id,a.storage_path from public.storage_assets a where a.created_at<now()-interval '25 hours' and not exists(select 1 from public.packet_case_files f where f.storage_asset_id=a.id) order by a.created_at limit 100;
$$;

-- Defense in depth: clients can read only their own cases. Writes and internal
-- queues/settings are restricted to the server. No user can choose another owner.
do $$ declare t text; begin
 foreach t in array array['packet_cases','packet_case_files','packet_documents','packet_mismatches','packet_processing_jobs','storage_assets','case_review_events','field_settings','doc_type_settings','comparison_field_groups'] loop
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from anon, authenticated',t);
   execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
grant select on public.packet_cases,public.packet_case_files,public.packet_documents,public.packet_mismatches to authenticated;
grant usage,select on sequence public.case_review_events_id_seq to service_role;
create policy own_cases on public.packet_cases for select to authenticated using(owner_user_id=(select auth.uid()));
create policy own_files on public.packet_case_files for select to authenticated using(exists(select 1 from public.packet_cases c where c.id=case_id and c.owner_user_id=(select auth.uid())));
create policy own_documents on public.packet_documents for select to authenticated using(exists(select 1 from public.packet_cases c where c.id=case_id and c.owner_user_id=(select auth.uid())));
create policy own_mismatches on public.packet_mismatches for select to authenticated using(exists(select 1 from public.packet_cases c where c.id=case_id and c.owner_user_id=(select auth.uid())));
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('touch_updated_at','reserve_upload','attach_case_uploads','case_counts','decide_case','resolve_mismatches','enqueue_case_analysis','claim_case_job','fail_case_job','complete_case_job','recover_stale_case_jobs','save_review_settings','orphan_uploads') loop
   execute format('revoke all on function %s from public,anon,authenticated',f.signature);
   execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;

-- Private bucket. No anonymous/public Storage policies. Signed upload/download
-- capabilities are issued only by authenticated, ownership-checked API routes.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('packet-files','packet-files',false,52428800,array['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif','application/octet-stream']);
commit;
