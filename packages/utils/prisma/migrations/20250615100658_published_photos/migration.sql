-- CreateTable
CREATE TABLE "chats" (
    "id" BIGINT NOT NULL,
    "title" TEXT,
    "username" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_photos" (
    "photo_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "published_photos_pkey" PRIMARY KEY ("photo_id","user_id","chat_id")
);

-- AddForeignKey
ALTER TABLE "published_photos" ADD CONSTRAINT "published_photos_photo_id_user_id_fkey" FOREIGN KEY ("photo_id", "user_id") REFERENCES "photos"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_photos" ADD CONSTRAINT "published_photos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_photos" ADD CONSTRAINT "published_photos_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
