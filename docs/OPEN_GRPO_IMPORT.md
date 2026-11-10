# Open GRPO PDF imports

`/sap-inspector/open-grpos` has Uploaded and Not uploaded tabs for the signed-in account and the configured SAP Test company. A receipt is marked Uploaded only after a `sap_grpo_pdf_imported` audit event links it to an active case that still contains all imported PDF checksums. A recycled case does not count as an active upload: its still-open SAP receipt returns to Not uploaded, and the original case remains recoverable in Recycle Bin. Missing source files also make the link ineligible.

Older manual uploads do not have an authoritative GRPO source link. On import, exact SHA-256 matches against active owned case files reuse a case containing those PDFs, including cases with additional documents. Names, invoice numbers, candidate SAP matches, and supplier similarity do not establish upload status.

Uploaded receipts also show a SAP draft badge. Draft created (with the saved SAP number when available) requires the linked case's confirmed `sap_postings` record: kind AP, environment test, status prepared, document type APInvoiceDraft, and a valid SAP entry. A successful read with no saved draft shows Not drafted; historical posted invoices show Invoice posted. A failed status read or an incomplete prepared record shows Draft status unavailable. Case approval, analysis completion and the case's initial draft state do not establish a SAP draft. This reads the app's saved SAP result; it does not check for later manual deletion in SAP. Refresh reloads the status. No SAP write or new schema is involved.

An active uploaded case with confirmed Not drafted status has Delete case. After confirmation, `DELETE /api/sap-inspector/grpos/:docEntry/import` rechecks the current source link, owner, Test company, saved draft status and case status. Drafted, posted, unknown-status and processing cases are rejected. A successful request uses the existing `decide_case` recycle action, preserves the PDFs, and switches to Not uploaded. It never deletes a SAP document. This rechecks saved state at request time; it does not add a database lock around a simultaneous SAP draft creation.

Download & analyze ignores recycled source links, revalidates SAP's open receipt and current PDFs, and uses a fresh import session. Existing active cases containing those exact PDFs are reused; otherwise a new case is created. It never restores or overwrites the recycled case. Restoring the original case through Recycle Bin makes it an eligible upload again; when several eligible source links exist, the newest active link wins.

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

The sidebar includes Unbilled Receipts. Its Add Folder button opens the existing `/workspace` PDF/image upload page; Add Case is removed from the sidebar. Before enabling Download & analyze, the list reads SAP's `AttachmentEntry` and attachment metadata, with at most four concurrent metadata reads and a shared read for repeated attachment entries. Confirmed missing PDFs show No PDF attached and a disabled button. A failed or omitted metadata response instead shows PDF check unavailable; Refresh retries the check. The import endpoint still rechecks the receipt and attachments when clicked.

After upload and a confirmed analysis enqueue, imports and analysis retries navigate to `/cases/:id`, the same progress page used after manual uploads. The existing polling and results flow continue there. An enqueue failure leaves a saved case with the existing retry action.

For draft matching, partial-receipt confirmation is evaluated after all invoice rows have been allocated. Multiple rows billing the same SAP receipt line consume one shared open balance. A fully billed line requires no partial confirmation; a genuine balance produces one confirmation with the total billed across those rows and the actual quantity left. Balances are keyed by SAP document entry and line, not the displayed receipt number. Original invoice rows, rates, quantities and draft base links remain separate.
