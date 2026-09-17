# Samrat Group - two test cases

These are fictional procurement packets modelled on Kalika's document types, not copies of client transactions. All business names, GSTINs, vehicle numbers, references and approvals are specimen data. No document is valid for tax, transport, payment or legal use. Tax rates and dates are fixed test inputs, not compliance advice.

## Upload one case at a time

1. Start with `01-clean-case/Samrat-Case-01-Complete-Packet.pdf`.
2. In Samrat, keep **Find separate documents automatically** ON and **Treat formatting differences as mismatches** OFF.
3. Select only that one combined PDF. It contains all six documents for one case.
4. Click **Save draft** first if checking storage. When ready to test AI, start analysis from the saved case, or use **Create case & review** on a new upload. AI analysis uses the shared OpenRouter credits.
5. Check the originals, extracted values, review findings and final case status. If no issues are raised, accept the clean case from its detail page.
6. Create a NEW case for `02-mismatch-case/Samrat-Case-02-Mismatch-Packet.pdf`; do not add it to the clean case.
7. Review each discrepancy against its original document. To exercise the workflow, reject one issue, refresh and check that the decision persists. On this disposable test case you may then change it to accepted and accept the remaining issues; accepting the final issue should accept the case. This is a UI test, not a recommendation to approve incorrect real documents.

Alternative: select the six PDFs in a case's `individual-documents` folder together instead of the combined PDF. Do not upload the combined packet AND its individual documents, and do not upload both cases together. The ZIP and this answer sheet are not case documents.

## Case 01 - matching procurement packet

- Purchase order: **SG/PO/26-27/101**; supplier invoice: **ARM/26-27/101**.
- Goods: 6,000 KG of MS Channel 150 x 75 mm at INR 60/KG, and 4,000 KG of MS Channel 100 x 50 mm at INR 65/KG.
- Taxable value: **INR 620,000.00**. CGST 9%: **55,800.00**. SGST 9%: **55,800.00**. Total GST: **111,600.00**. Invoice total: **INR 731,600.00**.
- Vehicle: **MH12AB4821** wherever stated.
- Total quantity and consignment net weight: **10,000 KG**. Weighment: **24,000 - 14,000 = 10,000 KG**.
- E-way bill: **271260831101**. LR: **NSR/26-27/101**. All references, parties, quantities, dates and commercial values reconcile.
- Expected: one case with six documents and no substantive mismatches. An extra finding should be investigated as an extraction or verification issue, not assumed to be intentional.

## Case 02 - deliberately conflicting packet

Purchase order **SG/PO/26-27/102** and invoice **ARM/26-27/102** describe 8,000 KG of 6 mm MS Plate at INR 50/KG and 4,000 KG of 8 mm MS Plate at INR 55/KG. The invoiced total is **INR 731,600.00**, quantity **12,000 KG**, and invoice vehicle **MH14EF6724**. Three business discrepancies are deliberately introduced:

| Problem | Reference evidence | Conflicting evidence |
| --- | --- | --- |
| Commercial value | Invoice: taxable 620,000; GST 111,600; total 731,600 | E-way bill: taxable 650,000; GST 117,000; declared invoice value 767,000. Total difference: INR 35,400. |
| Vehicle | Invoice, e-way bill, weighment and delivery note: MH14EF6724 | Lorry receipt: MH20CD7823. No vehicle substitution is recorded. |
| Net weight | Lorry receipt and commercial documents: 12,000 KG | Weighment: 25,700 - 14,000 = 11,700 KG, short by 300 KG. |

The e-way bill's own GST arithmetic is internally consistent; its figures disagree with the invoice. The weighment's own subtraction is correct; its result disagrees with the documented consignment. Reference numbers remain consistent so these are comparisons inside one case, not two unrelated shipments.

Expected: review required, with the commercial-value, vehicle and net-weight conflicts surfaced. The commercial problem can appear as separate subtotal, tax and total findings; do not assume exactly three cards. Case acceptance should remain blocked while issues are pending or rejected.

## Validation limits

The generator checks arithmetic, page counts, document text and PDF readability. The app's local grouped comparison engine is also checked against reference fields separately from AI extraction. That reference-data check is NOT proof that the live Gemini extraction, document grouping or terms review will produce identical output. No AI request, Supabase upload or case creation was performed while preparing these files. Local comparison results are recorded in `validation/comparison-results.json`.
