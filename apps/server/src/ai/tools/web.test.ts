import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { createOpenRouterWebTools } from "@/ai/tools/web";

describe("createOpenRouterWebTools", () => {
	test("serializes search and fetch as OpenRouter server tools", async () => {
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
								message: { role: "assistant", content: "ok" },
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
			tools: createOpenRouterWebTools(provider),
		});

		expect(requestBody?.tools).toEqual([
			{
				type: "openrouter:web_search",
				engine: "exa",
				max_results: 3,
			},
			{
				type: "openrouter:web_fetch",
				parameters: {
					engine: "exa",
					max_content_tokens: 6_000,
					max_uses: 1,
				},
			},
		]);
	});
});
