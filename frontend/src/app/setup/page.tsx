import { CheckCircle2, FileCheck2, LockKeyhole } from "lucide-react";
import Link from "next/link";

export default function SetupPage() {
  return (
    <main className="min-h-screen bg-slate-950 p-6 text-white sm:p-12">
      <div className="mx-auto max-w-3xl py-10">
        <div className="flex items-center gap-3 text-lg font-semibold">
          <FileCheck2 className="text-emerald-400" /> Samrat Group
        </div>
        <p className="mt-16 text-xs font-semibold uppercase tracking-[0.25em] text-emerald-400">
          Case review workspace
        </p>
        <h1 className="mt-4 text-4xl font-semibold leading-tight sm:text-5xl">
          Your workflow.
          <br />
          Your Supabase account.
        </h1>
        <p className="mt-6 max-w-xl leading-7 text-slate-300">
          The app is installed. Connect your own Supabase project to enable
          private uploads, document processing, and mismatch review.
        </p>
        <div className="mt-10 grid gap-3 sm:grid-cols-3">
          {["Add a case", "Review documents", "Resolve mismatches"].map(
            (label) => (
              <div
                key={label}
                className="rounded-xl border border-slate-700 bg-slate-900 p-5"
              >
                <CheckCircle2 className="mb-3 h-5 w-5 text-emerald-400" />
                {label}
              </div>
            ),
          )}
        </div>
        <ol className="mt-10 list-decimal space-y-4 pl-5 text-sm leading-6 text-slate-300">
          <li>
            Create your Supabase project and run the SQL in{" "}
            <code className="text-white">supabase/migrations</code>.
          </li>
          <li>Create a sign-in user under Authentication → Users.</li>
          <li>
            Copy <code className="text-white">.env.example</code> to{" "}
            <code className="text-white">.env.local</code>, fill in your keys,
            then restart the app.
          </li>
        </ol>
        <p className="mt-6 rounded-xl bg-slate-900 p-4 text-sm text-slate-300">
          Follow <strong className="text-white">SETUP.md</strong> in the project
          folder for the complete Supabase and Netlify instructions.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-5">
          <Link
            href="/login"
            className="rounded-lg bg-emerald-400 px-5 py-3 text-sm font-semibold text-slate-950"
          >
            Continue to sign in
          </Link>
          <span className="flex items-center gap-2 text-xs text-slate-400">
            <LockKeyhole className="h-4 w-4" />
            No account or cloud resources were created for you.
          </span>
        </div>
      </div>
    </main>
  );
}
