# Samrat case-review intelligence

Samrat carries over the document-review intelligence used by Kalika while remaining a separate, generic product. It has no Tally, ERP, ledger, voucher, or company-specific workflow. AI reads visible document evidence. Deterministic code may prepare comparison candidates, but it cannot make or overwrite the final semantic decision.

Every non-empty extraction is audited by one authoritative final reviewer before persistence. The reviewer defaults to Gemini 2.5 Pro with high reasoning and receives the complete extracted packet plus the original rendered page images. In one response it corrects extraction, assigns every document to a packet, identifies buyer-facing and upstream seller-chain roles, adjudicates every comparison candidate, and produces the final PO-terms checklist with document/page evidence. A malformed or incomplete response is retried once. If the reviewer remains unavailable or invalid, the processing job fails instead of publishing a partial result.

The reviewed documents, packet roles, mismatch decisions and terms checklist are canonical. No semantic enrichment, regex rule, grouping heuristic, terms pass or AI case-naming call runs afterward. Post-review code is limited to schema validation, exact persistence, mismatch counting and arithmetic-derived summary metrics; it cannot restore a field the reviewer removed.

## Review pipeline

| Stage                | Rules applied                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake               | Accept supported PDFs and images, enforce file/page/size limits, hash uploads, detect same-name and same-packet duplicates, and keep Storage private.                                                                                        |
| Classification       | Classify each page into a supported document type, preserve its source file and page, and split a mixed upload only when document anchors support separate shipments.                                                                        |
| Extraction           | Extract only printed values and commercial rows. A second review pass may correct uncertain fields but cannot erase a visible line-item table with an empty response. Explicit labels are required for PO and invoice references.            |
| Normalization        | Compare currency symbols and common INR spellings consistently; normalize identifiers, GSTIN OCR substitutions, dates, amounts, weights, and compatible units. Formatting-sensitive comparison remains configurable.                         |
| Candidate generation | Prepare possible links and differences from PO, invoice, e-way, LR, weighment, transaction and vehicle values. These candidates are never persisted as facts until the authoritative reviewer confirms them.                                 |
| Packet structure     | The authoritative reviewer assigns every document exactly once and identifies normal packets, copies, multiple shipments and seller chains from full-page evidence. Buyer-facing evidence stays primary and upstream evidence stays context. |
| Field comparison     | The authoritative reviewer confirms, dismisses or escalates every candidate difference after checking identity, reference, commercial, item, tax, logistics, vehicle, weight, payment, permit and source-page evidence.                      |
| Line-item comparison | Match rows by item code, meaningful description tokens, HSN/SAC, quantity and unit. Support kg/MT conversion, partial fulfilment, broad PO lines, invoice supplemental charges, and grouped e-way/invoice amounts.                           |
| Validity and terms   | The final reviewer evaluates every explicit packet-testable clause against all uploaded documents. Only `not_fulfilled` becomes blocking; unknown or unproven obligations remain checklist attention.                                        |
| Human review         | Store every mismatch with its field, values, source documents, source pages, analysis, and suggested fix. Reviewers can settle or dispute each item from side-by-side evidence.                                                              |
| Approval and audit   | Disable approval in the UI while an item is pending or disputed. The database independently rejects premature acceptance, updates the case when decisions change, and records review events.                                                 |

## Important comparison safeguards

- A purchase-order grand total is not compared directly with one partial invoice. Multiple invoices can reconcile to the PO as an aggregate when their references prove that they belong together.
- Seller-chain invoices are not treated as contradictory copies. The invoice facing the final buyer is reconciled; upstream invoices remain visible as context.
- Printed duplicate invoice copies collapse to one comparison source, while every uploaded copy remains traceable.
- Unlabelled invoice, indent, date, or serial values cannot become a PO reference because they merely resemble a familiar number format.
- Freight marked as included cannot inherit a nearby subtotal or GST value. A freight amount or rate needs direct printed evidence.
- Quantity is compared only with compatible units. Weight values are normalized before comparison, and split weighment readings can reconcile to a shipment aggregate.
- Vehicle and other multi-instance identifiers are checked within their linked shipment branch so a legitimate multi-invoice packet does not create cross-shipment noise.
- Buyer, consignee, supplier, and transporter roles stay separate. GSTIN evidence can confirm party identity, but calculated or inferred tax fields are not stored as printed extraction. Arithmetic may be explained in review reasoning.
- A single document with no mismatches is described as limited evidence; it is not treated as proof of completeness or authenticity.

## Packet intelligence shown to reviewers

The case-detail API rebuilds verification groups from saved extraction data and resolves packet structure without rerunning Gemini or changing stored decisions. For exceptional packets, the detail page shows:

- the detected packet type and confidence;
- recommended reviewer action;
- primary, context, collapsed-copy, or split-candidate document roles;
- duplicate case links for the same user's matching upload fingerprint;
- smart-split sibling cases and their current statuses;
- tax or terms checks needing attention.

A normal single-shipment packet does not show an extra warning panel. Older completed cases also receive this intelligence because the API can reconstruct it from their saved documents.

## Deliberate differences from Kalika

- No Tally or other accounting-system connection exists anywhere in the review or approval path.
- No Kalika company name, GSTIN, state, PO series, invoice series, or vendor identity is assumed.
- Samrat uses the identities and references printed in each client's documents.
- Packet wording is buyer-facing and generic, so seller-chain review works for Samrat Group and future clients without code changes.

## Verification coverage

The automated suite exercises comparison safeguards, extraction corrections, packet intelligence, upload behavior, PDF limits and rendering, RLS, ownership, job leasing, atomic finalization, mismatch decisions, and the database approval gate. The signed-in local app was also checked read-only with a clean six-document packet and a five-mismatch packet: approval remained available for the clean case and disabled on both mismatch review screens for the unresolved case.
