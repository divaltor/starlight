import { expect, test } from "bun:test";
import { Youtube } from "@/ai/tools/youtube";

test("test_fail_open_to_youtube_when_redis_is_down", async () => {
  const cache = new Youtube.RedisCache({
    get: () => Promise.reject(new Error("redis down")),
    set: () => Promise.reject(new Error("redis down")),
  });

  expect(await cache.get("yt:transcript+details:dQw4w9WgXcQ:en")).toBeNull();
  expect(await cache.set("yt:transcript+details:dQw4w9WgXcQ:en", "{}")).toBeUndefined();
});

test("test_share_namespaced_keys_with_month_expiry_when_caching_transcripts", async () => {
  const stored = new Map<string, string>();
  const calls: (readonly [string, string, string, number])[] = [];
  const cache = new Youtube.RedisCache({
    get: (key) => Promise.resolve(stored.get(key) ?? null),
    set: (key, value, ex, seconds) => {
      calls.push([key, value, ex, seconds]);
      stored.set(key, value);
      return Promise.resolve("OK");
    },
  });

  await cache.set("yt:transcript+details:dQw4w9WgXcQ:en", '{"segments":[]}', 90_000);
  await cache.set("yt:transcript+details:dQw4w9WgXcQ:fr", '{"segments":[]}');

  expect(calls).toEqual([
    ["youtube:yt:transcript+details:dQw4w9WgXcQ:en", '{"segments":[]}', "EX", 90],
    ["youtube:yt:transcript+details:dQw4w9WgXcQ:fr", '{"segments":[]}', "EX", 30 * 24 * 3600],
  ]);
  expect(await cache.get("yt:transcript+details:dQw4w9WgXcQ:en")).toBe('{"segments":[]}');
});
