import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { Twitter } from "@/ai/tools/twitter";

test.each([
  { requested: "6", ids: ["3", "4", "5", "6"], hasMore: true },
  { requested: "4", ids: ["1", "2", "3", "4"], hasMore: false },
  { requested: "1", ids: ["1"], hasMore: false },
])("returns up to four ancestors oldest-first for post $requested", async ({ requested, ids, hasMore }) => {
  const tools = await Effect.runPromise(
    Twitter.Service.pipe(
      Effect.provide(Twitter.layer),
      Effect.provide(
        Layer.succeed(HttpClient.HttpClient)(
          HttpClient.make((request) => {
            const id = request.url.split("/").at(-1)!;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  code: 200,
                  message: "OK",
                  tweet: {
                    id,
                    url: `https://x.com/author/status/${id}`,
                    text: `Post ${id}`,
                    author: { name: "Author", screen_name: "author" },
                    created_at: "2026-09-14T10:00:00Z",
                    replying_to_status: id === "1" ? null : String(Number(id) - 1),
                  },
                }),
              ),
            );
          }),
        ),
      ),
    ),
  );

  const result = await tools.tools.read_twitter!.execute!(
    { url: `https://x.com/author/status/${requested}?s=20` },
    { toolCallId: "twitter", messages: [], context: null },
  );
  expect(result).toEqual({
    posts: ids.map((id) => ({
      id,
      url: `https://x.com/author/status/${id}`,
      text: `Post ${id}`,
      author: { name: "Author", screen_name: "author" },
      created_at: "2026-09-14T10:00:00Z",
      replying_to_status: id === "1" ? null : String(Number(id) - 1),
    })),
    hasMore,
  });
});
