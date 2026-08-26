import { expect, test } from "bun:test";
import type { FileApiFlavor } from "@grammyjs/files";
import { Effect, ManagedRuntime } from "effect";
import { Bot } from "grammy";
import type { Context, Api } from "grammy";
import { Media } from "@/media/media";

test("marks Telegram media unavailable when its declared size exceeds 20 MiB", async () => {
  const runtime = ManagedRuntime.make(
    Media.layer({
      accessKeyId: "test",
      endpoint: "https://s3.example.com",
      secretAccessKey: "test",
      telegramApi: new Bot<Context, FileApiFlavor<Api>>("test").api,
    }),
  );

  try {
    const reference = await runtime.runPromise(
      Effect.gen(function* verifyBoundary() {
        const media = yield* Media.Service;
        return yield* media.ingest({
          declaredSize: 20 * 1024 * 1024 + 1,
          mimeType: "video/mp4",
          telegramFileId: "file-id",
          telegramFileUniqueId: "unique-id",
          type: "video",
        });
      }),
    );

    expect(reference.availability).toBe("unavailable");
    expect(reference.stableDescription).toBe("video unavailable: media exceeds the 20 MiB boundary");
  } finally {
    await runtime.dispose();
  }
});
