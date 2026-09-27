import assert from "node:assert/strict";
import test from "node:test";

import {
  getDirectSupabasePublicUrl,
  getSupabasePublicPort,
} from "../src/lib/supabase/config";

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("local runtime config uses the port from the local Supabase URL", () => {
  const previousPublicPort = process.env.SUPABASE_PUBLIC_PORT;
  const previousPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousServerUrl = process.env.SUPABASE_URL;

  try {
    delete process.env.SUPABASE_PUBLIC_PORT;
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    assert.equal(getSupabasePublicPort(), "54321");
  } finally {
    restoreEnvironment("SUPABASE_PUBLIC_PORT", previousPublicPort);
    restoreEnvironment("NEXT_PUBLIC_SUPABASE_URL", previousPublicUrl);
    restoreEnvironment("SUPABASE_URL", previousServerUrl);
  }
});

test("installer runtime config honors its explicit public port", () => {
  const previousPublicPort = process.env.SUPABASE_PUBLIC_PORT;
  const previousPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  try {
    process.env.SUPABASE_PUBLIC_PORT = "8000";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    assert.equal(getSupabasePublicPort(), "8000");
  } finally {
    restoreEnvironment("SUPABASE_PUBLIC_PORT", previousPublicPort);
    restoreEnvironment("NEXT_PUBLIC_SUPABASE_URL", previousPublicUrl);
  }
});

test("cloud runtime config preserves the configured Supabase origin", () => {
  const previousPublicPort = process.env.SUPABASE_PUBLIC_PORT;
  const previousPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousServerUrl = process.env.SUPABASE_URL;

  try {
    delete process.env.SUPABASE_PUBLIC_PORT;
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      "https://example-project.supabase.co";
    assert.equal(
      getDirectSupabasePublicUrl(),
      "https://example-project.supabase.co",
    );
  } finally {
    restoreEnvironment("SUPABASE_PUBLIC_PORT", previousPublicPort);
    restoreEnvironment("NEXT_PUBLIC_SUPABASE_URL", previousPublicUrl);
    restoreEnvironment("SUPABASE_URL", previousServerUrl);
  }
});

test("local runtime config keeps deriving the browser host dynamically", () => {
  const previousPublicPort = process.env.SUPABASE_PUBLIC_PORT;
  const previousPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousServerUrl = process.env.SUPABASE_URL;

  try {
    delete process.env.SUPABASE_PUBLIC_PORT;
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    assert.equal(getDirectSupabasePublicUrl(), undefined);
  } finally {
    restoreEnvironment("SUPABASE_PUBLIC_PORT", previousPublicPort);
    restoreEnvironment("NEXT_PUBLIC_SUPABASE_URL", previousPublicUrl);
    restoreEnvironment("SUPABASE_URL", previousServerUrl);
  }
});
