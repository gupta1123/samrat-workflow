# Open GRPO PDF imports

`/sap-inspector/open-grpos` has Uploaded and Not uploaded tabs for the signed-in account and the configured SAP Test company. A receipt is marked Uploaded only after a `sap_grpo_pdf_imported` audit event links it to an active case that still contains all imported PDF checksums. A recycled case does not count as an active upload: its still-open SAP receipt returns to Not uploaded, and the original case remains recoverable in Recycle Bin. Missing source files also make the link ineligible.

Older manual uploads do not have an authoritative GRPO source link. On import, exact SHA-256 matches against active owned case files reuse a case containing those PDFs, including cases with additional documents. Names, invoice numbers, candidate SAP matches, and supplier similarity do not establish upload status.

Uploaded receipts also show a SAP draft badge. Draft created (with the saved SAP number when available) requires the linked case's confirmed `sap_postings` record: kind AP, environment test, status prepared, document type APInvoiceDraft, and a valid SAP entry. A successful read with no saved draft shows Not drafted; historical posted invoices show Invoice posted. A failed status read or an incomplete prepared record shows Draft status unavailable. Case approval, analysis completion and the case's initial draft state do not establish a SAP draft. This reads the app's saved SAP result; it does not check for later manual deletion in SAP. Refresh reloads the status. No SAP write or new schema is involved.

An active uploaded case with confirmed Not drafted status has Delete case. After confirmation, `DELETE /api/sap-inspector/grpos/:docEntry/import` rechecks the current source link, owner, Test company, saved draft status and case status. Drafted, posted, unknown-status and processing cases are rejected. A successful request uses the existing `decide_case` recycle action, preserves the PDFs, and switches to Not uploaded. It never deletes a SAP document. This rechecks saved state at request time; it does not add a database lock around a simultaneous SAP draft creation.

Download & analyze ignores recycled source links, revalidates SAP's open receipt and current PDFs, and uses a fresh import session. Existing active cases containing those exact PDFs are reused; otherwise a new case is created. It never restores or overwrites the recycled case. Restoring the original case through Recycle Bin makes it an eligible upload again; when several eligible source links exist, the newest active link wins.

## Source API

PDF downloads use the SAP team's Test attachment API, with the existing server-only `SAP_TEST_USERNAME` / `SAP_TEST_PASSWORD` Basic credentials and static egress proxy:

`GET https://sbivan.samratgroup.com:5061/api/Grpo/{DocEntry}/download-attachments`

The identifier is the SAP **DocEntry**, not the displayed GRPO DocNum. Before downloading, the existing SAP Test Service Layer session re-reads `PurchaseDeliveryNotes(DocEntry)` to verify the receipt is still open and not cancelled. PDF availability badges continue to use the recorded attachment metadata as a lightweight presence check; the import revalidates the actual archive.

The supplied endpoint returns a ZIP. A server-side Undici request supports HTTPS port 5061 (which the fetch API rejects), retains TLS verification and static egress, and never follows redirects with credentials. The ZIP is read in memory, without writing its paths to disk. Only actual PDF entries are imported; report templates (`.rpt`) and other non-PDF attachments are ignored. Invalid paths, duplicate PDF names, encryption, damaged CRC/size data, non-PDF contents, more than 20 PDFs, or a download/expanded PDF packet above 50 MB are rejected. PDF bytes are preserved exactly. There is no fallback to Service Layer `$value`, report rendering, generated supplier invoices, or a browser connection to SAP.

Read-only verification against the client endpoint for Test GRPO entry 174368 returned HTTP 200 with a ZIP containing `AP27Y5949 (2).pdf`. Its SHA-256 matched the existing source PDF exactly. This verification did not upload documents, create cases, run analysis, or write to SAP. Open PO FTP access remains pending the SAP team's configuration; GRPO attachments are not treated as an Open PO invoice feed.

## Workflow and recovery

The authenticated import endpoint is `/api/sap-inspector/grpos/:docEntry/import`, with `prepare`, `file`, and `finish` POST actions. Each step revalidates the receipt and downloads the bounded archive from the supplied API. The file step stores only its selected PDF. The client retains the manifest, session UUID, and day for the batch. The manifest includes deterministically ordered filenames and original PDF SHA-256 values: changed bytes under an unchanged filename are also rejected. Each file must be a readable, unencrypted PDF within existing size/page limits; finish reuses the existing server checksum/page validation and transactional case-attachment RPC.

The existing attachment RPC serializes case creation by owner and prevents exact-content duplicate cases. A lost response or concurrent request can safely reuse a committed case. The source event is written only after verifying the original PDF hashes are present in the case. If writing that event fails, a retry recognizes the existing case by its files.

After saving, the client calls the normal analysis-enqueue API. That API retains existing quotas, worker leases, retries and review rules. A failed enqueue leaves the case in Draft with a Start analysis action in Uploaded. Completed or processing cases are not re-enqueued by the import workflow. Keep the page open until the save/enqueue finishes; after enqueue, the background worker continues independently.

Unbilled Receipts loads both tabs with `uploaded=all` and follows the list endpoint's continuation cursor until the full list is ready. The browser filters and paginates that list at ten receipts per page. Refresh reloads it, and processing cases use the case status endpoint for updates. The list endpoint still accepts `uploaded=yes` and `uploaded=no` for callers that need server-side tab filtering.

No schema migration, new tables, or SQL execution is required. The feature uses existing `storage_assets`, `packet_case_files`, `packet_cases`, and `case_review_events` plus the existing processing queue. It creates no SAP receipt, invoice, or draft, and imports do not override analysis or SAP matching decisions.

## Verification

`tests/grpo-import.test.ts` mocks SAP, Storage and PostgREST and exercises the real import/list handlers. Coverage includes original-byte preservation, PDF checks, changed manifests, concurrent/lost-response retries, source-file removal, account/company isolation, recycle-bin links, server pagination, exact-file manual-case reuse, and enqueue failure/recovery. The tests never upload real supplier documents or create real cases.

## PDF availability and navigation

The sidebar includes Add Case, opening the existing `/workspace` PDF/image upload page. Unbilled Receipts is omitted from the desktop and mobile sidebar, but remains accessible at `/sap-inspector/open-grpos`, including its existing Add Folder button. Before enabling Download & analyze, the list checks each distinct SAP attachment entry. The combined list reads attachment metadata in batches. Confirmed missing PDFs show No PDF attached and a disabled button. A failed or omitted metadata response instead shows PDF check unavailable; Refresh retries the check. The import endpoint still rechecks the receipt and downloads the actual archive when clicked.

After upload and a confirmed analysis enqueue, imports and analysis retries navigate to `/cases/:id`, the same progress page used after manual uploads. The existing polling and results flow continue there. An enqueue failure leaves a saved case with the existing retry action.

For draft matching, partial-receipt confirmation is evaluated after all invoice rows have been allocated. Multiple rows billing the same SAP receipt line consume one shared open balance. A fully billed line requires no partial confirmation; a genuine balance produces one confirmation with the total billed across those rows and the actual quantity left. Balances are keyed by SAP document entry and line, not the displayed receipt number. Original invoice rows, rates, quantities and draft base links remain separate.

SAP draft creation submits each base document entry/line once. Repeated item allocations can be consolidated only when the original source quantities, unit prices, row net amounts and printed amount precision prove that one unambiguous existing source price preserves every allocated row amount and their combined net total. No average or inferred unit price is used. Materially different or ambiguous prices, missing source proof and rounding changes block creation. Repeated account-based service rows add their verified values. The saved posting retains all source plan rows, the actual submitted SAP payload and `draftLineSources` linking each SAP row back to its invoice rows.
