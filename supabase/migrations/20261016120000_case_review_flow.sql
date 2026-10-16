begin;

-- Stored classification of each case, so lists, filters and reports can tell
-- material (GRPO) cases from non-material ones without opening match results.
--
--   supply_kind  what the invoice bills, assessed from the source documents:
--                goods | services | mixed | unknown
--   review_flow  how the SAP review works for the case, set by the SAP match
--                worker from SAP's own item flags each time a match finishes:
--                material_grpo | non_stock_po | service_po | mixed | already_recorded
--                (null until the first SAP match finishes)
alter table public.packet_cases
  add column supply_kind text
    check (supply_kind in ('goods', 'services', 'mixed', 'unknown')),
  add column review_flow text
    check (review_flow in (
      'material_grpo', 'non_stock_po', 'service_po', 'mixed', 'already_recorded'
    ));

create index packet_cases_owner_review_flow
  on public.packet_cases(owner_user_id, review_flow)
  where deleted_at is null and review_flow is not null;

-- Backfill supply_kind from the evidence-backed assessment on each invoice.
-- Same rule as the application: a goods/services/mixed answer needs quoted
-- evidence, anything else is unknown.
with invoice_kinds as (
  select
    d.case_id,
    case
      when d.extracted_fields->'__supplyNature'->>'kind' in ('goods', 'services', 'mixed')
        and jsonb_typeof(d.extracted_fields->'__supplyNature'->'evidence') = 'array'
        and jsonb_array_length(d.extracted_fields->'__supplyNature'->'evidence') > 0
      then d.extracted_fields->'__supplyNature'->>'kind'
      else 'unknown'
    end as kind
  from public.packet_documents d
  where d.document_type in ('Invoice', 'Tax Invoice')
),
per_case as (
  select
    case_id,
    case
      when count(distinct kind) = 1 then min(kind)
      when bool_or(kind = 'unknown') then 'unknown'
      else 'mixed'
    end as kind
  from invoice_kinds
  group by case_id
)
update public.packet_cases c
set supply_kind = p.kind
from per_case p
where p.case_id = c.id and c.supply_kind is null;

-- Backfill review_flow from the last finished SAP match of each case.
with line_classes as (
  select
    j.case_id,
    case
      when line->>'kind' = 'material' then 'material_grpo'
      when line->>'kind' = 'service' then 'service_po'
      when line->>'kind' = 'non-stock' then 'non_stock_po'
      when line->>'kind' = 'unmapped'
        and jsonb_typeof(line->'nonStockPoCandidates') = 'array'
        and jsonb_array_length(line->'nonStockPoCandidates') > 0
      then 'non_stock_po'
      else null
    end as flow,
    (j.result ? 'existingInvoice' and j.result->'existingInvoice' <> 'null'::jsonb) as recorded
  from public.sap_match_jobs j
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(j.result->'lines') = 'array' then j.result->'lines' else '[]'::jsonb end
  ) as line
  where j.status = 'succeeded' and j.result is not null
),
per_case as (
  select
    case_id,
    bool_or(recorded) as recorded,
    count(distinct flow) as flows,
    min(flow) as only_flow
  from line_classes
  group by case_id
)
update public.packet_cases c
set review_flow = case
  when p.recorded then 'already_recorded'
  when p.flows = 1 then p.only_flow
  when p.flows > 1 then 'mixed'
  else null
end
from per_case p
where p.case_id = c.id and c.review_flow is null;

commit;
