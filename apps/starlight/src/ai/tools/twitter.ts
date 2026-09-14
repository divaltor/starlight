import { tool } from "ai";
import type { Tool } from "ai";
import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { z } from "zod";

export namespace Twitter {
  export const profileId = "twitter-fx-v1";
  const MAX_POSTS = 4;
  const FETCH_TIMEOUT_MS = 5000;
  const postUrl = z
    .url()
    .regex(
      /^https?:\/\/(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com)\/(?:[\w]+|i\/web)\/status\/\d+(?:[/?#].*)?$/iu,
      "Expected an X/Twitter post URL",
    );
  const postSchema = Schema.Struct({
    id: Schema.String,
    url: Schema.String,
    text: Schema.String,
    author: Schema.Struct({ name: Schema.String, screen_name: Schema.String }),
    created_at: Schema.String,
    replying_to_status: Schema.optional(Schema.NullOr(Schema.String)),
    media: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          photos: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String }))),
          videos: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String, thumbnail_url: Schema.String }))),
        }),
      ),
    ),
    article: Schema.optional(Schema.NullOr(Schema.Struct({ title: Schema.String, preview_text: Schema.String }))),
  });
  const tweetSchema = Schema.Struct({
    ...postSchema.fields,
    quote: Schema.optional(Schema.NullOr(postSchema)),
  });
  const responseSchema = Schema.Struct({
    code: Schema.Number,
    message: Schema.String,
    tweet: Schema.optional(Schema.NullOr(tweetSchema)),
  });

  export class TwitterError extends Schema.TaggedError<TwitterError>()("TwitterError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    static fromCause(input: { message: string; cause: unknown }) {
      return new TwitterError(input);
    }
  }

  export interface Interface {
    readonly tools: { readonly read_twitter: Tool<{ url: string }> };
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/Twitter") {}

  export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
    Service,
    Effect.gen(function* layer() {
      const client = yield* HttpClient.HttpClient;
      const fetchPost = Effect.fn("Twitter.fetchPost")(function* fetchPost(id: string) {
        const data = yield* client.get(`https://api.fxtwitter.com/status/${encodeURIComponent(id)}`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(responseSchema)),
          Effect.timeout(FETCH_TIMEOUT_MS),
          Effect.mapError((cause) => TwitterError.fromCause({ message: "Failed to read post from FxTwitter", cause })),
        );
        if (data.code !== 200 || !data.tweet) {
          return yield* new TwitterError({ message: `FxTwitter post unavailable: ${data.message}` });
        }
        return data.tweet;
      });
      const readChain = Effect.fn("Twitter.readChain")(function* readChain(
        id: string,
        remaining: number,
      ): Effect.fn.Return<{ posts: (typeof tweetSchema.Type)[]; hasMore: boolean }, TwitterError> {
        const post = yield* fetchPost(id);
        if (!post.replying_to_status || remaining === 1) {
          return { posts: [post], hasMore: Boolean(post.replying_to_status) };
        }
        const parent = yield* readChain(post.replying_to_status, remaining - 1);
        return { posts: [...parent.posts, post], hasMore: parent.hasMore };
      });

      return Service.of({
        tools: {
          read_twitter: tool({
            description:
              "Read an X/Twitter post via FxTwitter, including up to three parent posts (four total), oldest first. Includes quoted-post text, media URLs, and article previews when available; media URLs are not visual analysis and article previews are not full articles. Use this instead of web_fetch_exa for Twitter/X post URLs. hasMore means earlier ancestors were omitted. This does not fetch replies below the post.",
            inputSchema: z.object({ url: postUrl }),
            execute: (input, options) =>
              Effect.runPromise(
                readChain(new URL(input.url).pathname.replace(/^\/.*?\/status\/(?<id>\d+).*$/iu, "$<id>"), MAX_POSTS),
                { signal: options.abortSignal },
              ),
          }),
        },
      });
    }),
  );
}
