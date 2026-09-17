"""Run against an isolated PostgreSQL 17 container, never the case database.

Usage: python3 installer/windows/tests/test_migrations.py CONTAINER_NAME
The container must have PostgreSQL ready, no host ports, and no network access.
Only throwaway databases prefixed samrat_test_ are created in that container.
"""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid


WINDOWS_ROOT = Path(__file__).resolve().parents[1]
CONTAINER = sys.argv.pop(1) if len(sys.argv) > 1 else ""


def docker(*args, input=None, check=True):
    return subprocess.run(
        ["docker", *args], input=input, text=True, capture_output=True, check=check
    )


class MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not CONTAINER.startswith("samrat-migration-regression-"):
            raise RuntimeError("Use a dedicated samrat-migration-regression-* container.")
        config = json.loads(docker("inspect", CONTAINER).stdout)[0]
        if config["HostConfig"]["NetworkMode"] != "none" or config["HostConfig"]["PortBindings"]:
            raise RuntimeError("Test container must have network=none and no host ports.")
        if any(m["Type"] in ("bind", "volume") for m in config["Mounts"]):
            raise RuntimeError("Test container must not mount host files or persistent volumes.")
        docker(
            "exec", "-i", CONTAINER, "psql", "-X", "-U", "postgres", "-v", "ON_ERROR_STOP=1",
            input="""
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
""",
        )
        docker("cp", str(WINDOWS_ROOT / "database/run-migrations.sh"), f"{CONTAINER}:/tmp/run-migrations.sh")

    def setUp(self):
        self.database = "samrat_test_" + uuid.uuid4().hex
        docker("exec", CONTAINER, "createdb", "-U", "postgres", self.database)
        # This path exists only in the disposable container, never on the host.
        docker("exec", CONTAINER, "sh", "-c", "rm -rf /migrations && mkdir /migrations")

    def tearDown(self):
        docker("exec", CONTAINER, "dropdb", "-U", "postgres", self.database)

    def sql(self, query):
        return docker(
            "exec", "-i", CONTAINER, "psql", "-X", "-U", "postgres", "-d", self.database,
            "-v", "ON_ERROR_STOP=1", "-Atq", input=query,
        ).stdout.strip()

    def files(self, files):
        with tempfile.TemporaryDirectory() as directory:
            for filename, content in files.items():
                path = Path(directory) / filename
                path.write_text(content, encoding="utf-8")
                docker("cp", str(path), f"{CONTAINER}:/migrations/{filename}")

    def run_migrations(self):
        return docker(
            "exec", "-e", "PGUSER=postgres", "-e", f"PGDATABASE={self.database}",
            CONTAINER, "sh", "/tmp/run-migrations.sh", check=False,
        )

    def test_first_install_and_rerun_preserve_data(self):
        self.files({
            "001_create.sql": "CREATE TABLE example(id integer PRIMARY KEY); INSERT INTO example VALUES (1);",
            "002_index.sql": "CREATE INDEX example_index ON example(id);",
        })
        first = self.run_migrations()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(self.sql("SELECT count(*) FROM samrat_installer.schema_migrations;"), "2")
        self.sql("INSERT INTO example VALUES (2);")
        second = self.run_migrations()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(second.stdout.count("Already applied:"), 2)
        self.assertEqual(self.sql("SELECT count(*) FROM example;"), "2")
        self.assertEqual(self.sql("SELECT count(*) FROM samrat_installer.schema_migrations;"), "2")

    def test_filename_is_a_literal_in_both_history_queries(self):
        filename = "001_owner's data.sql"
        self.files({filename: "CREATE TABLE safely_quoted(id integer);"})
        first = self.run_migrations()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(self.sql("SELECT filename FROM samrat_installer.schema_migrations;"), filename)
        second = self.run_migrations()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn("Already applied: " + filename, second.stdout)

    def test_failure_is_not_recorded_or_skipped_on_retry(self):
        self.files({
            "001_first.sql": "CREATE TABLE first_step(id integer);",
            "002_fail.sql": "BEGIN; CREATE TABLE second_step(id integer); SELECT 1/0; COMMIT;",
            "003_last.sql": "CREATE TABLE last_step(id integer);",
        })
        failed = self.run_migrations()
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("division by zero", failed.stderr)
        self.assertEqual(self.sql("SELECT count(*) FROM samrat_installer.schema_migrations;"), "1")
        self.assertEqual(self.sql("SELECT to_regclass('second_step') IS NULL AND to_regclass('last_step') IS NULL;"), "t")
        self.files({"002_fail.sql": "BEGIN; CREATE TABLE second_step(id integer); COMMIT;"})
        retry = self.run_migrations()
        self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)
        self.assertIn("Already applied: 001_first.sql", retry.stdout)
        self.assertEqual(self.sql("SELECT count(*) FROM samrat_installer.schema_migrations;"), "3")

    def test_missing_payload_fails(self):
        result = self.run_migrations()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No Samrat migration SQL files", result.stderr)

    def test_shipped_sql_with_minimal_supabase_schema_dependencies(self):
        # Exercises the real SQL files, not the Auth/Storage API implementations.
        self.sql("""
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY, name text, public boolean, file_size_limit bigint,
  allowed_mime_types text[]
);
""")
        shipped = {p.name: p.read_text() for p in (WINDOWS_ROOT / "database/migrations").glob("*.sql")}
        self.assertTrue(shipped)
        self.files(shipped)
        first = self.run_migrations()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(self.sql("SELECT count(*) FROM samrat_installer.schema_migrations;"), str(len(shipped)))
        self.assertEqual(self.sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.packet_cases'::regclass;"), "t")
        self.assertEqual(self.sql("SELECT public FROM storage.buckets WHERE id='packet-files';"), "f")
        second = self.run_migrations()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(second.stdout.count("Already applied:"), len(shipped))


if __name__ == "__main__":
    unittest.main(verbosity=2)
