import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Media } from "@/media/media";

test("marks Telegram media unavailable when its declared size exceeds 20 MiB", async () => {
  const runtime = ManagedRuntime.make(
    Media.layer({
      accessKeyId: "test",
      endpoint: "https://s3.example.com",
      secretAccessKey: "test",
      telegramToken: "test",
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
