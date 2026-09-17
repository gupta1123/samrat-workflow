-- Index the exact access paths used by the case list, detail, review, job
-- recovery, and local cleanup screens. Partial indexes keep the common active
-- case paths small while preserving separate support for the recycle bin.

create index if not exists cases_active_owner_created
  on public.packet_cases(owner_user_id, created_at desc, id)
  where deleted_at is null;

create index if not exists cases_deleted_owner_created
  on public.packet_cases(owner_user_id, created_at desc, id)
  where deleted_at is not null;

create index if not exists cases_active_owner_status_created
  on public.packet_cases(owner_user_id, status, created_at desc, id)
  where deleted_at is null;

create index if not exists cases_active_owner_name
  on public.packet_cases(owner_user_id, display_name, id)
  where deleted_at is null;

create index if not exists case_files_case_created
  on public.packet_case_files(case_id, created_at, id);

create index if not exists documents_case_created
  on public.packet_documents(case_id, created_at, id);

create index if not exists mismatches_case_created
  on public.packet_mismatches(case_id, created_at, id);

create index if not exists mismatches_case_resolution
  on public.packet_mismatches(case_id, resolution_status);

create index if not exists jobs_owner_status_created
  on public.packet_processing_jobs(owner_user_id, status, created_at desc);

create index if not exists jobs_running_locked
  on public.packet_processing_jobs(locked_at)
  where status = 'running';

create index if not exists storage_assets_created
  on public.storage_assets(created_at, id);

analyze public.packet_cases;
analyze public.packet_case_files;
analyze public.packet_documents;
analyze public.packet_mismatches;
analyze public.packet_processing_jobs;
analyze public.storage_assets;
