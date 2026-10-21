begin;

-- PO uploads are optional, matching isRequiredMissingDocumentGroup. The old
-- trigger independently required a PDF for goods, including non-stock goods,
-- even after analysis found no missing documents. Remove only that upload gate.
-- Verified analysis, invoice-number and issue-review gates remain in place.
-- SAP draft creation still requires a ready match and confirmed PO lines.
drop trigger if exists require_purchase_order_before_approval
  on public.packet_cases;
drop function if exists public.require_purchase_order_before_approval();

commit;
