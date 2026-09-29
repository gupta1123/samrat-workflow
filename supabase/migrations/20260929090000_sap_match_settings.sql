begin;

-- One shared set of matching rules for this installation (the app has one admin).
create table public.sap_match_rules (
  organization_id text primary key default 'default',
  qty_tolerance_pct numeric not null default 1 check (qty_tolerance_pct between 0 and 100),
  rate_tolerance_pct numeric not null default 0.5 check (rate_tolerance_pct between 0 and 100),
  freight_policy text not null default 'expense' check (freight_policy in ('expense','item','separate')),
  posting_date text not null default 'invoice' check (posting_date in ('invoice','today')),
  receipt_window_days integer not null default 30 check (receipt_window_days between 0 and 365),
  branches jsonb not null default '[]'::jsonb check (jsonb_typeof(branches) = 'array'),
  updated_at timestamptz not null default now()
);
insert into public.sap_match_rules(organization_id) values ('default');

-- The vendor's own material code (e.g. Tata 3434405) remembered against a SAP item.
create table public.sap_item_mappings (
  id uuid primary key default gen_random_uuid(),
  vendor_card_code text not null,
  vendor_item_key text not null,
  sap_item_code text not null,
  sap_item_name text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_card_code, vendor_item_key)
);

-- What the admin decided while matching one case: confirmations with reasons
-- and any manual receipt selection. The engine re-reads SAP every time, so only
-- decisions are stored, never a copy of SAP data.
create table public.sap_match_state (
  case_id uuid primary key references public.packet_cases(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  decisions jsonb not null default '{}'::jsonb check (jsonb_typeof(decisions) = 'object'),
  allocations jsonb not null default '{}'::jsonb check (jsonb_typeof(allocations) = 'object'),
  updated_at timestamptz not null default now()
);

create trigger touch_sap_match_rules before update on public.sap_match_rules
  for each row execute function public.touch_updated_at();
create trigger touch_sap_item_mappings before update on public.sap_item_mappings
  for each row execute function public.touch_updated_at();
create trigger touch_sap_match_state before update on public.sap_match_state
  for each row execute function public.touch_updated_at();

-- Service-role only, like sap_postings: every read and write goes through the
-- API routes, which check case ownership first.
do $$ declare t text; begin
  foreach t in array array['sap_match_rules','sap_item_mappings','sap_match_state'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

commit;
