-- Apply manually after reviewing. This does not modify extracted documents,
-- rerun analysis, or overwrite explicitly disabled fields.
--
-- packet_documents.extracted_fields is already JSONB. New logisticsRows are
-- stored under __logisticsRows; no table/column migration is necessary.
-- For organizations using a complete field allowlist, register the additions.
-- Do not create partial settings for unconfigured document types: they already
-- use the updated application defaults, and a partial allowlist would disable
-- their other fields.
begin;

with additions(doc_type, field_key) as (
  values
    ('Invoice', 'paymentTerms'), ('Invoice', 'materialValue'),
    ('Invoice', 'totalTaxableAmount'), ('Invoice', 'cgstAmount'),
    ('Invoice', 'sgstAmount'), ('Invoice', 'igstAmount'),
    ('Tax Invoice', 'paymentTerms'), ('Tax Invoice', 'materialValue'),
    ('Tax Invoice', 'totalTaxableAmount'), ('Tax Invoice', 'cgstAmount'),
    ('Tax Invoice', 'sgstAmount'), ('Tax Invoice', 'igstAmount'),
    ('Purchase Order', 'cgstAmount'), ('Purchase Order', 'sgstAmount'),
    ('Purchase Order', 'igstAmount'), ('Purchase Order', 'totalTaxableAmount'),
    ('Amended Purchase Order', 'cgstAmount'), ('Amended Purchase Order', 'sgstAmount'),
    ('Amended Purchase Order', 'igstAmount'), ('Amended Purchase Order', 'totalTaxableAmount'),
    ('E-Way Bill', 'cgstAmount'), ('E-Way Bill', 'sgstAmount'),
    ('E-Way Bill', 'igstAmount'), ('E-Way Bill', 'itemDescription'), ('E-Way Bill', 'goodsValue'),
    ('E-Way Bill', 'itemQuantity'), ('E-Way Bill', 'unit'), ('E-Way Bill', 'hsnSac'),
    ('Lorry Receipt', 'deliveryOrderNumber'), ('Lorry Receipt', 'itemDescription'),
    ('Lorry Receipt', 'itemQuantity'), ('Lorry Receipt', 'unit'),
    ('Weighment Slip', 'buyerName'), ('Weighment Slip', 'itemDescription'),
    ('Weighment Slip', 'itemQuantity'), ('Weighment Slip', 'unit'),
    ('Material Test Certificate', 'bisLicenseNumber'),
    ('Material Test Certificate', 'certificateDate'),
    ('Material Test Certificate', 'documentDate'),
    ('Material Test Certificate', 'buyerName'),
    ('Material Test Certificate', 'itemDescription'),
    ('Material Test Certificate', 'materialGrade')
), configured as (
  select distinct organization_id, doc_type from public.field_settings
)
insert into public.field_settings (organization_id, doc_type, field_key, enabled)
select configured.organization_id, additions.doc_type, additions.field_key, true
from configured join additions using (doc_type)
on conflict (organization_id, doc_type, field_key) do nothing;

commit;

-- Optional read-only verification after running:
-- select organization_id, doc_type, field_key, enabled
-- from public.field_settings
-- where field_key in ('paymentTerms', 'materialValue', 'cgstAmount',
--   'sgstAmount', 'igstAmount', 'bisLicenseNumber')
-- order by organization_id, doc_type, field_key;
