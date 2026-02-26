export type ExtractionResult =
	| { kind: "markdown"; content: string }
	| { kind: "html"; content: string };

export interface ExtractionFile {
	name: string;
	data: BlobPart;
	type: string;
}

export interface Extractor {
	isEnabled(): boolean;
	extract(url: string): Promise<ExtractionResult | null>;
}
