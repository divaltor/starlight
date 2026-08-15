-- Expand first so this migration also accepts databases that ran the briefly
-- modified 20260814000000 migration with a non-null credential_type column.
ALTER TABLE "provider_credentials"
  ADD COLUMN IF NOT EXISTS "credential_type" TEXT;
ALTER TABLE "provider_credentials"
  ALTER COLUMN "credential_type" DROP NOT NULL;

-- Rows created by the provider-neutral Pixiv migration predate credential types.
UPDATE "provider_credentials"
SET "credential_type" = 'refresh_token'
WHERE "provider" = 'pixiv'
  AND "credential_type" IS NULL;

UPDATE "provider_credentials"
SET "credential_type" = 'cookies'
WHERE "provider" = 'twitter'
  AND "credential_type" IS NULL;

-- Only copy legacy cookies when no Twitter credential already exists. A newer
-- provider credential always wins over the legacy users.cookies value.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name = 'cookies'
  ) THEN
    EXECUTE $sql$
      INSERT INTO "provider_credentials" (
        "user_id",
        "provider",
        "credential_type",
        "encrypted_secret",
        "created_at",
        "updated_at"
      )
      SELECT
        "id",
        'twitter',
        'cookies',
        "cookies",
        "created_at",
        "updated_at"
      FROM "users"
      WHERE "cookies" IS NOT NULL
      ON CONFLICT ("user_id", "provider") DO NOTHING
    $sql$;
  END IF;
END
$migration$;

-- Fail rather than silently inventing a credential type for an unknown provider.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "provider_credentials" WHERE "credential_type" IS NULL
  ) THEN
    RAISE EXCEPTION 'provider_credentials contains rows without a credential type';
  END IF;
END
$migration$;

ALTER TABLE "provider_credentials"
  ALTER COLUMN "credential_type" SET NOT NULL;
ALTER TABLE "users" DROP COLUMN IF EXISTS "cookies";
