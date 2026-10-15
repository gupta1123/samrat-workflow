begin;

-- Match isServiceOnlyPacket/readSupplyNature: every invoice must have an
-- evidence-backed services classification. Never infer it from missing files,
-- supplier names, item descriptions, or non-stock flags.
-- CREATE OR REPLACE retains the existing trigger and function permissions.
create or replace function public.require_purchase_order_before_approval()
returns trigger language plpgsql set search_path='' as $$
declare service_only boolean;
begin
  if new.status <> 'accepted' or old.status is not distinct from 'accepted' then
    return new;
  end if;

  select count(*) > 0 and coalesce(bool_and(coalesce(
    d.extracted_fields->'__supplyNature'->>'kind' = 'services'
    and case
      when jsonb_typeof(d.extracted_fields->'__supplyNature'->'evidence') = 'array' then
        jsonb_array_length(d.extracted_fields->'__supplyNature'->'evidence') > 0
        and not exists (
          select 1
          from jsonb_array_elements(d.extracted_fields->'__supplyNature'->'evidence') as e(proof)
          where not coalesce(
            jsonb_typeof(e.proof->'quote') = 'string'
            and length(btrim(e.proof->>'quote')) > 0
            and case when jsonb_typeof(e.proof->'sourcePage') = 'number' then
              (e.proof->>'sourcePage')::numeric >= 1
              and trunc((e.proof->>'sourcePage')::numeric) = (e.proof->>'sourcePage')::numeric
            else false end,
            false
          )
        )
      else false
    end,
    false
  )), false) into service_only
  from public.packet_documents d
  where d.case_id = new.id and d.document_type in ('Invoice', 'Tax Invoice');

  if not service_only and not exists (
    select 1 from public.packet_documents
    where case_id = new.id and document_type in ('Purchase Order', 'Amended Purchase Order')
  ) then
    raise exception 'Approval is blocked until the Purchase Order document is added and the case is analyzed again.';
  end if;
  return new;
end $$;

commit;
