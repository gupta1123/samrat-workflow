#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists samrat_installer;
create table if not exists samrat_installer.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
revoke all on schema samrat_installer from public, anon, authenticated;
SQL

for migration in /migrations/*.sql; do
  filename="$(basename "$migration")"
  applied="$(psql -v ON_ERROR_STOP=1 -v filename="$filename" -Atqc \
    "select exists(select 1 from samrat_installer.schema_migrations where filename = :'filename')")"

  if [ "$applied" = "t" ]; then
    echo "Already applied: $filename"
    continue
  fi

  echo "Applying: $filename"
  psql -v ON_ERROR_STOP=1 -f "$migration"
  psql -v ON_ERROR_STOP=1 -v filename="$filename" -c \
    "insert into samrat_installer.schema_migrations(filename) values (:'filename')"
done

echo "Samrat database migrations are current."
