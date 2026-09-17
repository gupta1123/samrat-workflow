begin;

-- This is a mandatory approval invariant, not document-pattern inference.
-- A case summary or a transport reference cannot substitute for a blank invoice.
-- Match standard string trimming, including whitespace copied from PDF text.
create or replace function public.invoice_reference_has_value(p_value text)
returns boolean language sql immutable set search_path='' as $$
  select nullif(btrim(p_value,
    E' \t\n\r\f' || chr(11) ||
    U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  ), '') is not null;
$$;

create or replace function public.guard_invoice_number_for_approval()
returns trigger language plpgsql set search_path='' as $$
declare
  invoice_count integer;
  missing_count integer;
begin
  if new.status <> 'accepted' then return new; end if;
  if not public.invoice_reference_has_value(new.invoice_number) then
    raise exception 'Approval is blocked: the primary invoice number is required. Upload a numbered invoice and analyze again.';
  end if;

  with groups as (
    select value->'roleSelection' as roles
    from jsonb_array_elements(
      case when jsonb_typeof(new.processing_meta->'verificationGroups')='array'
        then new.processing_meta->'verificationGroups' else '[]'::jsonb end
    )
  ), context_ids as (
    select jsonb_array_elements_text(
      case when jsonb_typeof(roles->'contextDocumentIds')='array'
        then roles->'contextDocumentIds' else '[]'::jsonb end
    ) as id from groups where roles->>'strategy'='seller_chain'
  ), primary_ids as (
    select jsonb_array_elements_text(
      case when jsonb_typeof(roles->'primaryDocumentIds')='array'
        then roles->'primaryDocumentIds' else '[]'::jsonb end
    ) as id from groups where roles->>'strategy'='seller_chain'
  )
  select count(*), count(*) filter (
    where not public.invoice_reference_has_value(d.extracted_fields->>'invoiceNumber')
      or coalesce(jsonb_typeof(d.extracted_fields->'invoiceNumber'),'null') not in ('string','number')
  ) into invoice_count, missing_count
  from public.packet_documents d
  where d.case_id=new.id and d.document_type in ('Invoice','Tax Invoice')
    and (d.client_document_id in (select id from primary_ids)
      or d.client_document_id not in (select id from context_ids));

  if invoice_count=0 then
    raise exception 'Approval is blocked: a buyer-facing invoice with an invoice number is required. Upload the invoice and analyze again.';
  end if;
  if missing_count>0 then
    raise exception 'Approval is blocked: an invoice number is missing from a buyer-facing invoice. Upload a numbered invoice and analyze again.';
  end if;
  return new;
end $$;

-- Includes explicit approval, automatic approval after the last settled issue,
-- and direct status writes. Existing analyzed cases are checked too.
create or replace trigger require_invoice_number_before_approval
before insert or update on public.packet_cases
for each row execute function public.guard_invoice_number_for_approval();

create or replace function public.guard_required_invoice_number_issue()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.field_name='invoiceNumberRequired' and new.resolution_status='accepted' then
    raise exception 'A missing invoice number cannot be settled. Upload a numbered invoice and analyze again.';
  end if;
  return new;
end $$;

create or replace trigger prevent_waiving_required_invoice_number
before insert or update on public.packet_mismatches
for each row execute function public.guard_required_invoice_number_issue();

revoke all on function public.guard_invoice_number_for_approval() from public, anon, authenticated;
revoke all on function public.invoice_reference_has_value(text) from public, anon, authenticated;
revoke all on function public.guard_required_invoice_number_issue() from public, anon, authenticated;
grant execute on function public.guard_invoice_number_for_approval() to service_role;
grant execute on function public.invoice_reference_has_value(text) to service_role;
grant execute on function public.guard_required_invoice_number_issue() to service_role;

commit;
