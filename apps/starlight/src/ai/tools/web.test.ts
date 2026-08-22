import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { describe, expect, test } from "bun:test";
import { generateText, Output } from "ai";
import { Schema } from "effect";
import { chatResponseSchema } from "@/ai/schema";
import { createWebLookupTool, WEB_LOOKUP_TOOL_ID } from "@/ai/tools/web";

const CapturedOpenRouterRequestFromJson = Schema.fromJsonString(
	Schema.Struct({
		response_format: Schema.optional(Schema.Struct({ type: Schema.String })),
		tools: Schema.optional(
			Schema.Array(
				Schema.Struct({
					function: Schema.Struct({ name: Schema.String }),
					type: Schema.String,
				}),
			),
		),
	}),
);
type CapturedOpenRouterRequest = typeof CapturedOpenRouterRequestFromJson.Type;

describe("createWebLookupTool", () => {
	test("serializes lookup as an application function tool alongside structured output", async () => {
		let requestBody: CapturedOpenRouterRequest | undefined;
		const mockFetch: typeof fetch = Object.assign(
			async (...args: Parameters<typeof fetch>) => {
				const [, init] = args;
				const body = init && "body" in init ? init.body : undefined;
				requestBody = Schema.decodeSync(CapturedOpenRouterRequestFromJson)(String(body));

				const response = Response.json(
					{
						id: "response-id",
						model: "test/model",
						provider: "test",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: '{"replies":[{"type":"ignore"}]}' },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
					{ status: 200, headers: { "content-type": "application/json" } },
				);

				return await Promise.resolve(response);
			},
			{ preconnect: fetch.preconnect },
		);
		const provider = createOpenRouter({
			apiKey: "test",
			fetch: mockFetch,
		});

		await generateText({
			model: provider("test/model"),
			prompt: "test",
			output: Output.object({ schema: chatResponseSchema }),
			tools: { [WEB_LOOKUP_TOOL_ID]: createWebLookupTool([]) },
		});

		expect(requestBody?.tools).toEqual([
			expect.objectContaining({
				type: "function",
				function: expect.objectContaining({ name: WEB_LOOKUP_TOOL_ID }),
			}),
		]);
		expect(requestBody?.response_format).toEqual(expect.objectContaining({ type: "json_schema" }));
	});
});
