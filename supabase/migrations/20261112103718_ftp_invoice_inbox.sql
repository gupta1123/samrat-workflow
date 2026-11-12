begin;

create table if not exists public.ftp_invoice_inbox (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  modified_at text,
  discovered_at timestamptz not null default now(),
  present boolean not null default true,
  status text not null default 'copying' check (status in (
    'copying', 'ready', 'queued', 'importing', 'analyzing', 'failed',
    'archive_pending', 'archived', 'missing'
  )),
  requested_at timestamptz,
  owner_user_id uuid references auth.users(id) on delete set null,
  case_id uuid references public.packet_cases(id) on delete set null,
  analysis_job_id uuid references public.packet_processing_jobs(id) on delete set null,
  sha256 text,
  archive_name text,
  next_archive_at timestamptz,
  error text
);
create unique index if not exists ftp_invoice_inbox_active_name
  on public.ftp_invoice_inbox(file_name) where present;
create index if not exists ftp_invoice_inbox_state on public.ftp_invoice_inbox(status, requested_at);
create index if not exists ftp_invoice_inbox_sha on public.ftp_invoice_inbox(sha256) where case_id is not null;

create table if not exists public.ftp_invoice_sync (
  id integer primary key check (id = 1),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  error text,
  lease_until timestamptz not null default '-infinity',
  lock_token uuid
);
insert into public.ftp_invoice_sync(id) values (1) on conflict do nothing;

alter table public.ftp_invoice_inbox enable row level security;
alter table public.ftp_invoice_sync enable row level security;
revoke all on public.ftp_invoice_inbox, public.ftp_invoice_sync from public, anon, authenticated;
grant all on public.ftp_invoice_inbox, public.ftp_invoice_sync to service_role;

commit;
