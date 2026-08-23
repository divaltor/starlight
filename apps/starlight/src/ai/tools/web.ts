import { Effect } from "effect";
import { z } from "zod";
import type * as Model from "@/ai/model";
import type * as Exa from "@/services/exa";

export const WEB_LOOKUP_TOOL_ID = "web_lookup";

const MAX_PAGE_LENGTH = 6000;
const MAX_RESULT_LENGTH = 2000;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const inputSchema = z.object({
	mode: z.enum(["url", "search"]),
	query: z.string().min(3).max(300).optional(),
	url: z.url().optional(),
});

export function createWebLookupTool(
	exa: Exa.Interface,
	allowedUrls: ReadonlySet<string>,
): Model.Tool {
	return {
		description:
			'Access the web. Use mode="url" only for an allowed URL. Use mode="search" only for current facts needed to answer.',
		execute: async (rawInput, execution) => {
			const input = inputSchema.parse(rawInput);
			const normalizedUrl = input.url ? new URL(input.url).toString() : null;
			if (input.mode === "url" && normalizedUrl && allowedUrls.has(normalizedUrl)) {
				const page = await Effect.runPromise(exa.lookup(input.url), {
					signal: execution.signal,
				});
				return {
					page: page ? { ...page, content: page.content.slice(0, MAX_PAGE_LENGTH) } : null,
				};
			}

			if (input.mode === "search" && input.query) {
				const results = await Effect.runPromise(exa.search(input.query), {
					signal: execution.signal,
				});
				return {
					results: results.map((result) => ({
						...result,
						content: result.content.slice(0, MAX_RESULT_LENGTH),
					})),
				};
			}

			return { error: "The selected URL or mode is not allowed" };
		},
		inputSchema,
		name: WEB_LOOKUP_TOOL_ID,
	};
}

export function extractAllowedUrls(text: string): string[] {
	return (text.match(URL_PATTERN) ?? []).flatMap((candidate) => {
		const value = trimUrlCandidate(candidate);
		return URL.canParse(value) ? [new URL(value).toString()] : [];
	});
}

function trimUrlCandidate(candidate: string): string {
	return trimUnmatchedClosing(
		trimUnmatchedClosing(
			trimUnmatchedClosing(candidate.replace(/[.,!?;:]+$/u, ""), "(", ")"),
			"[",
			"]",
		),
		"{",
		"}",
	);
}

function trimUnmatchedClosing(value: string, opening: string, closing: string): string {
	const unmatched = countCharacter(value, closing) - countCharacter(value, opening);
	return unmatched > 0 && value.endsWith(closing) ? value.slice(0, -unmatched) : value;
}

function countCharacter(value: string, character: string): number {
	return value.split(character).length - 1;
}
