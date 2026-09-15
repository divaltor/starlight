-- CreateTable
CREATE TABLE "user_tool_cooldowns" (
    "user_id" UUID NOT NULL,
    "cooldown_key" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_tool_cooldowns_pkey" PRIMARY KEY ("user_id","cooldown_key")
);

-- AddForeignKey
ALTER TABLE "user_tool_cooldowns" ADD CONSTRAINT "user_tool_cooldowns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
