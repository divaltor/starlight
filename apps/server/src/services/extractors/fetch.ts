import { http } from "@starlight/utils/http";
import type { Extractor, ExtractionResult } from "@/services/extractors/base";

export class FetchExtractor implements Extractor {
	isEnabled(): boolean {
		return true;
	}

	async extract(url: string): Promise<ExtractionResult | null> {
		const response = await http(url, {
			headers: {
				Accept: "text/markdown",
			},
		});

		if (!response.ok) {
			return null;
		}

		const contentType = response.headers.get("content-type");
		const body = await response.text();

		if (contentType?.includes("text/markdown")) {
			return { kind: "markdown", content: body };
		}

		return { kind: "html", content: body };
	}
}
