# Set up Samrat Group using your own accounts

Nothing in this guide has been applied to a cloud account for you. Follow one section at a time. Keep all secret keys out of chat, screenshots, Git, and browser code.

## 1. Create a dedicated Supabase project

1. Open [Supabase Dashboard](https://supabase.com/dashboard) and sign in using your own account. Your Supabase account is the administrator account; it is separate from the users who will sign in to the Samrat app.
2. Choose or create your organization, then **New project**.
3. Name the project `samrat-workflow`. Generate a strong database password and save it in your password manager. The app does not need that database password in its environment file.
4. Pick an available region near your users, such as an India region if offered. Review the plan and any costs yourself, then create the project.
5. Wait for provisioning to finish. Use a new project; do not run this app’s SQL in Kalika’s database or an unrelated existing project.

Supabase project setup is described in its [official quickstart](https://supabase.com/docs/guides/getting-started/quickstarts/nextjs).

## 2. Install the database and private storage

1. In your new project, open **SQL Editor → New query**.
2. Open this local file and copy its **entire contents**:

   `supabase/migrations/20260831072011_samrat_case_review.sql`

3. Paste it into the SQL Editor and click **Run** once. The script is transactional: an error rolls the migration back. It is a first-install migration, not a script to rerun over an installed database.
4. Confirm that Table Editor shows `packet_cases`, `packet_case_files`, `packet_documents`, `packet_mismatches`, `packet_processing_jobs`, `storage_assets`, `case_review_events`, and three review-setting tables.
5. Open **Storage**. Confirm the `packet-files` bucket exists and is **private**. The SQL creates it; do not create a second bucket or make it public.
6. Run this separate, read-only verification query:

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

select id, public, file_size_limit
from storage.buckets
where id = 'packet-files';

select has_function_privilege(
  'authenticated',
  'public.decide_case(uuid,uuid,text)',
  'EXECUTE'
) as browser_can_call_internal_mutation;
```

Expected: all ten application tables have `rowsecurity = true`; the bucket has `public = false` and a 50 MB limit; the final result is `false`.

The browser uploads directly using a short-lived signed upload capability. It cannot list everyone’s files or call internal mutation functions. Private access is enforced by the app API and database grants/RLS. See [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) and [signed uploads](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl).

## 3. Create the app’s sign-in user

1. Open **Authentication → Users → Add user → Create new user**.
2. Enter the email and a strong password for the intended reviewer. Use the confirmation/auto-confirm option when creating a trusted user manually.
3. In Authentication’s sign-up settings, **disable new public sign-ups**. Keep anonymous sign-ins disabled. The app intentionally has no public sign-up page.
4. Under **Authentication → URL Configuration**, set the local Site URL to `http://localhost:8888` while testing. Add `http://localhost:8888/auth/confirm` to allowed redirect URLs if using email confirmation links.
5. Password sign-in is used inside the app. You do **not** need to configure Google OAuth just because you use a Gmail address or a Google account to manage your services.

Create individual app users only if separate case lists are intended. Current permissions are per case owner, matching the original app. Shared case assignment between uploader and reviewer requires a separate team-permissions change before inviting that team. Review settings are shared, so invite only trusted staff.

For password resets in this first version, the administrator manages the user in Supabase. There is no self-service password-reset screen in the app.

## 4. Collect your keys privately

From the project’s Connect dialog or **Project Settings → API Keys**, find:

| Value                                                            | Environment variable                   | Browser-visible? |
| ---------------------------------------------------------------- | -------------------------------------- | ---------------- |
| Project URL, such as `https://YOUR_REF.supabase.co`              | `NEXT_PUBLIC_SUPABASE_URL`             | Yes              |
| Publishable key (`sb_publishable_…`; legacy anon key also works) | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes              |
| Secret key (`sb_secret_…`) or legacy service-role key            | `SUPABASE_SERVICE_ROLE_KEY`            | **No**           |

The server-side variable retains the name `SUPABASE_SERVICE_ROLE_KEY` for compatibility. A secret key must never be placed in a `NEXT_PUBLIC_` variable. See [Supabase API keys](https://supabase.com/docs/guides/api/api-keys).

For document extraction and AI review, create an API key in your own [OpenRouter account](https://openrouter.ai/settings/keys). Extraction defaults to `google/gemini-2.5-flash`; the independent authoritative review defaults to `google/gemini-2.5-pro`. There is no automatic provider fallback. Both models use paid OpenRouter usage. Review [current Flash pricing](https://openrouter.ai/google/gemini-2.5-flash) and [current Pro pricing](https://openrouter.ai/google/gemini-2.5-pro), add credits yourself, and set a spending limit on the key before running analysis. Supabase does not perform AI extraction by itself. The model settings remain configurable in `.env.example`.

Uploaded document text and images are sent through OpenRouter to the model provider during analysis, so validate your organization’s data-handling requirements before real use. A Google AI Studio API key is not interchangeable with an OpenRouter key; this app currently connects through OpenRouter.

## 5. Configure the project locally

In a terminal, open the **new** project directory:

```sh
cd "/Users/apple/Desktop/Projects/Main all codes/samrat group/samrat-workflow"
npm ci
cp .env.example .env.local
```

Do not overwrite an existing `.env.local` that already contains your keys. Edit `.env.local` and fill in the five required secrets/configuration values. Keep `APP_BASE_URL=http://localhost:8888` for local Netlify development.

Generate a random worker secret locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paste the generated string into `WORKER_SECRET`. It authenticates background job dispatch; it is not a Supabase password. Do not use the preview fixture values.

Then run:

```sh
npm run check:setup
npm run dev:netlify
```

Use your installed Netlify CLI, or install it first with `npm install -g netlify-cli`. The `dev:netlify` helper exports `.env.local` to both Next.js and the background functions. Open [local Netlify development](http://localhost:8888), then sign in with the app user from step 3. Restart the process whenever environment variables change.

`npm run preview` is only a disposable sample-data preview. `npm run dev` starts the frontend and API but does not run Netlify background functions. Use Netlify Dev for a real end-to-end local run.

### Run against the local Supabase development stack

Docker Desktop must be installed and running. The first start downloads the local PostgreSQL, Auth, Storage, API, and Studio images and applies every file in `supabase/migrations`.

```sh
npm run supabase:start
npm run supabase:verify
npm run dev:local
```

`dev:local` reads the local Supabase URL and keys automatically and overrides only the Supabase variables from `.env.local`; the cloud project configuration remains unchanged. It still reads `OPENROUTER_API_KEY` and `WORKER_SECRET` from `.env.local` for document analysis.

It starts two long-running processes: the Samrat web/API server and a local case worker. The worker polls the Postgres job queue every 400 ms and uses the same claim, lease, retry, extraction, review, and completion code as the hosted background function. Local analysis therefore starts without waiting for a Netlify background-function cold start. Keep this terminal open while cases are processing.

AI timing logs contain only the operation name, model, duration, status, and token counts; they never contain uploaded document text or model output. After each completed job, the worker also logs extraction, second-pass review, terms-compliance, and persistence durations. `PACKET_AI_CONCURRENCY=6` allows independent document extractions to run together; reduce it if the configured model provider returns rate-limit errors. Smart-split page classification uses a separate, smaller reasoning allowance through `PACKET_SPLIT_REASONING_TOKENS` because it only decides page boundaries and document types; extraction and second-pass review keep their full quality settings.

Open local Supabase Studio at [http://127.0.0.1:54323](http://127.0.0.1:54323). Create a confirmed user under **Authentication → Users**, then sign in to Samrat at [http://localhost:8888](http://localhost:8888). Public sign-up is disabled in `supabase/config.toml`.

Useful commands:

```sh
npm run supabase:status
npm run supabase:stop
```

Stopping preserves the local database. A database reset is intentionally not provided as an npm shortcut because it deletes local data. The Supabase CLI stack is for local development and testing; the client installation must use the production self-hosted Docker deployment, HTTPS, backups, monitoring, and pinned versions.

## 6. Validate one real packet before deployment

Use documents you are authorized to process, preferably a small, non-sensitive test packet first.

1. Sign in. The dashboard should show zero real cases initially.
2. Open **New case**, choose a PDF or images, and click **Save draft**. Confirm the draft and attached filename appear. After analysis, the detail screen shows the original file preview.
3. Start analysis from the case. Confirm that a job appears in `packet_processing_jobs` and moves from `queued` to `running` to `succeeded`.
4. Leave the case page and return. Processing must continue independently of the browser.
5. Check original document previews, extracted fields, and line items against the source.
6. Test a packet with a known mismatch. Open the case’s **Review** link, reject an issue, then accept it after checking. Check the saved decision after refreshing.
7. A case with no issues can be accepted directly; a case with issues requires every issue to be accepted first. Accepting the final issue accepts the case.
8. Test recycle and restore on a disposable case. Permanent deletion is available only in the recycle bin. Unreferenced file cleanup runs daily in production; deletion may leave private storage bytes until that cleanup.
9. If testing with a second user, confirm that they cannot open the first user’s case URL.

These live checks cannot be completed until you supply your own service configuration. Local automated tests do not substitute for this step.

## 7. Put only the Samrat project in your private Git repository

Create a private repository in your own GitHub account, then push the **contents of `samrat-workflow`**. Do not include the original `autodealer-workflow-main` folder or `node_modules`.

Example commands after creating an empty repository yourself:

```sh
git init
git add .
git status
# Confirm .env.local is NOT listed before committing.
git commit -m "Create Samrat Group case review workflow"
git branch -M main
git remote add origin YOUR_REPOSITORY_URL
git push -u origin main
```

If Git is already initialized or an origin exists, do not repeat those commands blindly. Keep `package-lock.json`, `netlify.toml`, and the migration in version control. `.env.local`, `.netlify`, and build output are ignored.

## 8. Deploy the frontend and backend together on Netlify

1. Sign in to your own [Netlify account](https://app.netlify.com/).
2. Choose **Add new project / Import an existing project** and select your private repository.
3. Use these build settings (also defined in `netlify.toml`):

   - Base directory: empty if the repository root is the Samrat app. If you intentionally pushed a parent folder, set it to `samrat-workflow`.
   - Build command: `npm run build`.
   - Publish directory: `.next`.
   - Functions directory: `netlify/functions`.
   - Node version: `24`.

4. Add environment variables in the Netlify dashboard before the real deployment. Copy the values from `.env.local`, **except change `APP_BASE_URL` to your production site URL**, such as `https://YOUR-SITE.netlify.app`.
5. The `NEXT_PUBLIC_` values must be available at **build time**. Server keys and `WORKER_SECRET` must be available to **Functions**. If your plan offers environment scopes, choose Builds + Functions where needed. Do not put secrets in `netlify.toml` or Git.
6. Do **not** set `NEXT_PUBLIC_DEMO_MODE` on Netlify. Do not use preview fixture keys. Use a separate Supabase project for deployment previews if they will process test data; production credentials should be scoped to production.
7. Trigger the deploy and wait for success. Netlify’s Next.js adapter serves the pages and API routes. No separate Express server, Supabase Edge Function, Docker server, or Tally bridge is needed. See [Netlify Next.js support](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/).
8. In Functions, confirm `process-case-background`, `retry-case-jobs`, and `cleanup-orphan-uploads` were deployed. The Next.js adapter also creates its own internal functions.
9. Review your Netlify plan’s function limits and usage costs. Background functions can run for up to 15 minutes; this app stops model work near 13 minutes and retains prior results on failure. See [background functions](https://docs.netlify.com/build/functions/background-functions/).
10. Scheduled retry and cleanup functions run on the published production deploy, not as an automatic local cron. Retries scan queued work every five minutes; stale jobs are recovered after twenty minutes. Cleanup runs at 02:17 UTC and processes up to 100 unreferenced, expired uploads per run. See [scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/).

Do not use a drag-and-drop static deployment: this project needs server functions. No SPA catch-all redirect to `index.html` is required.

## 9. Finish the production connection

1. In Supabase Authentication → URL Configuration, set Site URL to your production HTTPS URL and add `https://YOUR-SITE.netlify.app/auth/confirm` if you use email confirmation.
2. Sign in on the deployed site and repeat the small-packet checklist in step 6.
3. Check Netlify function logs, Supabase job rows, and the case page if analysis fails. Avoid pasting document content or secrets into support screenshots.
4. Confirm spending limits, backups, storage retention, and staff access before uploading live business documents. Keep the bucket private and public sign-ups disabled.

## Troubleshooting

| Symptom                                      | What to check                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App opens the setup page                     | Public Supabase URL/key missing at build time. Set them and rebuild/restart.                                                                                                                            |
| Sign-in fails                                | App user exists, password is correct, user is confirmed, and URL/key are from the same Supabase project.                                                                                                |
| API reports missing tables/functions         | Run the complete migration once in the dedicated project. Do not enable permissive policies as a workaround.                                                                                            |
| File upload fails                            | Private `packet-files` bucket exists, secret key is valid, filenames differ, and size limits are respected.                                                                                             |
| Case stays queued                            | With `npm run dev:local`, confirm the terminal says `Local case worker ready.` In hosted production verify the background function, matching worker secret, APP_BASE_URL, and scheduled retry function. |
| Analysis reports credits/model errors        | Check your OpenRouter key, credits, model access, and spending cap.                                                                                                                                     |
| Case times out or PDF is rejected            | Try a clearer/smaller packet. Maximum 40 total pages, 20 files, 50 MB per file and 100 MB per case. No pages are silently truncated.                                                                    |
| Split case cannot be edited/reprocessed      | Create a new case using only its corrected documents. Existing sibling reviews are protected.                                                                                                           |
| Preview shows sample cases                   | Stop `npm run preview`. Start Netlify Dev with your real `.env.local`; never deploy the demo flag.                                                                                                      |
| Stored files remain after permanent deletion | The daily cleanup removes expired unreferenced objects. Check cleanup function logs; database deletion and Storage deletion are separate.                                                               |
