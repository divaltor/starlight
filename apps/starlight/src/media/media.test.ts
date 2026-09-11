import { expect, test } from "bun:test";
import type { FileApiFlavor } from "@grammyjs/files";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
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
    }).pipe(Layer.provide(FetchHttpClient.layer)),
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

test("marks PDFs unavailable when they exceed 25 pages", async () => {
  const pdf = createBlankPdf(26);
  using server = Bun.serve({ fetch: () => new Response(pdf) });
  const runtime = ManagedRuntime.make(
    Media.layer({
      accessKeyId: "test",
      endpoint: "https://s3.example.com",
      secretAccessKey: "test",
      telegramApi: {
        getFile: () =>
          Promise.resolve({ file_id: "file-id", file_unique_id: "unique-id", getUrl: () => server.url.toString() }),
      },
    }).pipe(Layer.provide(FetchHttpClient.layer)),
  );

  try {
    const reference = await runtime.runPromise(
      Effect.gen(function* verifyPdfPageBoundary() {
        const media = yield* Media.Service;
        return yield* media.ingest({
          declaredSize: pdf.byteLength,
          mimeType: "application/pdf",
          telegramFileId: "file-id",
          telegramFileUniqueId: "unique-id",
          type: "document",
        });
      }),
    );

    expect(reference.availability).toBe("unavailable");
    expect(reference.stableDescription).toBe("document unavailable: PDF exceeds the 25-page boundary");
  } finally {
    await runtime.dispose();
  }
});

function createBlankPdf(pageCount: number): Uint8Array<ArrayBuffer> {
  const pageReferences = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageReferences}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
  ];
  const encoder = new TextEncoder();
  const parts = ["%PDF-1.4\n"];
  const offsets = objects.map((object, index) => {
    const offset = encoder.encode(parts.join("")).byteLength;
    parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
    return offset;
  });
  const xrefOffset = encoder.encode(parts.join("")).byteLength;
  parts.push(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  );
  return encoder.encode(parts.join(""));
}
