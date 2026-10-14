-- Optional registration for organizations with explicit field allowlists.
-- Supply nature is stored in the existing extracted_fields JSONB; no new
-- table or column is required. Preserve disabled settings and unconfigured types.
begin;
with additions(doc_type, field_key) as (
  values ('Invoice', 'servicePeriod'), ('Tax Invoice', 'servicePeriod')
), configured as (
  select distinct organization_id, doc_type from public.field_settings
)
insert into public.field_settings (organization_id, doc_type, field_key, enabled)
select configured.organization_id, additions.doc_type, additions.field_key, true
from configured join additions using (doc_type)
on conflict (organization_id, doc_type, field_key) do nothing;
commit;
