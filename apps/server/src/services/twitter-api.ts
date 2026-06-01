import { Scraper, type Tweet } from "@the-convocation/twitter-scraper";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";
import { Cookies } from "@/storage";
import type { FxEmbedResponse, FxEmbedTweet } from "@/services/fxembed/types";

const FXEMBED_BASE_URL = "https://api.fxtwitter.com";
const FETCH_TIMEOUT_MS = 5000;
const USER_AGENT = "StarlightBot/1.0 (Telegram Bot)";

export class TwitterApiError extends Schema.TaggedErrorClass<TwitterApiError>()("TwitterApiError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {
	static fromCause(input: { message: string; cause: unknown }) {
		return new TwitterApiError({
			message: input.message,
			cause: Schema.Defect.make(input.cause),
		});
	}
}

export namespace TwitterApi {
	export interface Interface {
		readonly getTweet: (
			tweetId: string,
			cookies: Cookies,
		) => Effect.Effect<Tweet | null, TwitterApiError>;
		readonly getFxTweet: (
			tweetId: string,
			translateTo?: string,
		) => Effect.Effect<FxEmbedTweet | null, TwitterApiError>;
	}

	export class Service extends Context.Service<Service, Interface>()("starlight/TwitterApi") {}

	const getTweet = Effect.fn("TwitterApi.getTweet")(function* (tweetId: string, cookies: Cookies) {
		return yield* Effect.tryPromise({
			try: async () => {
				const scraper = new Scraper({ experimental: { xClientTransactionId: false, xpff: false } });
				await scraper.setCookies(cookies.toString().split(";"));

				return scraper.getTweet(tweetId);
			},
			catch: (error) =>
				TwitterApiError.fromCause({
					message: "Failed to fetch tweet from X",
					cause: error,
				}),
		});
	});

	export const getFxTweet = Effect.fn("TwitterApi.getFxTweet")(function* (
		tweetId: string,
		translateTo?: string,
	) {
		const twitterApi = yield* Service;
		return yield* twitterApi.getFxTweet(tweetId, translateTo);
	});

	export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
		Service,
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;

			const getFxTweet = Effect.fn("TwitterApi.getFxTweet")(function* (
				tweetId: string,
				translateTo?: string,
			) {
				const url = `${FXEMBED_BASE_URL}/status/${tweetId}${translateTo ? `/${translateTo}` : ""}`;

				const response = yield* client
					.execute(
						HttpClientRequest.get(url).pipe(
							HttpClientRequest.acceptJson,
							HttpClientRequest.setHeaders({
								"User-Agent": USER_AGENT,
							}),
						),
					)
					.pipe(
						Effect.timeout(Duration.millis(FETCH_TIMEOUT_MS)),
						Effect.mapError((error) =>
							TwitterApiError.fromCause({
								message: "Failed to fetch tweet from FxTwitter",
								cause: error,
							}),
						),
					);

				const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
					Effect.catch(() =>
						Effect.logWarning("FxEmbed API error", { status: response.status, tweetId }).pipe(
							Effect.as(null),
						),
					),
				);

				if (!okResponse) {
					return null;
				}

				const data = (yield* okResponse.json.pipe(
					Effect.mapError((error) =>
						TwitterApiError.fromCause({
							message: "Failed to parse FxTwitter response",
							cause: error,
						}),
					),
				)) as unknown as FxEmbedResponse;

				if (data.code !== 200 || !data.tweet) {
					yield* Effect.logWarning("FxEmbed returned non-200", {
						code: data.code,
						message: data.message,
						tweetId,
					});
					return null;
				}

				return data.tweet;
			});

			return Service.of({ getTweet, getFxTweet });
		}),
	);

	export const defaultLayer: Layer.Layer<Service> = layer.pipe(
		Layer.provide(FetchHttpClient.layer),
	);
}
