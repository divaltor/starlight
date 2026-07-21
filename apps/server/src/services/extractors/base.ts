import { Schema } from "effect";

export type ExtractionResult =
	| { kind: "markdown"; content: string }
	| { kind: "html"; content: string };

export type FetchExtractionResult = ExtractionResult | { kind: "unsupported"; contentType: string };

export interface ExtractionFile {
	name: string;
	data: BlobPart;
	type: string;
}

export interface SearchInput {
	query: string;
	maxResults?: number;
}

export interface SearchResult {
	content: string;
	publishedDate?: string | null;
	source: "exa";
	title?: string | null;
	url: string;
}

export class ExtractionError extends Schema.TaggedErrorClass<ExtractionError>()("ExtractionError", {
	extractor: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect),
}) {
	static fromCause(input: { extractor: string; message: string; cause: unknown }) {
		return new ExtractionError({
			extractor: input.extractor,
			message: input.message,
			cause: Schema.Defect.make(input.cause),
		});
	}
}
