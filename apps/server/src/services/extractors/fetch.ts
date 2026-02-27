import { http } from "@starlight/utils/http";
import type { Extractor, ExtractionResult } from "@/services/extractors/base";
import { logger } from "@/logger";

export class FetchExtractor implements Extractor {
	isEnabled(): boolean {
		return true;
	}

	async extract(url: string): Promise<ExtractionResult | null> {
		logger.info("FetchExtractor: Starting extraction for %s", url);

		const response = await http(url, {
			headers: {
				Accept: "text/markdown",
			},
		});

		if (!response.ok) {
			logger.info("FetchExtractor: Failed to fetch %s, status %s", url, response.status);
			return null;
		}

		const contentType = response.headers.get("content-type");
		const body = await response.text();

		if (contentType?.includes("text/markdown")) {
			logger.info(
				"FetchExtractor: Extracted markdown content from %s (%s bytes)",
				url,
				body.length,
			);
			return { kind: "markdown", content: body };
		}

		logger.info("FetchExtractor: Extracted HTML content from %s (%s bytes)", url, body.length);
		return { kind: "html", content: body };
	}
}
