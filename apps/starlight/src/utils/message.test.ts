import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { toModelMessage, withOpenRouterGeminiCacheControl } from "@/utils/message";

const GEMINI_MODEL = "google/gemini-3-flash-preview";
const OTHER_MODEL = "google/gemini-2.5-flash";

const cacheControlProviderOptions = {
	openrouter: {
		cache_control: { type: "ephemeral" },
	},
};

test("labels the current user turn as the live message", () => {
	const result = toModelMessage(
		{
			attachments: [],
			context: [],
			includeAttachmentData: false,
			messageId: 42,
			replyToMessageId: null,
			role: "user",
			senderName: "Vlad",
			text: "комсы",
		},
		{ isLiveTurn: true },
	);

	expect(result).toEqual({
		role: "user",
		content: [
			{ type: "text", text: "LIVE MESSAGE #42 from Vlad" },
			{ type: "text", text: "комсы" },
		],
	});
});

describe("withOpenRouterGeminiCacheControl", () => {
	test("marks memory context and not recent text-only chat history", () => {
		const messages: ModelMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "### MEMORY CONTEXT\nlarge stable memory" }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "Message #1" }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "latest tiny message" }],
			},
		];

		const result = withOpenRouterGeminiCacheControl(messages, GEMINI_MODEL);

		expect(result[0]?.content).toEqual([
			{
				type: "text",
				text: "### MEMORY CONTEXT\nlarge stable memory",
				providerOptions: cacheControlProviderOptions,
			},
		]);
		expect(result[1]?.content).toEqual([{ type: "text", text: "Message #1" }]);
		expect(result[2]?.content).toEqual([{ type: "text", text: "latest tiny message" }]);
	});

	test("leaves media messages unmarked while caching memory", () => {
		const messages: ModelMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "### MEMORY CONTEXT\nlarge stable memory" }],
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "Message #2" },
					{
						type: "file",
						data: "https://cdn.starlight.day/image.jpg",
						mediaType: "image/jpeg",
					},
				],
			},
		];

		const result = withOpenRouterGeminiCacheControl(messages, GEMINI_MODEL);

		expect(result[0]?.content).toEqual([
			{
				type: "text",
				text: "### MEMORY CONTEXT\nlarge stable memory",
				providerOptions: cacheControlProviderOptions,
			},
		]);
		expect(result[1]?.content).toEqual([
			{ type: "text", text: "Message #2" },
			{
				type: "file",
				data: "https://cdn.starlight.day/image.jpg",
				mediaType: "image/jpeg",
			},
		]);
	});

	test("keeps cache control on memory when media appears between text messages", () => {
		const messages: ModelMessage[] = [
			{ role: "system", content: "stable system prompt" },
			{
				role: "user",
				content: [{ type: "text", text: "### MEMORY CONTEXT\nlarge stable memory" }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "Message #1" }],
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "Message #2" },
					{
						type: "file",
						data: "https://cdn.starlight.day/image.jpg",
						mediaType: "image/jpeg",
					},
				],
			},
			{
				role: "user",
				content: [{ type: "text", text: "Message #3 after media" }],
			},
		];

		const result = withOpenRouterGeminiCacheControl(messages, GEMINI_MODEL);

		expect(result[0]).toEqual({
			role: "system",
			content: "stable system prompt",
			providerOptions: cacheControlProviderOptions,
		});
		expect(result[1]?.content).toEqual([
			{
				type: "text",
				text: "### MEMORY CONTEXT\nlarge stable memory",
				providerOptions: cacheControlProviderOptions,
			},
		]);
		expect(result[2]?.content).toEqual([{ type: "text", text: "Message #1" }]);
		expect(result[3]?.content).toEqual([
			{ type: "text", text: "Message #2" },
			{
				type: "file",
				data: "https://cdn.starlight.day/image.jpg",
				mediaType: "image/jpeg",
			},
		]);
		expect(result[4]?.content).toEqual([{ type: "text", text: "Message #3 after media" }]);
	});

	test("does not mark messages for non Gemini 3 Flash models", () => {
		const messages: ModelMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "### MEMORY CONTEXT\nlarge stable memory" }],
			},
		];

		const result = withOpenRouterGeminiCacheControl(messages, OTHER_MODEL);

		expect(result).toEqual(messages);
		expect(result[0]?.content).toEqual([
			{ type: "text", text: "### MEMORY CONTEXT\nlarge stable memory" },
		]);
	});

	test("marks trusted system messages only if they are already part of messages", () => {
		const messages: ModelMessage[] = [
			{ role: "system", content: "stable system prompt" },
			{
				role: "user",
				content: [{ type: "text", text: "### MEMORY CONTEXT\nlarge stable memory" }],
			},
		];

		const result = withOpenRouterGeminiCacheControl(messages, GEMINI_MODEL);

		expect(result[0]).toEqual({
			role: "system",
			content: "stable system prompt",
			providerOptions: cacheControlProviderOptions,
		});
		expect(result[1]?.content).toEqual([
			{
				type: "text",
				text: "### MEMORY CONTEXT\nlarge stable memory",
				providerOptions: cacheControlProviderOptions,
			},
		]);
	});
});
