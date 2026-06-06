import { extractTweetId } from "@starlight/utils";
import { Effect } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";
import { ExtractionError } from "@/services/extractors/base";
import { ExaExtractor } from "@/services/extractors/exa";
import { FetchExtractor } from "@/services/extractors/fetch";
import { WorkersExtractor } from "@/services/extractors/workers";
import { ParallelExtractor } from "@/services/extractors/parallel";
import { runtime } from "@/services/runtime";
import { TwitterApi } from "@/services/twitter-api";
import type { ConversationAttachment } from "@/utils/message";

export interface ExtractedMarkdown {
	attachments: ConversationAttachment[];
	markdown: string;
	source: string;
	url: string;
}

const ignoreExtractionError = (error: ExtractionError) =>
	Effect.logError(`${error.extractor}: ${error.message}`, { error }).pipe(Effect.as(null));

export const extractMarkdownEffect = Effect.fn("extractMarkdown")(function* (url: string) {
	const tweetId = extractTweetId(url);
	if (tweetId) {
		const twitterApi = yield* TwitterApi.Service;
		const tweet = yield* twitterApi.getFxTweet(tweetId, "en");

		if (tweet) {
			const attachments: ConversationAttachment[] = [];
			const mosaicUrl = tweet.media?.mosaic?.formats.jpeg ?? tweet.media?.mosaic?.url;

			if (mosaicUrl) {
				const client = yield* HttpClient.HttpClient;
				const response = yield* client.execute(HttpClientRequest.get(mosaicUrl));
				const okResponse = yield* HttpClientResponse.filterStatusOk(response);
				const data = yield* okResponse.arrayBuffer;
				const base64Data = Buffer.from(data).toString("base64");

				attachments.push({
					base64Data,
					mimeType: "image/jpeg",
					s3Path: `twitter/${tweet.id}-photos.jpg`,
					summary: `Twitter photo mosaic (${tweet.media?.photos?.length ?? 0} photos)`,
				});
			}

			const author = `@${tweet.author.screen_name}`;
			const markdownParts = [`Tweet by ${author}`, tweet.text?.trim()].filter(Boolean);

			if (tweet.quote) {
				markdownParts.push(
					`Quoted tweet by @${tweet.quote.author.screen_name}:\n${tweet.quote.text?.trim() ?? ""}`.trim(),
				);
			}

			markdownParts.push(`URL: ${tweet.url ?? url}`);

			return {
				attachments,
				url,
				source: "twitter",
				markdown: markdownParts.join("\n\n"),
			} satisfies ExtractedMarkdown;
		}
	}

	const fetchExtractor = yield* FetchExtractor.Service;
	const exaExtractor = yield* ExaExtractor.Service;
	const workersExtractor = yield* WorkersExtractor.Service;
	const parallelExtractor = yield* ParallelExtractor.Service;

	const fetchResult = yield* fetchExtractor.extract(url).pipe(Effect.catch(ignoreExtractionError));
	let markdown: string | null = null;
	let source: string | null = null;

	if (fetchResult?.kind === "markdown") {
		markdown = fetchResult.content;
		source = "fetch";
	}

	if (!markdown && exaExtractor.isEnabled()) {
		const exaResult = yield* exaExtractor.extract(url).pipe(Effect.catch(ignoreExtractionError));

		if (exaResult) {
			markdown = exaResult.content;
			source = "exa";
		}
	}

	if (!markdown && parallelExtractor.isEnabled()) {
		const parallelResult = yield* parallelExtractor
			.extract(url)
			.pipe(Effect.catch(ignoreExtractionError));

		if (parallelResult) {
			markdown = parallelResult.content;
			source = "parallel";
		}
	}

	if (!markdown && fetchResult?.kind === "html" && workersExtractor.isEnabled()) {
		const workersResult = yield* workersExtractor
			.extract({
				name: "page.html",
				data: fetchResult.content,
				type: "text/html",
			})
			.pipe(Effect.catch(ignoreExtractionError));

		if (workersResult) {
			markdown = workersResult.content;
			source = "workers";
		}
	}

	return markdown && source
		? ({ attachments: [], url, source, markdown } satisfies ExtractedMarkdown)
		: null;
});

export function extractMarkdown(url: string): Promise<ExtractedMarkdown | null> {
	return runtime.runPromise(extractMarkdownEffect(url).pipe(Effect.provide(FetchHttpClient.layer)));
}
