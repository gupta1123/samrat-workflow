# Samrat Group case review

A separate application adapted from `autodealer-workflow-main`. The original folder is unchanged.

The workflow is: add documents → extract and compare → inspect the original and extracted data → resolve mismatches → accept or reject the case.

Includes sign-in, dashboard, case list with search and pagination, draft uploads, background processing, PDF/image preview, extracted fields and line items, single/bulk mismatch decisions, review settings, recycle/restore/permanent deletion, and audit events. No Tally, ERP bridge, ledger posting, bank imports, or collections features.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the original-to-Samrat mapping, processing stages, and review rules.

Normal case processing uses [staged source and packet review](docs/STAGED_REVIEW.md), with private retry checkpoints and mandatory approval checks before results are published.

## Start with a local preview

Requires Node 24 and npm.

```sh
npm ci
npm run preview
```

Open http://127.0.0.1:3067 and sign in with:

- Email: `reviewer@example.invalid`
- Password: `local-fixture-only`

**Preview uses synthetic data and a loopback-only fixture server. Nothing is sent to Supabase or an AI provider. Changes disappear on restart. It is not a deployment or a production backend.** The real authentication code is unchanged; only the preview process points it at a disposable test service.

## Connect your own services

Follow [SETUP.md](SETUP.md), in order. The guide covers your own Supabase project, the SQL migration, an app sign-in user, private keys in `.env.local`, local Netlify development, and your Netlify deployment.

```sh
npm run check:setup
npm run dev:netlify
```

`npm run dev` runs only Next.js. Use `dev:netlify` for real background processing. On Netlify, one site serves the frontend, API routes, and background functions; Supabase supplies Auth, Postgres and Storage. AI extraction uses your OpenRouter account.

## Validation

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Tests run the real migration and database functions in isolated Postgres/WASM, and verify the native PDF renderer. See [docs/VALIDATION.md](docs/VALIDATION.md) for the tested scope and remaining live-service checks.

## Important boundaries

- Case visibility follows the original owner-based design: each app user sees their own cases. Shared reviewer accounts, reviewer assignment, and organization-wide case permissions are **not** implemented. Do not share passwords; request a team-role model if several users must work on the same case.
- Review settings are shared by the trusted users in this dedicated Samrat project. Do not enable public app sign-ups.
- Maximum 20 files, 50 MB per file, 100 MB total, and 40 pages per case. Start with smaller packets when validating extraction quality.
- Smart splitting can create related cases from one PDF. To correct a split case, create a new case containing only that packet’s corrected documents; re-analysis of split cases is blocked to protect sibling reviews.
- Limits of 40 new analysis jobs and 200 upload reservations per user per day reduce accidental runaway usage. At most three jobs per user can be active. These are guardrails, not a monetary budget.
- Automated results need human review. The app is not an accounting system or a guarantee of document accuracy.
