begin;

create table public.sap_postings (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('GRN', 'AP')),
  status text not null check (status in ('prepared', 'posted', 'failed', 'blocked')),
  sap_env text not null default 'test' check (sap_env in ('test', 'live')),
  sap_docnum text null,
  payload jsonb not null default '{}',
  response jsonb not null default '{}',
  error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(case_id, kind, sap_env)
);

create index sap_postings_case_created
  on public.sap_postings(case_id, created_at desc, id);
create index sap_postings_owner_created
  on public.sap_postings(owner_user_id, created_at desc, id);

-- Service-role only, like packet_file_revisions: every read/write goes through
-- the API routes with an ownedCase check on the admin client.
alter table public.sap_postings enable row level security;
revoke all on public.sap_postings from anon, authenticated;
grant all on public.sap_postings to service_role;

commit;
