import type { FileFlavor } from "@grammyjs/files";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { Message, MessageEntity, MessageOrigin } from "@grammyjs/types";
import type { Chat, ChatMember, User } from "@starlight/utils";
import type { Tweet } from "@the-convocation/twitter-scraper";
import { Schema } from "effect";
import type { Context as BaseContext } from "grammy";
import type { Logger } from "@/logger";
import type { SavedAttachment } from "./utils/attachment";

interface ExtendedContext {
	attachments: SavedAttachment[];
	logger: Logger;
	user?: User;
	userChat?: Chat;
	userChatMember?: ChatMember;
	isSupervisor: boolean;
}

export interface Classification {
	aesthetic: number;
	characters: string[];
	nsfw: {
		is_nsfw: boolean;
		scores: {
			neutral: number;
			low: number;
			medium: number;
			high: number;
		};
	};
	style: {
		anime: number;
		other: number;
		third_dimension: number;
		real_life: number;
		manga_like: number;
	};
	tags: string[];
}

const ToolResultPartBase = {
	type: Schema.Literal("tool"),
};

export class SearchToolResultPart extends Schema.Class<SearchToolResultPart>(
	"SearchToolResultPart",
)({
	...ToolResultPartBase,
	toolName: Schema.Literal("search_web"),
	input: Schema.Struct({
		query: Schema.String,
	}),
	output: Schema.Struct({
		results: Schema.Array(
			Schema.Struct({
				content: Schema.String,
				index: Schema.Number,
				publishedDate: Schema.optional(Schema.String),
				source: Schema.String,
				title: Schema.optional(Schema.String),
				url: Schema.String,
			}),
		),
	}),
}) {
	formatContext(messageId: number): string {
		const sources = this.output.results
			.map((result) => {
				const title = result.title ?? result.url;
				const published = result.publishedDate ? `\nPublished: ${result.publishedDate}` : "";

				return `${result.index}. ${title}\nURL: ${result.url}\nSource: ${result.source}${published}\n${result.content}`;
			})
			.join("\n\n");

		return `Tool context for assistant message #${messageId}\nTool: ${this.toolName}\nQuery: ${this.input.query}\n${sources}`;
	}
}

export class FetchPageToolResultPart extends Schema.Class<FetchPageToolResultPart>(
	"FetchPageToolResultPart",
)({
	...ToolResultPartBase,
	toolName: Schema.Literal("fetch_page"),
	input: Schema.Struct({
		url: Schema.String,
	}),
	output: Schema.Struct({
		page: Schema.NullOr(
			Schema.Struct({
				content: Schema.String,
				source: Schema.String,
				url: Schema.String,
			}),
		),
	}),
}) {
	formatContext(messageId: number): string {
		return `Tool context for assistant message #${messageId}\nTool: ${this.toolName}\nURL: ${this.input.url}\n${
			this.output.page
				? `Fetched URL: ${this.output.page.url}\nSource: ${this.output.page.source}\n${this.output.page.content}`
				: "No page content found"
		}`;
	}
}

export const ToolResultPart = Schema.Union(SearchToolResultPart, FetchPageToolResultPart);
export type ToolResultPart = typeof ToolResultPart.Type;

export type MessagePartData = ToolResultPart;

export type Context = FileFlavor<HydrateFlavor<BaseContext & ExtendedContext>>;

declare global {
	// biome-ignore lint/style/noNamespace: Prisma
	namespace PrismaJson {
		type TweetType = Tweet;
		type ClassificationType = Classification;
		type MessageEntitiesType = MessageEntity[];
		type ForwardOriginType = MessageOrigin;
		type TelegramMessageType = Message;
		type MessagePartDataType = MessagePartData;
	}
}
