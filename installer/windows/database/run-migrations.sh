#!/bin/sh
set -eu

psql -X -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists samrat_installer;
create table if not exists samrat_installer.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
revoke all on schema samrat_installer from public, anon, authenticated;
SQL

for migration in /migrations/*.sql; do
  if [ ! -f "$migration" ]; then
    echo "No Samrat migration SQL files found in /migrations." >&2
    exit 1
  fi
  filename="$(basename "$migration")"
  # psql variables are expanded in stdin/files, not in SQL passed with -c.
  # Keep the quoted variable syntax so filenames remain SQL string literals.
  applied="$(psql -X -v ON_ERROR_STOP=1 -v filename="$filename" -Atq <<'SQL'
select exists(select 1 from samrat_installer.schema_migrations where filename = :'filename');
SQL
  )"

  if [ "$applied" = "t" ]; then
    echo "Already applied: $filename"
    continue
  fi

  echo "Applying: $filename"
  psql -X -v ON_ERROR_STOP=1 -f "$migration"
  psql -X -v ON_ERROR_STOP=1 -v filename="$filename" <<'SQL'
insert into samrat_installer.schema_migrations(filename) values (:'filename');
SQL
done

echo "Samrat database migrations are current."
