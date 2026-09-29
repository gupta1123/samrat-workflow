begin;

-- An invoice vendor (by GSTIN or printed name) remembered against a SAP vendor code,
-- so a vendor whose SAP name differs from the invoice is linked once and then found.
create table public.sap_vendor_mappings (
  id uuid primary key default gen_random_uuid(),
  vendor_key text not null unique,
  sap_card_code text not null,
  sap_card_name text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger touch_sap_vendor_mappings before update on public.sap_vendor_mappings
  for each row execute function public.touch_updated_at();

alter table public.sap_vendor_mappings enable row level security;
revoke all on public.sap_vendor_mappings from anon, authenticated;
grant all on public.sap_vendor_mappings to service_role;

commit;
