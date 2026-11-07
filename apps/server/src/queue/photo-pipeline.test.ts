import { afterAll, expect, mock, spyOn, test } from "bun:test";
import type { Tweet } from "@the-convocation/twitter-scraper";

if (process.env.PHOTO_PIPELINE_INTEGRATION === "1") {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  const redisUrl = new URL(process.env.REDIS_URL!);

  if (
    !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
    !databaseUrl.pathname.endsWith("_test") ||
    !["127.0.0.1", "localhost"].includes(redisUrl.hostname) ||
    redisUrl.pathname !== "/15"
  ) {
    throw new Error("Photo pipeline tests require local PostgreSQL (*_test database) and Redis database 15");
  }

  process.env.COOKIE_ENCRYPTION_KEY = "a".repeat(64);
  process.env.COOKIE_ENCRYPTION_SALT = "photo-test-salt-123";
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
}

const uploadedImages = new Map<string, Uint8Array>();

const objectStorage =
  process.env.PHOTO_PIPELINE_INTEGRATION === "1"
    ? Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method !== "PUT") return new Response(null, { status: 405 });
          uploadedImages.set(new URL(request.url).pathname.slice(1), new Uint8Array(await request.arrayBuffer()));

          return new Response(null, { headers: { ETag: "photo-test" } });
        },
      })
    : undefined;

if (objectStorage) process.env.AWS_ENDPOINT = objectStorage.url.toString();

afterAll(async () => {
  if (process.env.PHOTO_PIPELINE_INTEGRATION !== "1") return;

  const { prisma } = await import("@starlight/utils");
  const { imagesQueue, imagesWorker } = await import("@/queue/image-collector");
  const { scrapperQueue, scrapperWorker } = await import("@/queue/scrapper");
  const { classificationQueue, classificationWorker } = await import("@/queue/classification");
  const { embeddingsQueue, embeddingsWorker } = await import("@/queue/embeddings");
  const { redis } = await import("@/storage");
  await Promise.all([
    imagesWorker.close(),
    scrapperWorker.close(),
    classificationWorker.close(),
    embeddingsWorker.close(),
  ]);
  await Promise.all([imagesQueue.close(), scrapperQueue.close(), classificationQueue.close(), embeddingsQueue.close()]);
  await prisma.$disconnect();
  await redis.quit();
  await objectStorage!.stop(true);
});

// Run alone with PHOTO_PIPELINE_INTEGRATION=1 and migrated local test DATABASE_URL / REDIS_URL.
test.skipIf(process.env.PHOTO_PIPELINE_INTEGRATION !== "1").each([
  { crossUser: false, pending: false },
  { crossUser: true, pending: false },
  { crossUser: true, pending: true },
])("test_collects_photos_per_user_when_%j", async (params) => {
  const { prisma } = await import("@starlight/utils");
  const { retrieveUserTweets } = await import("@starlight/api/routers/tweets");
  const { Scraper } = await import("@the-convocation/twitter-scraper");
  const { imagesQueue, imagesWorker } = await import("@/queue/image-collector");
  const { scrapperQueue, scrapperWorker } = await import("@/queue/scrapper");
  const { classificationQueue } = await import("@/queue/classification");
  const { embeddingsQueue } = await import("@/queue/embeddings");
  const sharpModule = await import("sharp");
  const userId = crypto.randomUUID();
  const canonicalUserId = params.crossUser ? crypto.randomUUID() : userId;
  const canonicalPhotoId = params.crossUser ? "101" : "2";
  const userIds = [...new Set([userId, canonicalUserId])];
  const canonicalTimestamp = new Date("2020-01-01T00:00:00Z");

  const tweet: Tweet = {
    id: "100",
    hashtags: [],
    mentions: [],
    photos: [{ id: "101", url: "https://photo.invalid/duplicate.jpg", alt_text: "" }],
    thread: [],
    urls: [],
    videos: [],
  };

  const canonicalTweet: Tweet = {
    ...tweet,
    id: "1",
    photos: [{ ...tweet.photos[0]!, id: canonicalPhotoId }],
  };

  const knownTweets: Tweet[] = Array.from({ length: 14 }, (_, index) => ({
    ...tweet,
    id: String(200 + index),
    photos: [],
  }));

  const unseenTweet: Tweet = { ...tweet, id: "300", photos: [] };

  try {
    await prisma.user.createMany({
      data: userIds.map((id, index) => ({
        id,
        telegramId: BigInt(`0x${userId.replaceAll("-", "").slice(0, 12)}`) + BigInt(index),
        firstName: "Photo pipeline test",
        cookies: JSON.stringify([{ "Host raw": "https://x.com/", "Name raw": "twid", "Content raw": "u=123" }]),
      })),
    });
    await prisma.tweet.createMany({
      data: [
        { id: "1", userId: canonicalUserId, tweetData: canonicalTweet },
        { id: tweet.id!, userId, tweetData: tweet },
        ...knownTweets.map((knownTweet) => ({ id: knownTweet.id!, userId, tweetData: knownTweet })),
      ],
    });

    const image = await sharpModule
      .default({ create: { width: 48, height: 32, channels: 3, background: "red" } })
      .jpeg()
      .toBuffer();

    const fetchPhoto = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(image))
      .mockResolvedValueOnce(new Response(image));

    await imagesQueue.add("canonical", { tweet: canonicalTweet, userId: canonicalUserId });
    const canonicalJob = await imagesWorker.getNextJob("canonical-test", { block: false });
    await imagesWorker.processJob(canonicalJob, "canonical-test", () => false);
    expect(await canonicalJob.getState()).toBe("completed");
    await prisma.photo.update({
      where: { photoId: { id: canonicalPhotoId, userId: canonicalUserId } },
      data: { updatedAt: canonicalTimestamp },
    });

    if (params.pending) {
      await prisma.photo.create({
        data: { id: "101", userId, tweetId: "100", originalUrl: tweet.photos[0]!.url },
      });
      const pending = await prisma.photo.findUniqueOrThrow({ where: { photoId: { id: "101", userId } } });
      expect(pending.s3Path).toBeNull();
      expect(pending.deletedAt).toBeNull();
    }

    await imagesQueue.add("duplicate", { tweet, userId });
    const imageJob = await imagesWorker.getNextJob("photo-test", { block: false });
    expect(imageJob).toBeDefined();
    await imagesWorker.processJob(imageJob, "photo-test", () => false);
    expect(await imageJob.getState()).toBe("completed");

    const collected = await prisma.photo.findUniqueOrThrow({ where: { photoId: { id: "101", userId } } });
    expect(collected.deletedAt === null).toBe(params.crossUser);

    const canonical = await prisma.photo.findUniqueOrThrow({
      where: { photoId: { id: canonicalPhotoId, userId: canonicalUserId } },
    });

    expect(canonical.updatedAt.getTime() > canonicalTimestamp.getTime()).toBe(!params.crossUser);
    expect(canonical.deletedAt).toBeNull();
    expect(collected.s3Path === null).toBe(!params.crossUser);

    if (params.crossUser) {
      expect(collected.s3Path).not.toBe(canonical.s3Path);
      expect(uploadedImages.get(collected.s3Path!)).toEqual(new Uint8Array(image));
      expect(collected.perceptualHash).toBe(canonical.perceptualHash);
      expect(collected).toMatchObject({ width: 48, height: 32 });
    }

    expect(uploadedImages.get(canonical.s3Path!)).toEqual(new Uint8Array(image));
    expect(uploadedImages.size).toBe(params.crossUser ? 2 : 1);

    fetchPhoto.mockRejectedValue(new Error("Terminal photos must not download again"));
    await imagesQueue.add("retry", { tweet, userId });
    const retryJob = await imagesWorker.getNextJob("retry-test", { block: false });
    await imagesWorker.processJob(retryJob, "retry-test", () => false);
    expect(await retryJob.getState()).toBe("completed");
    const retried = await prisma.photo.findUniqueOrThrow({ where: { photoId: { id: "101", userId } } });
    expect(retried.deletedAt).toEqual(collected.deletedAt);
    expect(retried.s3Path).toBe(collected.s3Path);

    spyOn(Scraper.prototype, "setCookies").mockResolvedValue();
    spyOn(Scraper.prototype, "fetchLikedTweets").mockResolvedValue({
      tweets: [...knownTweets, tweet, unseenTweet],
      next: "next-page",
    });
    await scrapperQueue.add("scrape", { userId, count: 0, limit: 100 });
    const scrapeJob = await scrapperWorker.getNextJob("scrape-test", { block: false });
    await scrapperWorker.processJob(scrapeJob, "scrape-test", () => false);
    expect(await scrapeJob.getState()).toBe("completed");
    expect(await prisma.tweet.findUnique({ where: { tweetId: { id: "300", userId } } })).toBeNull();
    const delayedJobs = await scrapperQueue.getJobs(["delayed"]);
    expect(delayedJobs.filter((job) => job.data.userId === userId)).toHaveLength(0);

    await prisma.photo.create({
      data: { id: "102", userId, tweetId: "100", originalUrl: "https://photo.invalid/pending.jpg" },
    });
    await scrapperQueue.add("mixed", { userId, count: 0, limit: 1 });
    const mixedJob = await scrapperWorker.getNextJob("mixed-test", { block: false });
    await scrapperWorker.processJob(mixedJob, "mixed-test", () => false);
    expect(await mixedJob.getState()).toBe("completed");
    expect(await prisma.tweet.findUnique({ where: { tweetId: { id: "300", userId } } })).not.toBeNull();

    const availablePhotos = await prisma.photo.findMany({ where: { userId, ...prisma.photo.available() } });
    expect(availablePhotos.map((photo) => photo.id)).toEqual(params.crossUser ? ["101"] : ["2"]);
    const gallery = await retrieveUserTweets({ userId, limit: 30 });
    expect(gallery.tweets.flatMap((item) => item.photos.map((photo) => photo.id))).toEqual(
      params.crossUser ? ["101"] : ["2"],
    );
    const classificationJobs = await classificationQueue.getJobs();
    expect(classificationJobs.filter((job) => job.data.userId === userId).map((job) => job.data.photoId)).toEqual(
      params.crossUser ? ["101"] : ["2"],
    );
    expect(classificationJobs).toHaveLength(params.crossUser ? 2 : 1);
    expect(await embeddingsQueue.getJobs()).toHaveLength(0);
  } finally {
    mock.restore();

    for (const queue of [imagesQueue, scrapperQueue, classificationQueue, embeddingsQueue]) {
      const jobs = await queue.getJobs(["wait", "active", "completed", "failed", "delayed"]);
      await Promise.all(
        jobs
          .filter((job) => userIds.some((id) => id === job.data.userId))
          .map(async (job) => {
            await job.remove();
          }),
      );
    }

    await prisma.photo.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.tweet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    uploadedImages.clear();
  }
});
