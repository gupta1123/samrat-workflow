# SAP invoice matching

The matching step lives in the **SAP** area of the case review page (and the SAP section of the
case page). It replaces the old dropdown-based panel. Plan and background: `sapbusinessplan.md`
and `SAP_MATCHING_GAP_AND_BUILD_PLAN.md`.

## Setup

1. Run these two migrations once, in order (Supabase SQL Editor, or `supabase start` picks them up
   locally): `20260929090000_sap_match_settings.sql` (adds `sap_match_rules`, `sap_item_mappings`,
   `sap_match_state`) and `20260929100000_sap_vendor_mappings.sql` (adds `sap_vendor_mappings`).
   All are service-role only.
2. Optional server settings in `.env.local` (see `.env.example`): `SAP_GRPO_VEHICLE_FIELD`,
   `SAP_PO_REF_FIELDS`, `SAP_FREIGHT_EXPENSE_CODE`.
3. Save your branches (ship-to GSTIN state code → SAP branch) and your limits under
   **Matching rules** at the bottom of the panel.

## Linking a vendor or item once

The SAP supplier collection is read through every Service Layer continuation page. A vendor is
selected automatically only when SAP returns one exact GSTIN match, or one exact vendor-name
match when the invoice has no usable GSTIN. If several SAP business partners carry the same exact
GSTIN or name, the panel shows those exact records and requires the reviewer to choose the SAP
vendor code. If there is no exact record, the reviewer can search SAP and explicitly choose one.
There is no similarity score and no automatic closest-name selection. The choice is always saved
for the current case. It is reused on another case only when both the GSTIN and the vendor's exact
material code are the same, so one TATA division cannot silently become another division. Items
work the same way (vendor material code → SAP item).

## How it works

1. The invoice fields come from the analysed case. SAP is read live (vendor, open receipts, POs,
   items, existing invoices and drafts). Nothing from SAP is copied into the database.
2. `src/lib/sap-match/engine.ts` (pure, tested) scores every open receipt, allocates the billed
   quantity, and produces checks with one of five outcomes: ready, needs you, can't send yet,
   waiting, returned/closed.
3. The admin settles each open item in the panel. Choices needing a reason (rate above the limit,
   service bill above the PO, a total that differs from the bill) save the reason in the audit trail.
4. "Create AP Invoice Draft" re-reads every base document from SAP, rebuilds the match, and
   creates the draft only if it is still ready. Final posting reuses the existing re-checked
   post step.

There are no debit notes and no second approver: differences are settled by stores correcting the
receipt, returning the invoice to the vendor, or holding it.

## Rules the engine applies

Duplicate invoice (posted or another draft) · vendor found and unambiguous · GST type against
vendor and ship-to state · item linked to a SAP item · stock (3-way) or service (2-way) ·
receipt at the right branch and still open · truck / invoice number written on the receipt ·
quantity billed against received (limit, hold, return) · part bills · rate against the PO ·
freight policy · booked total against the vendor's bill · booking date (GST date is never moved).

## Not verified against the client's SAP yet

- Finding the PO number printed on invoices (`SIPL/PO/…`) needs the SAP field that holds it.
- Truck number on receipts needs the user-defined field, otherwise only Comments text is used.
- Freight expense code, and the tax code on the freight line.
- Service bills work only for service-type POs (`dDocument_Service`).
- Closed accounting periods are not read from SAP yet (the rule exists, the value is empty).
- Live (production) SAP is not enabled; everything runs against SAP Test.
- Unit conversion (MT / kg / pieces) and TDS/TCS are not handled.
