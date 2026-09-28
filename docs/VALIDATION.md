# Local validation — 31 August 2026

## User-uploaded demo packets: live result audit

The user uploaded and analyzed both combined packets in the dedicated Samrat project. The signed-in app UI was inspected read-only at `localhost:8888` after completion.

| Packet                          | Observed result                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Clean, invoice ARM/26-27/101    | Six documents correctly classified; zero mismatches; decision pending; Accept enabled.                             |
| Mismatch, invoice ARM/26-27/102 | Six documents correctly classified; five intended mismatch fields; decision pending; Accept disabled until review. |

The five detected differences matched the answer sheet: taxable value 620000 vs 650000; tax 111600 vs 117000; total 731600 vs 767000; vehicle MH14EF6724 vs LR MH20CD7823; net weight 12000 vs weighment 11700. All five review items remained pending. Payment terms were marked as needing review because the packets provide no payment evidence; this is not an additional mismatch.

The mismatch-detection checks passed, but extraction was **not a full pass**:

- The clean invoice incorrectly contained freight amount 620000.00 and freight GST rate 9 despite explicit included-freight wording. The local commercial fallback reproduced those exact values when given flattened source text. Freight fallback now requires a directly associated numeric charge/rate and no longer searches through nearby prose into subtotal/GST values.
- Both invoice views lacked the printed PO reference. The inherited fallback selected invoice numbers matching a Kalika-style pattern, replacing the actual PO reference before a later guard removed it. That format-based fallback and corresponding prompt rule were replaced with explicit PO-label recovery. Existing distinct PO references are retained and ambiguous labels are not guessed.
- The clean invoice's two rows put dimensions/grades in the item-code field and left only the generic product name in description. Extraction and review instructions now keep the full description and use only explicitly identifiable product codes.
- The mismatch invoice showed zero line items although its PDF contains two. A local test demonstrated that an empty array in a field-only second-pass correction could erase existing rows. A guard now preserves existing rows when the source still contains a commercial table, records a review warning, and instructs the model to omit unchanged line items. This does **not establish** which extraction stage caused the observed empty table or recover rows absent from first-pass output. That result requires a fresh live run and inspection.

After these local changes, typecheck and lint passed, all 34 automated tests passed, and reference comparison still produced zero/five findings. New regression coverage includes flattened included-freight text, real charged freight, PO label variants/ambiguity, a mocked second-pass review with an empty row array, duplicate upload handling, camera-page PDF assembly, duplicate document copies, seller-chain roles, duplicate packets, and multi-shipment packet intelligence. A separate read of both actual invoice PDFs through the app's PDF renderer confirmed the printed PO references were recovered and no freight amount/rate was added. No real model request was made during this audit; no uploaded document, case decision, or mismatch decision was changed. Existing stored results remain unchanged. Fresh user-triggered analyses are required to verify the fixes with Gemini and confirm both invoice rows are present before approval.

## Case detail and mismatch redesign

The supplied Kalika visual redesign was adapted for Samrat without any Tally controls. The completed-case detail now has packet metrics, document navigation, original PDF and extracted-data modes, compliance and activity sections. The mismatch review has a progress list, amount-at-risk summary, individual issue review, side-by-side source pages with exact-value highlighting, and a source drawer. The clean packet retains its dedicated no-mismatch state and case approval action.

The previously completed draft intake remains in the detail flow: gallery/file selection, camera capture, duplicate overwrite/keep-both decisions, saved-document preview, standard analysis and multi-document PDF analysis. Desktop 1280 × 800 and mobile 390 × 844 layouts were checked in the signed-in local app. The live mismatch packet displayed all five issues and highlighted the lorry-receipt and weighment values on their source pages; the clean packet displayed zero issues. No case or mismatch decision was changed during this redesign check.

A later review-page read briefly failed with Supabase `PGRST303` (`JWT issued at future`); retrying the normal UI recovered the page and all five pending issues. Logs contained earlier intermittent instances too. This remains a reliability observation to investigate before production, not evidence of changed case data. Netlify Dev reloaded the updated processing function successfully.

## Upload-ready test packets

Created `output/pdf/samrat-demo-cases` with two fictional six-document procurement packets: purchase order, tax invoice, e-way bill, lorry receipt, weighment slip and delivery note. Each case includes one combined PDF and six equivalent individual PDFs. The separate answer sheet explains expected findings and upload instructions. `output/pdf/Samrat-Two-Test-Cases.zip` contains the complete set.

All 15 PDFs have readable text within page bounds; combined pages match their individual versions. Rendered page previews were visually checked. The clean packet's reference fields produce zero findings; the deliberate mismatch packet produces five fields: subtotal, tax, total, vehicle and net weight. Both combined-source and separate-source reference checks retain all six documents in one group.

That check exposed missing PO/invoice reference fields in the weighment extraction schema. The server and display schemas now retain these explicit references. No grouping heuristics were loosened. A regression test verifies that a weighment joins its referenced shipment without joining another shipment. Typecheck, lint and all 19 tests passed after the fix. Reproduce reference validation with `node --import tsx scripts/verify-demo-cases.ts` after generating PDFs with `scripts/create-demo-cases.py` using Python with ReportLab and pypdf.

These fixtures were not uploaded or analyzed by Gemini. No cloud records were created and no model credits were used. Live extraction, terms review and resulting UI findings remain to be tested by the user.

## OpenRouter credential setup update

At the user's request, the existing Kalika workflow's OpenRouter key was copied into Samrat's private `.env.local`. The source environment was left unchanged, and Samrat retains its separate Supabase project. Extraction and quality passes use Gemini 2.5 Flash; the authoritative final reviewer now uses Gemini 2.5 Pro. The environment file remains mode `0600`. `npm run check:setup` validates configuration presence only; the key's credit balance and model access must still be verified with a live packet. Both apps use the same OpenRouter credential and account credits.

## Gemini Flash configuration update

All three AI model settings now use `google/gemini-2.5-flash` in the code defaults, environment template, and private local configuration. The separate OpenAI review provider and fallback were removed. Typecheck and lint passed; all 18 tests passed, including a mocked request-routing regression check covering extraction, quality extraction, review, JSON responses, image input, and ignored legacy OpenAI provider settings. These checks made no real model requests and do not establish extraction accuracy. Setup validation now reports only `OPENROUTER_API_KEY` missing; the Supabase values and worker secret are configured. Flash through OpenRouter requires paid model usage. No credits were purchased or cloud deployment performed.

## Supabase connection update

The user subsequently created the dedicated Samrat project, ran the migration in its SQL Editor, created an app user, disabled public sign-ups, and set the local Site URL. A read-only connection check from this app succeeded using its configured keys: the case table was accessible and empty, `packet-files` was private with a 50 MB limit, and Auth reported public sign-ups disabled with email sign-in enabled. No credentials are recorded here. This does not yet verify a real app sign-in, upload, AI extraction, or Netlify deployment. The initial local validation below remains the record of the earlier tests.

These results describe the local Samrat project. No cloud Supabase migration, real AI request, or Netlify deployment was performed. The original Kalika application was not modified.

## Automated checks

| Check                         | Result                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`               | Passed; production pages and API routes compiled, types/lint passed, all static pages generated without service credentials |
| `npm run typecheck`           | Passed                                                                                                                      |
| `npm run lint`                | Passed without warnings                                                                                                     |
| `npm test`                    | 34 tests passed                                                                                                             |
| `npm audit --omit=dev`        | 0 reported vulnerabilities at validation time; this is not a security guarantee                                             |
| Netlify functions local build | All three functions bundled successfully; no deploy                                                                         |
| Processing bundle inspection  | PDF worker, fonts and native canvas dependencies included; compressed worker approximately 33 MB on this Mac                |
| `npm run check:setup`         | Correctly reports five missing required values because real service configuration has intentionally not been added          |

The database tests run the actual first-install migration and workflow functions in isolated Postgres through PGlite, with minimal local Auth/Storage schema fixtures. They cover RLS and grants, ownership, upload idempotency, duplicate detection, one active processing lease, review gates, failed atomic completion, cancellation, recycle/restore, permanent-delete gating, and atomic review settings.

Renderer tests extract PDF text and render native images, check that content is actually drawn, and reject over-limit PDFs without skipping pages. Comparison tests cover a genuine linked-document amount difference, matching amounts, purchase-order total exclusions and missing GST-state evidence. Origin checks cover a public host behind Next.js, cross-origin writes and opaque origins.

## Browser checks

The normal Next.js UI and API routes were exercised against the explicitly labelled, disposable local fixture gateway. Supabase authentication/storage responses and analysis output were synthetic; no external service received the test files.

Verified locally:

- Password sign-in and dashboard loading, including case counts and navigation.
- Case detail with original PDF preview, extracted-data controls and review summary.
- Acceptance disabled while an issue is pending.
- Reject issue → rejected status and count → change to accepted → automatic case acceptance → refresh retains the decision.
- File-picker upload of a generated PDF → save draft → analyze with formatting ignored → completed result → accept case.
- Recycle confirmation → item appears in recycle bin → restore confirmation → item disappears from recycle bin.
- Review-setting save and reload.
- Phone intake layout at 390 × 844; desktop layouts at 1280 × 800.

The sample gateway exists only for local UI inspection and is not a replacement for Supabase. It does not reproduce every database constraint. The real SQL tests validate constraints separately. AI quality, network failures and cloud runtime behavior cannot be established from the synthetic preview.

## Required before real use

Follow [SETUP.md](../SETUP.md), especially the first real-packet checklist. Verify all of these using your own accounts:

1. Migration installation in a fresh Supabase project, real Auth users, disabled public sign-ups and private Storage.
2. Signed uploads/downloads and rejection of another user's case access.
3. OpenRouter model access, credits, extraction quality, document grouping and a known mismatch.
4. Netlify's deployed Linux runtime, native PDF renderer and function packaging.
5. Durable processing after closing the page, scheduled retries and orphaned-file cleanup.
6. Password administration, backups, retention, data-sharing requirements and spending limits.
7. Whether Samrat needs shared cases across individual staff accounts. The current app uses the original per-user ownership model and has no uploader/reviewer assignment roles.

Do not treat successful local builds or sample reviews as proof of live-service readiness.
