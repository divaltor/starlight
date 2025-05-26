import UserAgent from "user-agents";
import { z } from "zod";

// Types
type UserID = string | number;
type PostID = string;

// Constants
const DEFAULT_KWARGS = {
	articles_preview_enabled: false,
	c9s_tweet_anatomy_moderator_badge_enabled: true,
	communities_web_enable_tweet_community_results_fetch: true,
	creator_subscriptions_quote_tweet_preview_enabled: false,
	creator_subscriptions_tweet_preview_api_enabled: true,
	freedom_of_speech_not_reach_fetch_enabled: true,
	graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
	longform_notetweets_consumption_enabled: true,
	longform_notetweets_inline_media_enabled: true,
	longform_notetweets_rich_text_read_enabled: true,
	responsive_web_edit_tweet_api_enabled: true,
	responsive_web_enhance_cards_enabled: false,
	responsive_web_graphql_exclude_directive_enabled: true,
	responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
	responsive_web_graphql_timeline_navigation_enabled: true,
	responsive_web_media_download_video_enabled: false,
	responsive_web_twitter_article_tweet_consumption_enabled: true,
	rweb_tipjar_consumption_enabled: true,
	rweb_video_timestamps_enabled: true,
	standardized_nudges_misinfo: true,
	tweet_awards_web_tipping_enabled: false,
	tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
	tweet_with_visibility_results_prefer_gql_media_interstitial_enabled: false,
	tweetypie_unmention_optimization_enabled: true,
	verified_phone_label_enabled: false,
	view_counts_everywhere_api_enabled: true,
	responsive_web_grok_analyze_button_fetch_trends_enabled: false,
	premium_content_api_read_enabled: false,
	profile_label_improvements_pcf_label_in_post_enabled: false,
	responsive_web_grok_share_attachment_enabled: false,
	responsive_web_grok_analyze_post_followups_enabled: false,
	responsive_web_grok_image_annotation_enabled: false,
	responsive_web_grok_analysis_button_from_backend: false,
	responsive_web_jetfuel_frame: false,
	rweb_video_screen_enabled: true,
	responsive_web_grok_show_grok_translated_post: true,
} as const;

// Schemas
const MediaTypeSchema = z.enum(["photo", "video", "animated_gif"]);

const PostMediaSchema = z
	.object({
		media_id: z.string(),
		media_key: z.string(),
		url: z.string(),
		media_type: MediaTypeSchema,
	})
	.transform((data) => ({
		mediaId: data.media_id,
		mediaKey: data.media_key,
		url: data.url,
		mediaType: data.media_type,
		get largeUrl() {
			return `${data.url}?format=jpg&name=large`;
		},
		get isPhoto() {
			return data.media_type === "photo";
		},
	}));

const TwitterUserSchema = z
	.object({
		rest_id: z.string(),
		legacy: z.object({
			name: z.string(),
			screen_name: z.string(),
			profile_image_url_https: z.string(),
		}),
		is_blue_verified: z.boolean(),
	})
	.transform((data) => ({
		userId: Number.parseInt(data.rest_id),
		name: data.legacy.name,
		username: data.legacy.screen_name,
		avatar: data.legacy.profile_image_url_https,
		isBlueVerified: data.is_blue_verified,
	}));

const TwitterPostSchema = z
	.object({
		rest_id: z.string().optional(),
		entryId: z.string().optional(),
		legacy: z
			.object({
				extended_entities: z
					.object({
						media: z.array(z.any()).optional(),
					})
					.optional(),
			})
			.optional(),
		core: z.object({
			user_results: z.object({
				result: z.any(),
			}),
		}),
	})
	.transform((data) => {
		const postId = (data.rest_id || data.entryId || "").replace(/^tweet-/, "");
		const media = data.legacy?.extended_entities?.media || [];
		const user = TwitterUserSchema.parse(data.core.user_results.result);

		return {
			postId,
			media: media.map((m: any) =>
				PostMediaSchema.parse({
					media_id: m.id_str,
					media_key: m.media_key,
					url: m.media_url_https,
					media_type: m.type,
				}),
			),
			user,
			get url() {
				return `https://x.com/${user.username}/status/${postId}`;
			},
		};
	});

export type TwitterUser = z.infer<typeof TwitterUserSchema>;
export type TwitterPost = z.infer<typeof TwitterPostSchema>;
export type PostMedia = z.infer<typeof PostMediaSchema>;

// Utility functions
function encodeParams(data: Record<string, any>): Record<string, string> {
	const result: Record<string, string> = {};

	for (const [key, value] of Object.entries(data)) {
		if (typeof value === "object" && value !== null) {
			const filteredValue = Object.fromEntries(
				Object.entries(value).filter(([, v]) => v !== null && v !== undefined),
			);
			result[key] = JSON.stringify(filteredValue);
		}
	}

	return result;
}

function findKeyRecursive(
	data: any,
	targetKey: string,
	targetPrefix?: string,
): any {
	const stack = [data];

	while (stack.length > 0) {
		const current = stack.pop();

		if (typeof current === "object" && current !== null) {
			if (Array.isArray(current)) {
				stack.push(...current);
			} else {
				if (targetKey in current) {
					const value = current[targetKey];
					if (targetPrefix === undefined) {
						return value;
					}

					if (typeof value === "string" && value.startsWith(targetPrefix)) {
						return current;
					}
				}

				stack.push(...Object.values(current));
			}
		}
	}

	return null;
}

function extractPostId(url: string): string {
	const match = url.match(/^https:\/\/x\.com\/(.*)\/status\/(\d+)(\?s=.*)?$/);

	if (!match) {
		throw new Error("Invalid post ID");
	}

	return match[2];
}

export class TwitterAPIError extends Error {
	constructor(
		public readonly statusCode: number,
		public readonly reason: string,
	) {
		super(`Unexpected error from Twitter API: ${statusCode} ${reason}`);
		this.name = "TwitterAPIError";
	}

	static fromResponse(response: Response, text: string): TwitterAPIError {
		return new TwitterAPIError(response.status, text);
	}
}

// Main API class
export class TwitterAPI {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;

	constructor(
		cookies: Record<string, string>,
		baseUrl = "https://x.com/i/api/graphql/",
		userAgent?: string,
	) {
		this.baseUrl = baseUrl;
		this.headers = {
			"User-Agent": userAgent || new UserAgent().toString(),
			"x-twitter-client-language": "en",
			"x-twitter-active-user": "yes",
			Authorization:
				"Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
			"x-csrf-token": cookies.ct0,
			"x-twitter-auth-type": "OAuth2Session",
			Cookie: Object.entries(cookies)
				.map(([key, value]) => `${key}=${value}`)
				.join("; "),
		};
	}

	private static prepareParams(
		data?: Record<string, any>,
		features?: Record<string, any>,
	): Record<string, any> {
		const featuresPayload = { ...DEFAULT_KWARGS, ...features };

		return {
			variables: data || {},
			features: featuresPayload,
		};
	}

	async *listGraphqlRequest(
		url: string,
		data?: Record<string, any>,
		features?: Record<string, any>,
	): AsyncGenerator<any[]> {
		const params = TwitterAPI.prepareParams(data, features);
		let cursor: string | null = null;

		do {
			if (cursor) {
				params.variables.cursor = cursor;
			}

			const searchParams = new URLSearchParams(encodeParams(params));
			const fullUrl = `${this.baseUrl}${url}?${searchParams}`;

			const response = await fetch(fullUrl, {
				method: "GET",
				headers: this.headers,
			});

			if (!response.ok) {
				const text = await response.text();
				console.error("Twitter API error:", text);
				throw TwitterAPIError.fromResponse(response, text);
			}

			let jsonResponse: any;
			try {
				jsonResponse = await response.json();
			} catch (error) {
				const text = await response.text();
				throw TwitterAPIError.fromResponse(response, text);
			}

			console.debug("JSON response:", JSON.stringify(jsonResponse));

			const entries = findKeyRecursive(jsonResponse, "entries");

			if (!entries) {
				return;
			}

			const filteredEntries = entries.filter(
				(entry: any) =>
					entry?.entryId &&
					!entry.entryId.startsWith("cursor-") &&
					!entry.entryId.startsWith("messageprompt-"),
			);

			console.debug("Filtered entries:", filteredEntries);

			if (filteredEntries.length > 0) {
				yield filteredEntries;
			} else {
				return;
			}

			const cursorEntry = findKeyRecursive(
				jsonResponse,
				"entryId",
				"cursor-bottom",
			);

			if (!cursorEntry) {
				return;
			}

			cursor = cursorEntry.content?.itemContent?.value || null;
		} while (cursor);
	}

	async getGraphqlRequest(
		url: string,
		data?: Record<string, any>,
		features?: Record<string, any>,
	): Promise<any | null> {
		const params = TwitterAPI.prepareParams(data, features);
		const searchParams = new URLSearchParams(encodeParams(params));
		const fullUrl = `${this.baseUrl}${url}?${searchParams}`;

		const response = await fetch(fullUrl, {
			method: "GET",
			headers: this.headers,
		});

		if (response.status === 404) {
			return null;
		}

		if (!response.ok) {
			const text = await response.text();
			throw TwitterAPIError.fromResponse(response, text);
		}

		let jsonResponse: any;
		try {
			jsonResponse = await response.json();
		} catch (error) {
			const text = await response.text();
			throw TwitterAPIError.fromResponse(response, text);
		}

		console.debug("JSON response:", JSON.stringify(jsonResponse));

		return jsonResponse;
	}

	get users(): Users {
		return new Users(this);
	}

	get likes(): Likes {
		return new Likes(this);
	}

	get posts(): Posts {
		return new Posts(this);
	}
}

// Base endpoint class
abstract class BaseEndpoint<T> {
	protected abstract readonly operator: string;
	protected abstract readonly features: Record<string, any>;
	protected abstract readonly variables: Record<string, any>;

	constructor(protected readonly api: TwitterAPI) {}

	protected async *listRequest(
		data?: Record<string, any>,
	): AsyncGenerator<any[]> {
		const requestData = { ...this.variables, ...data };

		for await (const entries of this.api.listGraphqlRequest(
			this.operator,
			requestData,
			this.features,
		)) {
			yield entries;
		}
	}

	protected async singleRequest(
		data?: Record<string, any>,
	): Promise<any | null> {
		const requestData = { ...this.variables, ...data };

		return await this.api.getGraphqlRequest(
			this.operator,
			requestData,
			this.features,
		);
	}

	protected abstract serialize(data: any): T;
}

// Users endpoint
export class Users extends BaseEndpoint<TwitterUser> {
	protected readonly operator = "1VOOyvKkiI3FMmkeDNxM9A/UserByScreenName";
	protected readonly variables = {};
	protected readonly features = {
		highlights_tweets_tab_ui_enabled: true,
		hidden_profile_likes_enabled: true,
		creator_subscriptions_tweet_preview_api_enabled: true,
		hidden_profile_subscriptions_enabled: true,
		subscriptions_verification_info_verified_since_enabled: true,
		subscriptions_verification_info_is_identity_verified_enabled: false,
		responsive_web_twitter_article_notes_tab_enabled: false,
		subscriptions_feature_can_gift_premium: false,
		profile_label_improvements_pcf_label_in_post_enabled: false,
	};

	protected serialize(data: any): TwitterUser {
		const result = findKeyRecursive(data, "result");
		return TwitterUserSchema.parse(result);
	}

	async get(username: string): Promise<TwitterUser | null> {
		const data = await this.singleRequest({
			screen_name: username,
			withSafetyModeUserFields: true,
		});

		if (!data) {
			return null;
		}

		return this.serialize(data);
	}
}

// Posts endpoint
export class Posts extends BaseEndpoint<TwitterPost> {
	protected readonly operator = "_8aYOgEDz35BrBcBal1-_w/TweetDetail";
	protected readonly variables = {
		with_rux_injections: true,
		includePromotedContent: true,
		withCommunity: true,
		withQuickPromoteEligibilityTweetFields: true,
		withBirdwatchNotes: true,
		withVoice: true,
		withV2Timeline: true,
	};
	protected readonly features = {};

	protected serialize(data: any): TwitterPost {
		const firstPost = findKeyRecursive(data, "entries");

		if (!firstPost) {
			const result = findKeyRecursive(data, "result");
			return TwitterPostSchema.parse(result);
		}

		const result = findKeyRecursive(firstPost, "result");
		return TwitterPostSchema.parse(result);
	}

	async get(postIdOrUrl: string): Promise<TwitterPost | null> {
		let postId: string;

		try {
			postId = postIdOrUrl.includes("x.com")
				? extractPostId(postIdOrUrl)
				: postIdOrUrl;
		} catch (error) {
			console.error("Twitter API error:", error);
			return null;
		}

		const data = await this.singleRequest({
			focalTweetId: postId,
		});

		if (!data) {
			return null;
		}

		try {
			return this.serialize(data);
		} catch (error) {
			console.error("Twitter API error:", error);
			return null;
		}
	}
}

// Likes endpoint
export class Likes extends BaseEndpoint<TwitterPost> {
	protected readonly operator = "XHTMjDbiTGLQ9cP1em-aqQ/Likes";
	protected readonly variables = {
		includePromotedContent: false,
		withClientEventToken: false,
		withBirdwatchNotes: false,
		withVoice: true,
	};
	protected readonly features = {};

	protected serialize(data: any): TwitterPost {
		return TwitterPostSchema.parse(data);
	}

	async *list(userId: UserID, count?: number): AsyncGenerator<TwitterPost[]> {
		const data = {
			userId: String(userId),
			count: count || 20,
		};

		for await (const entries of this.listRequest(data)) {
			yield entries.map((entry) => this.serialize(entry));
		}
	}
}
