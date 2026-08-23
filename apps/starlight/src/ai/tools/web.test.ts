import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createWebLookupTool, extractAllowedUrls } from "@/ai/tools/web";
import type * as Exa from "@/services/exa";

const exa: Exa.Interface = {
	isEnabled: () => true,
	lookup: (url) => Effect.succeed({ content: "allowed page", url }),
	search: () => Effect.succeed([]),
};

test("rejects a model-supplied URL that was not in the live message", async () => {
	const web = createWebLookupTool(exa, new Set(["https://allowed.example/"]));

	expect(await web.execute({ mode: "url", url: "https://other.example/" }, {})).toEqual({
		error: "The selected URL or mode is not allowed",
	});
});

test("reads an allowed URL from the live message", async () => {
	const web = createWebLookupTool(exa, new Set(["https://allowed.example/"]));

	expect(await web.execute({ mode: "url", url: "https://allowed.example" }, {})).toEqual({
		page: { content: "allowed page", url: "https://allowed.example" },
	});
});

test("removes prose punctuation and unmatched delimiters from allowed URLs", () => {
	expect(
		extractAllowedUrls("look at (https://example.com/path). and https://example.org/!"),
	).toEqual(["https://example.com/path", "https://example.org/"]);
});
