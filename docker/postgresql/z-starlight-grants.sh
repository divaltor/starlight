#!/bin/sh
# supabase/postgres creates $POSTGRES_DB owned by supabase_admin and demotes
# the postgres role to NOSUPERUSER without CREATE on schema public, so
# Prisma migrate fails with "permission denied for schema public" and
# Hindsight cannot create its schema. Hand ownership back to postgres.
#
# Runs after migrate.sh (sort order) as supabase_admin, whose password
# migrate.sh sets to POSTGRES_PASSWORD.
set -eu

export PGPASSWORD="${POSTGRES_PASSWORD:-}"

psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin -d "${POSTGRES_DB:?POSTGRES_DB is required}" <<'EOSQL'
ALTER SCHEMA public OWNER TO postgres;
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO postgres', current_database());
END
$$;
EOSQL
