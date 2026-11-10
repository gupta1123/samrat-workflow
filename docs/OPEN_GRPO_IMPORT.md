# Open GRPO PDF imports

`/sap-inspector/open-grpos` has Uploaded and Not uploaded tabs for the signed-in account and the configured SAP Test company. A receipt is marked Uploaded only after a `sap_grpo_pdf_imported` audit event links it to a case that still contains all imported PDF checksums. Recycled cases remain visible with a Restore link. Missing source files make the link ineligible.

Older manual uploads do not have an authoritative GRPO source link. On import, exact SHA-256 matches against active owned case files reuse a case containing those PDFs, including cases with additional documents. Names, invoice numbers, candidate SAP matches, and supplier similarity do not establish upload status.

## Source API

The integration uses the existing server-only SAP Test Service Layer session and static egress proxy:

1. `GET PurchaseDeliveryNotes(DocEntry)` verifies the receipt is still open and not cancelled and reads its `AttachmentEntry`.
2. `GET Attachments2(AttachmentEntry)` lists the actual attachment filenames.
3. `GET Attachments2(AttachmentEntry)/$value?filename='…'` reads each PDF.

There is no generated supplier invoice, report rendering, guessed download URL, or browser connection to SAP. Report templates (`.rpt`) are not PDFs. Credentials and SAP session cookies stay on the server. The source PDF bytes are not modified.

## Workflow and recovery

The authenticated import endpoint is `/api/sap-inspector/grpos/:docEntry/import`, with `prepare`, `file`, and `finish` POST actions. Each PDF is downloaded and stored in a separate bounded request. The client retains the manifest, session UUID, and day for the batch. A changed SAP attachment manifest is rejected. Each file must be a readable, unencrypted PDF within existing size/page limits; finish reuses the existing server checksum/page validation and transactional case-attachment RPC.

The existing attachment RPC serializes case creation by owner and prevents exact-content duplicate cases. A lost response or concurrent request can safely reuse a committed case. The source event is written only after verifying the original PDF hashes are present in the case. If writing that event fails, a retry recognizes the existing case by its files.

After saving, the client calls the normal analysis-enqueue API. That API retains existing quotas, worker leases, retries and review rules. A failed enqueue leaves the case in Draft with a Start analysis action in Uploaded. Completed or processing cases are not re-enqueued by the import workflow. Keep the page open until the save/enqueue finishes; after enqueue, the background worker continues independently.

The list endpoint `/api/sap-inspector/open-grpos` filters the upload tab on the server, reading up to five SAP pages per request and returning a continuation cursor for sparse results. It never treats an empty scanned page as proof that no older matches exist.

No schema migration, new tables, or SQL execution is required. The feature uses existing `storage_assets`, `packet_case_files`, `packet_cases`, and `case_review_events` plus the existing processing queue. It creates no SAP receipt, invoice, or draft, and imports do not override analysis or SAP matching decisions.

## Verification

`tests/grpo-import.test.ts` mocks SAP, Storage and PostgREST and exercises the real import/list handlers. Coverage includes original-byte preservation, PDF checks, changed manifests, concurrent/lost-response retries, source-file removal, account/company isolation, recycle-bin links, server pagination, exact-file manual-case reuse, and enqueue failure/recovery. The tests never upload real supplier documents or create real cases.

## PDF availability and navigation

The sidebar includes Open GRPOs. Before enabling Download & analyze, the list reads SAP's `AttachmentEntry` and attachment metadata, with at most four concurrent metadata reads and a shared read for repeated attachment entries. Confirmed missing PDFs show No PDF attached and a disabled button. A failed or omitted metadata response instead shows PDF check unavailable; Refresh retries the check. The import endpoint still rechecks the receipt and attachments when clicked.

After upload and a confirmed analysis enqueue, imports and analysis retries navigate to `/cases/:id`, the same progress page used after manual uploads. The existing polling and results flow continue there. An enqueue failure leaves a saved case with the existing retry action.
