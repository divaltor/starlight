export type ExtractionResult =
	| { kind: "markdown"; content: string }
	| { kind: "html"; content: string };

export interface ExtractionFile {
	name: string;
	data: BlobPart;
	type: string;
}
