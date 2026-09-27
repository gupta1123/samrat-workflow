# Staged source and packet review

The worker keeps Flash extraction and Pro review separate. It no longer asks
Pro to return every document's field audit, corrections, page-quality records,
packet groups, clauses, and all mismatch decisions in one response.

1. Extract the uploads and save a private first-pass checkpoint.
2. Review each extracted document against only its own original pages, with
   bounded concurrency. Verify every populated field and line-item property.
   Reference values and their printed labels share one value-and-proof ledger.
   Non-reference additions/corrections likewise pair the field, literal value,
   page and quote in one `fieldChanges` record. The app derives missing-value
   audit entries from those records; the reviewer does not repeat them in a
   separate omission list. Unsupported source votes materialize removals, with
   own-page removal evidence. The authoritative path preserves known fields
   proved on the source, without a document-template whitelist discarding them.
   Paired field evidence is retained and checked again before final assembly.
   Original references are uniquely keyed; newly discovered references must be
   distinct and join the same ledger with their own value and proof. The source
   response schema includes only original reference keys plus one sparse
   discovery shape, rather than repeating the proof schema for every possible
   reference. App-owned `p1`, `p2` pointers bind to the exact original pages;
   the AI does not predict filenames, document IDs or original page numbers.
   Support decisions use required named field/property keys, not positional
   arrays whose length or alignment the model must guess. Signature presence
   is declared visual evidence in the shared domain schema; an own-page visual
   observation can correct that flag without pretending "Yes" was printed.
   Printed fields cannot opt into visual evidence. Accepted rows in a one-page
   source are bound to that exact original page; multi-page row provenance must
   be explicit and within its source, never inferred from document wording.
3. Reconcile the whole packet from all original pages and source-audited fields.
   This establishes shipment groups, buyer-facing versus upstream invoice roles,
   case references, explicit clauses, and new grounded findings. A concrete
   contradiction requests a recheck of the affected source, not silent edits.
4. Adjudicate candidate mismatches in small batches. Every batch still sees the
   full packet and the accepted reconciliation; only its requested decisions
   belong in its response.
5. Validate all assembled results and apply mandatory approval rules. Save the
   case atomically only after this completes, then remove used checkpoints.

Every AI task must return complete JSON and pass its source contract. A rejected
response gets one bounded task-level repair. Truncated JSON is never salvaged.
Unfinished reviews do not publish partial results or an approval-ready case.
Actual completed-task counts drive review progress; heartbeat updates do not
invent percentage progress.

Checkpoints are compressed server-only objects under a case-specific internal
prefix in the existing private `packet-files` bucket. They have no upload asset
row and are not served by the case-file API. Only a claimed job with a valid
lease reads/writes them. Keys include the review contract, source image/content
digests, fields, relevant settings and model. Every reused response is validated
again against its current source pointers. Failed stages preserve completed work
for retry; checkpoints older than 72 hours are not reusable. Used checkpoints
are removed after a successful save; expired unused objects are not currently
covered by scheduled cleanup.

New parsing does not match company names, document wording or identifier shapes
to infer business meanings. The AI supplies semantic decisions; the application
enforces schema coverage, provenance, complete decision sets and explicit
mandatory rules. Configurable batch sizes/concurrency are workload controls.
Legacy extraction/proposal helpers still exist and are not a claim that the
entire application contains no older heuristics.

Smaller responses and resumable work address oversized completions and repeated
extraction. They do not guarantee lower latency/cost for every packet or perfect
AI accuracy. Measure real provider timing, particularly on large documents and
packets requiring source rechecks. The legacy whole-packet helper remains for
compatibility; normal case processing uses the staged reviewer.
