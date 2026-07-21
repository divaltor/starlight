import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { describe, expect, test } from "bun:test";
import { generateText, Output } from "ai";
import { chatResponseSchema } from "@/ai/schema";
import { createWebLookupTool, WEB_LOOKUP_TOOL_ID } from "@/ai/tools/web";

describe("createWebLookupTool", () => {
	test("serializes lookup as an application function tool alongside structured output", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const mockFetch: typeof fetch = Object.assign(
			async (...args: Parameters<typeof fetch>) => {
				const init = args[1];
				const body = init && "body" in init ? init.body : undefined;
				requestBody = JSON.parse(String(body)) as Record<string, unknown>;

				return new Response(
					JSON.stringify({
						id: "response-id",
						model: "test/model",
						provider: "test",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: '{"replies":[]}' },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
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
